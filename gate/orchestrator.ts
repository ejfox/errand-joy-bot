// The gate's brain. Everything is injected (wiring.ts builds the real deps; tests use the fakes at
// the bottom of this file); the ports below name exactly what this file needs.
//
// Fail-closed invariants:
//  - nothing NON-SILENT reaches `placing` without a delivered DM (dmMessageId) AND a stored approval
//    record. Silent rows (auto tier, reach self/world, quoted total < notice.silentBelowCents) skip
//    the DM by design; caps, velocity, STOP, REACH and the ledger still apply, and the delivery
//    why-note DM is required before they close;
//  - a fresh quote, a binding check and a fresh decide() run immediately before every placement;
//  - plaintext approval tokens exist only inside sendDm(), and leave it only in the DM text;
//  - decide() and the transition that makes a request's money count run under one lock, so
//    concurrent requests can't all pass the same window check.
import {
  AUTO_CANCEL_WINDOW_MS,
  APPROVAL_TTL_MS,
  type ApprovalRecord,
  DEFAULT_NOTICE,
  DM_DOWN_STOP_MS,
  FUND_VETO_WINDOW_MS,
  type FundKind,
  HINT_MAX_CHARS,
  IdempotencyConflict,
  IllegalTransition,
  type Item,
  ITEM_AOI_MAX,
  ITEM_ATTRIBUTES_MAX,
  ITEM_MESSAGE_MAX,
  ITEM_PAGE_COUNT_MAX,
  MIN_REASON_CHARS,
  type Notifier,
  type NoticePolicy,
  OWNER_HOME,
  type PolicyInput,
  type PolicyResult,
  type PurchaseRequest,
  type Quote,
  type Reach,
  REACH_RANK,
  type RelayClient,
  type RequestRow,
  type ShipTo,
  type State,
  StopActive,
  type Verdict,
  type VendorAdapter,
  type WindowUsage,
} from "./types.ts";
import { assertTransition as stateAssert, needsWhyNote, TRANSITIONS } from "./state.ts";
import { decide as policyDecide } from "./policy.ts";
import { GuardRefused } from "./adapters/registry.ts";
import { RelayAlreadyDecided } from "./relay_client.ts";
import { approvalUrl, buildApprovalRecord, relayPublicUrl, verifyApproveToken, verifyBinding } from "./approval.ts";
import {
  approvalDm,
  clean,
  deliveredWhyNoteDm,
  fmtCents,
  fundVetoDm,
  type HealthAlerter,
  type Headroom,
  needsActionDm,
  safeLinks,
  sealedHint,
  vendorLabel,
  gateTimezone,
  inQuietHours as quietAt,
  quietHoursConfig,
  type QuietHoursConfig,
  stopDm,
  vetoDm,
} from "./notify.ts";

type Awaitable<T> = T | Promise<T>;

/** What the relay page shows as the vendor for joy purchases (sealed envelope). */
export const SEALED_VENDOR = "sealed";

export const DM_DOWN_ALERT_MS = 2 * 3600_000;
const VERDICT_CURSOR_KEY = "relay_verdict_cursor";
const VERDICT_OVERLAP_MS = 5 * 60_000; // re-pull a little; consumeApproval() dedupes
const DM_DOWN_KEY = "dm_down_since";

/** Kept as an alias: RequestRow now carries shipTo and category itself. */
export type GateRow = RequestRow;

// ── Ports (wiring.ts maps policy.ts / state.ts / the SQLite ledger onto these) ──
export interface LedgerPort {
  /** Idempotent insert in state `received`. Same key + different payloadHash → throw IdempotencyConflict. */
  insertRequest(req: PurchaseRequest, payloadHash: string, now: Date): Awaitable<{ row: GateRow; created: boolean }>;
  getRequest(id: string): Awaitable<GateRow | undefined>;
  listByState(state: State): Awaitable<GateRow[]>;
  /** Non-state fields only. */
  updateRequest(id: string, patch: Partial<GateRow>): Awaitable<GateRow>;
  /**
   * Compare-and-set state change + `events` row. Throws IllegalTransition if the row is not in `from`.
   * `ctx` is the state-machine context the orchestrator already checked; a real ledger re-runs
   * state.ts assertTransition with it (re-reading STOP) inside its own transaction.
   */
  transition(
    id: string,
    from: State,
    to: State,
    patch?: Partial<GateRow>,
    note?: string,
    ctx?: TransitionCtx,
  ): Awaitable<GateRow>;
  /** ISO time of the latest event that moved this request INTO `state` (from the events table). */
  stateEnteredAt(id: string, state: State): Awaitable<string | undefined>;
  /** Window sums per CONTRACT; `excludeRequestId` drops that request's own in-flight amount (re-decide). */
  windowsFor(vendor: string, budget: "general" | "joy", now: Date, excludeRequestId?: string): Awaitable<Record<string, WindowUsage>>;
  /** SUM(fund_entries); `excludeHoldFor` adds back that request's own hold (re-decide). */
  fundBalance(excludeHoldFor?: string): Awaitable<number>;
  addFundEntry(e: { kind: FundKind; cents: number; requestId?: string; note?: string }, now: Date): Awaitable<void>;
  requestsLast10m(now: Date): Awaitable<number>;
  isStopped(): Awaitable<boolean>;
  setStop(on: boolean, reason?: string): Awaitable<void>;
  upsertApproval(a: ApprovalRecord): Awaitable<void>;
  getApproval(approvalId: string): Awaitable<ApprovalRecord | undefined>;
  getApprovalForRequest(requestId: string): Awaitable<ApprovalRecord | undefined>;
  /** Atomic `UPDATE approvals SET used_at, verdict WHERE approval_id=? AND used_at IS NULL`; true if this call won. */
  consumeApproval(approvalId: string, verdict: "approve" | "deny", atISO: string): Awaitable<boolean>;
  getSetting(key: string): Awaitable<string | undefined>;
  setSetting(key: string, value: string | null): Awaitable<void>;
  /**
   * Admin: record an order placed outside the gate, directly in `placed` (counts in windows,
   * reconcile matches it). Idempotent on vendor + vendorOrderId. Optional: the SQLite ledger has it.
   */
  importOrder?(o: { vendor: string; vendorOrderId: string; cents: number; note: string }): Awaitable<{ row: GateRow; created: boolean }>;
}

export interface PolicyPort {
  decide(input: PolicyInput): PolicyResult;
}
export interface StatePort {
  /** Throws IllegalTransition / StopActive (WP1 state.ts). */
  assertTransition(from: State, to: State, ctx: TransitionCtx): void;
}
/** Same shape as WP1 state.ts TransitionCtx, so its assertTransition plugs in directly. */
export interface TransitionCtx {
  stopped: boolean;
  messageId?: string; // dm_pending → dm_delivered
  whyNoteDelivered?: boolean; // delivered → closed
  budget?: "general" | "joy";
  redecide?: PolicyResult; // approved → placing
  silent?: boolean; // the row's persisted flag: decided → approved; placing without a DM
  sealed?: boolean; // the row's persisted flag: delivered → closed needs the why-note
}
export interface Clock {
  now(): Date;
}

export interface OrchestratorDeps {
  ledger: LedgerPort;
  policy: PolicyPort;
  state: StatePort;
  adapters: Record<string, VendorAdapter>;
  notifier: Notifier;
  relay: RelayClient;
  clock: Clock;
  alerter?: HealthAlerter;
  /** Structured log sink. Receives ids, states and reason codes only — never tokens or DM text. */
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Public relay origin for approval links; defaults to env RELAY_PUBLIC_URL (missing → DMs fail closed). */
  relayPublicUrl?: string;
  /** From config.toml (config.ts); defaults to the types.ts window. */
  quietHours?: QuietHoursConfig;
  /** From config.toml [windows]; defaults to the types.ts constants. */
  timing?: Partial<Timing>;
  /** Intake refuses a `reason` shorter than this. Default MIN_REASON_CHARS. */
  minReasonChars?: number;
  /** The shipTo string agents use for the owner's address (config owner_home_label). Default OWNER_HOME. */
  ownerHomeLabel?: string;
  /** From config.toml [notify]: silent tier ceiling and sealed DMs. Default types.ts DEFAULT_NOTICE. */
  notice?: Partial<NoticePolicy>;
}

export interface Timing {
  autoCancelWindowMs: number;
  fundVetoWindowMs: number;
  approvalTtlMs: number;
}

export const DEFAULT_TIMING: Timing = {
  autoCancelWindowMs: AUTO_CANCEL_WINDOW_MS,
  fundVetoWindowMs: FUND_VETO_WINDOW_MS,
  approvalTtlMs: APPROVAL_TTL_MS,
};

export class ValidationError extends Error {}
export class QuoteError extends Error {}

export interface TickReport {
  stopped: boolean;
  dmsSent: number;
  dmFailures: number;
  quietHours: boolean;
  verdictsApplied: number;
  placed: number;
  denied: number;
  expired: number;
  closed: number;
  errors: number;
}

// ── Validation & helpers ──────────────────────────────────────────────────
const ID_RE = /^[A-Za-z0-9._:\-]{1,128}$/;

function hasControlChars(v: unknown, depth = 0): boolean {
  if (depth > 6) return true;
  // deno-lint-ignore no-control-regex -- matching control characters is the point
  if (typeof v === "string") return /[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/.test(v);
  if (Array.isArray(v)) return v.some((x) => hasControlChars(x, depth + 1));
  if (v && typeof v === "object") return Object.values(v).some((x) => hasControlChars(x, depth + 1));
  return false;
}

/** An agent-supplied URL field: https, ≤ 2000 chars, no whitespace, no userinfo (`@`). */
function isHttpsField(v: unknown): v is string {
  return typeof v === "string" && v.length <= 2000 && /^https:\/\/[^\s@]+$/.test(v);
}

export function validateRequest(
  x: unknown,
  minReasonChars: number = MIN_REASON_CHARS,
  ownerHomeLabel: string = OWNER_HOME,
): PurchaseRequest {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new ValidationError("body must be an object");
  const r = x as Record<string, unknown>;
  // Control characters anywhere in agent text would jam the relay publish (and DM path) forever.
  if (hasControlChars(r)) throw new ValidationError("control characters not allowed");
  const str = (k: string, max: number) => {
    const v = r[k];
    if (typeof v !== "string" || v.length === 0 || v.length > max) throw new ValidationError(`${k} invalid`);
    return v;
  };
  const idempotencyKey = str("idempotencyKey", 128);
  if (!ID_RE.test(idempotencyKey)) throw new ValidationError("idempotencyKey invalid");
  const requester = str("requester", 64);
  const taskId = str("taskId", 128);
  const vendor = str("vendor", 64);
  const reason = str("reason", 1000);
  if (reason.trim().length < minReasonChars) {
    throw new ValidationError(
      `reason too short: explain why this purchase is needed in at least ${minReasonChars} characters`,
    );
  }
  if (r.whyNote !== undefined && (typeof r.whyNote !== "string" || r.whyNote.length === 0 || r.whyNote.length > 500)) {
    throw new ValidationError("whyNote invalid (1-500 chars)");
  }
  const reach = r.reach;
  if (reach !== "self" && reach !== "world" && reach !== "others") throw new ValidationError("reach invalid");
  const maxTotalCents = r.maxTotalCents;
  if (!Number.isSafeInteger(maxTotalCents) || (maxTotalCents as number) <= 0) {
    throw new ValidationError("maxTotalCents invalid");
  }
  const budget = r.budget ?? "general";
  if (budget !== "general" && budget !== "joy") throw new ValidationError("budget invalid");
  if (r.category !== undefined && (typeof r.category !== "string" || r.category.length > 64)) {
    throw new ValidationError("category invalid");
  }
  if (!Array.isArray(r.items) || r.items.length === 0 || r.items.length > 50) throw new ValidationError("items invalid");
  const items = r.items.map((it: unknown) => {
    if (!it || typeof it !== "object") throw new ValidationError("item invalid");
    const i = it as Record<string, unknown>;
    if (typeof i.sku !== "string" || !i.sku || i.sku.length > 128) throw new ValidationError("item.sku invalid");
    if (!Number.isSafeInteger(i.qty) || (i.qty as number) < 1 || (i.qty as number) > 1000) {
      throw new ValidationError("item.qty invalid");
    }
    if (i.title !== undefined && (typeof i.title !== "string" || i.title.length > 300)) {
      throw new ValidationError("item.title invalid");
    }
    if (i.url !== undefined && !isHttpsField(i.url)) {
      throw new ValidationError("item.url must be https");
    }
    if (i.maxUnitCents !== undefined && (!Number.isSafeInteger(i.maxUnitCents) || (i.maxUnitCents as number) < 0)) {
      throw new ValidationError("item.maxUnitCents invalid");
    }
    if (i.message !== undefined && (typeof i.message !== "string" || !i.message.trim() || i.message.length > ITEM_MESSAGE_MAX)) {
      throw new ValidationError(`item.message invalid (1-${ITEM_MESSAGE_MAX} chars)`);
    }
    let files: Item["files"];
    if (i.files !== undefined) {
      if (!i.files || typeof i.files !== "object" || Array.isArray(i.files)) throw new ValidationError("item.files invalid");
      const f = i.files as Record<string, unknown>;
      if (Object.keys(f).some((k) => k !== "interior" && k !== "cover")) throw new ValidationError("item.files: only interior, cover");
      files = {};
      for (const k of ["interior", "cover"] as const) {
        if (f[k] === undefined) continue;
        if (!isHttpsField(f[k])) throw new ValidationError(`item.files.${k} must be https`);
        files[k] = f[k] as string;
      }
    }
    if (
      i.pageCount !== undefined &&
      (!Number.isSafeInteger(i.pageCount) || (i.pageCount as number) < 1 || (i.pageCount as number) > ITEM_PAGE_COUNT_MAX)
    ) {
      throw new ValidationError(`item.pageCount invalid (1-${ITEM_PAGE_COUNT_MAX})`);
    }
    if (i.sizing !== undefined && (typeof i.sizing !== "string" || !/^[A-Za-z]{1,40}$/.test(i.sizing))) {
      throw new ValidationError("item.sizing invalid");
    }
    if (i.attributes !== undefined) {
      const a = i.attributes;
      const ok = !!a && typeof a === "object" && !Array.isArray(a) &&
        Object.keys(a).length <= ITEM_ATTRIBUTES_MAX &&
        Object.entries(a).every(([k, v]) => /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k) && typeof v === "string" && v.length <= 80);
      if (!ok) throw new ValidationError(`item.attributes invalid (≤ ${ITEM_ATTRIBUTES_MAX} keys, string values ≤ 80 chars)`);
    }
    if (i.aoi !== undefined && (typeof i.aoi !== "string" || !i.aoi.trim() || i.aoi.length > ITEM_AOI_MAX)) {
      throw new ValidationError(`item.aoi invalid (1-${ITEM_AOI_MAX} chars of WKT)`);
    }
    return {
      sku: i.sku,
      qty: i.qty as number,
      ...(i.title !== undefined ? { title: i.title as string } : {}),
      ...(i.url !== undefined ? { url: i.url as string } : {}),
      ...(i.maxUnitCents !== undefined ? { maxUnitCents: i.maxUnitCents as number } : {}),
      ...(i.message !== undefined ? { message: i.message as string } : {}),
      ...(files !== undefined ? { files } : {}),
      ...(i.pageCount !== undefined ? { pageCount: i.pageCount as number } : {}),
      ...(i.sizing !== undefined ? { sizing: i.sizing as string } : {}),
      ...(i.attributes !== undefined ? { attributes: { ...(i.attributes as Record<string, string>) } } : {}),
      ...(i.aoi !== undefined ? { aoi: i.aoi as string } : {}),
    };
  });
  let hint: string | undefined;
  if (r.hint !== undefined) {
    if (typeof r.hint !== "string" || r.hint.trim().length === 0 || r.hint.length > HINT_MAX_CHARS) {
      throw new ValidationError(`hint invalid (1-${HINT_MAX_CHARS} chars)`);
    }
    const leaked = hintLeaks(r.hint, items);
    if (leaked) throw new ValidationError(`hint must not reveal the item (it contains "${leaked}" from the item title)`);
    hint = r.hint;
  }
  let shipTo: ShipTo | undefined;
  if (r.shipTo !== undefined) {
    // The configured label (config owner_home_label) is normalised to the one internal literal.
    if (r.shipTo === ownerHomeLabel || r.shipTo === OWNER_HOME) shipTo = OWNER_HOME;
    else if (r.shipTo && typeof r.shipTo === "object") {
      const s = r.shipTo as Record<string, unknown>;
      for (const k of ["name", "line1", "city", "state", "zip"]) {
        if (typeof s[k] !== "string" || !(s[k] as string) || (s[k] as string).length > 200) {
          throw new ValidationError(`shipTo.${k} invalid`);
        }
      }
      if (s.phone !== undefined && (typeof s.phone !== "string" || !/^[0-9+().\- ]{4,40}$/.test(s.phone))) {
        throw new ValidationError("shipTo.phone invalid");
      }
      shipTo = {
        name: s.name as string, line1: s.line1 as string, city: s.city as string, state: s.state as string, zip: s.zip as string,
        ...(s.phone !== undefined ? { phone: s.phone as string } : {}),
      };
    } else throw new ValidationError("shipTo invalid");
  }
  return {
    idempotencyKey, requester, taskId, vendor, items, reason, reach, maxTotalCents: maxTotalCents as number,
    budget, ...(r.category !== undefined ? { category: r.category as string } : {}), ...(shipTo ? { shipTo } : {}),
    ...(r.whyNote !== undefined ? { whyNote: r.whyNote as string } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

/**
 * A sealed hint must not leak the item: returns the first item-title word of 4+ letters (or a SKU
 * of 4+ chars) that appears anywhere in the hint, case-insensitive, else undefined.
 */
export function hintLeaks(hint: string, items: { sku: string; title?: string }[]): string | undefined {
  const h = hint.toLowerCase();
  for (const it of items) {
    for (const w of (it.title ?? "").toLowerCase().split(/[^\p{L}]+/u)) {
      if (w.length >= 4 && h.includes(w)) return w;
    }
    const sku = it.sku.toLowerCase();
    if (sku.length >= 4 && h.includes(sku)) return it.sku;
  }
  return undefined;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export async function payloadHash(req: PurchaseRequest): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(req)));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function rowToRequest(row: GateRow): PurchaseRequest {
  return {
    idempotencyKey: row.idempotencyKey,
    requester: row.requester,
    taskId: row.taskId,
    vendor: row.vendor,
    items: row.items,
    reason: row.reason,
    reach: row.reachDeclared,
    maxTotalCents: row.maxTotalCents,
    budget: row.budget,
    ...(row.category ? { category: row.category } : {}),
    ...(row.shipTo ? { shipTo: row.shipTo } : {}),
    ...(row.whyNote ? { whyNote: row.whyNote } : {}),
    ...(row.hint ? { hint: row.hint } : {}),
  };
}

function quoteProblem(q: Quote | undefined): string | undefined {
  if (!q || typeof q !== "object") return "bad_quote";
  const ints = [q.subtotalCents, q.taxCents, q.shippingCents, q.totalCents];
  if (!ints.every((n) => Number.isSafeInteger(n) && n >= 0)) return "bad_quote";
  if (q.currency !== "USD") return "bad_quote_currency";
  const fee = q.feeCents ?? 0;
  if (!Number.isSafeInteger(fee) || fee < 0) return "bad_quote";
  if (q.subtotalCents + q.taxCents + q.shippingCents + fee !== q.totalCents) return "bad_quote_sum";
  return undefined;
}

function maxReach(a: Reach, b: Reach): Reach {
  return REACH_RANK[a] >= REACH_RANK[b] ? a : b;
}

/** Most delivery links kept on a row. */
const MAX_ROW_LINKS = 5;

/**
 * The two things the gate reads from a vendor payload (Order.raw on place(), status().raw on each
 * poll): `links` (sanitized, merged with the row's, deduped) and `blocked` (a short code: the order
 * waits on the owner at the vendor). Returns only the fields that CHANGE, so an unchanged poll
 * writes nothing. The raw payload itself is never stored (it can carry vendor URLs with keys).
 */
export function vendorSignals(
  raw: unknown,
  row: Pick<GateRow, "links" | "needsAction">,
): Partial<Pick<GateRow, "links" | "needsAction">> {
  const out: Partial<Pick<GateRow, "links" | "needsAction">> = {};
  const fresh = safeLinks(raw, MAX_ROW_LINKS);
  const have = row.links ?? [];
  const merged = [...have, ...fresh.filter((l) => !have.includes(l))].slice(0, MAX_ROW_LINKS);
  if (merged.length !== have.length) out.links = merged;
  const blocked = raw && typeof raw === "object" ? (raw as { blocked?: unknown }).blocked : undefined;
  const code = typeof blocked === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(blocked) ? blocked : undefined;
  if (code !== row.needsAction) out.needsAction = code; // cleared once the vendor stops reporting it
  return out;
}

/**
 * Silent / sealed, decided once from the policy result and stored on the row:
 *  - silent: auto decision in the auto tier, reach self/world, quoted total < silentBelowCents
 *    (joy included). No pre-order DM, no approval record.
 *  - sealed: joy (always), or [notify] sealed with an ask / fund_auto decision at reach self/world.
 *    The DM and relay summary show amount, headroom, vendor category and hint, never the item.
 * Reach "others" is never silent and never sealed: the owner always sees item, recipient and reason.
 */
export function noticeFor(
  result: Pick<PolicyResult, "decision" | "tier" | "effectiveReach">,
  totalCents: number,
  budget: "general" | "joy",
  notice: NoticePolicy = DEFAULT_NOTICE,
): { silent: boolean; sealed: boolean } {
  if (result.decision === "deny" || result.effectiveReach === "others") return { silent: false, sealed: false };
  const silent = result.decision === "auto" && result.tier === "auto" && totalCents < notice.silentBelowCents;
  if (silent) return { silent: true, sealed: false };
  const sealed = budget === "joy" || (notice.sealed && (result.decision === "ask" || result.tier === "fund_auto"));
  return { silent: false, sealed };
}

/**
 * Text the relay page renders. Joy and sealed summaries are a sealed envelope: amount, vendor
 * category and the agent's hint only, never the item, URL, SKU or reason.
 */
export function approvalSummary(row: GateRow, totalCents: number): string {
  if (row.budget === "joy") {
    return `robot spent ${fmtCents(totalCents)} on something this week${row.hint ? ` (hint: ${sealedHint(row)})` : ""}`;
  }
  if (row.sealed) return `sealed · ${fmtCents(totalCents)} · ${vendorLabel(row.vendor)} · hint: ${sealedHint(row)}`;
  const items = row.items.map((i) => `${i.qty}× ${clean(i.title || i.sku, 60)}`).join(", ").slice(0, 300);
  return `${clean(row.requester, 40)} · ${fmtCents(totalCents)} · ${items} · ${clean(row.reason, 200)}`.slice(0, 600);
}

// ── Orchestrator ──────────────────────────────────────────────────────────
export class Orchestrator {
  private readonly qh: QuietHoursConfig;
  private readonly t: Timing;
  private readonly minReason: number;
  private readonly notice: NoticePolicy;
  constructor(private readonly d: OrchestratorDeps) {
    this.qh = d.quietHours ?? quietHoursConfig();
    this.t = { ...DEFAULT_TIMING, ...(d.timing ?? {}) };
    this.minReason = d.minReasonChars ?? MIN_REASON_CHARS;
    this.notice = { ...DEFAULT_NOTICE, ...(d.notice ?? {}) };
  }

  // One async lock around every "read the windows → decide → make the money count" section
  // (intake and the pre-place re-decide), so N concurrent requests are judged one after another.
  private moneyChain: Promise<unknown> = Promise.resolve();
  private withMoneyLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.moneyChain.then(fn, fn);
    this.moneyChain = run.catch(() => {});
    return run;
  }

  private quiet(now: Date): boolean {
    return quietAt(now, this.qh);
  }

  private log(event: string, data?: Record<string, unknown>) {
    try {
      this.d.log?.(event, data);
    } catch { /* logging never breaks the gate */ }
  }

  private async move(
    row: GateRow,
    to: State,
    patch?: Partial<GateRow>,
    note?: string,
    extra: Partial<TransitionCtx> = {},
  ): Promise<GateRow> {
    const stopped = await this.d.ledger.isStopped();
    const ctx: TransitionCtx = {
      stopped,
      budget: row.budget,
      messageId: patch?.dmMessageId ?? row.dmMessageId,
      silent: patch?.silent ?? row.silent,
      sealed: patch?.sealed ?? row.sealed,
      ...extra,
    };
    this.d.state.assertTransition(row.state, to, ctx);
    const next = await this.d.ledger.transition(row.id, row.state, to, patch, note, ctx);
    this.log("transition", { id: row.id, from: row.state, to, note });
    return next;
  }

  private async releaseHold(row: GateRow, now: Date) {
    if (row.tier !== "fund_auto") return;
    const held = row.quote?.totalCents ?? 0;
    if (held > 0) await this.d.ledger.addFundEntry({ kind: "release", cents: held, requestId: row.id }, now);
  }

  /** Move to a terminal no-money state, releasing any fund hold. */
  private async close(row: GateRow, to: "denied" | "cancelled" | "expired" | "failed", reasons: string[], now: Date) {
    const next = await this.move(row, to, { reasons: [...(row.reasons ?? []), ...reasons] }, reasons.join(","));
    await this.releaseHold(row, now);
    return next;
  }

  // ── intake ──
  async submit(input: unknown): Promise<GateRow> {
    const req = validateRequest(input, this.minReason, this.d.ownerHomeLabel ?? OWNER_HOME);
    const { ledger, clock } = this.d;
    if (await ledger.isStopped()) throw new StopActive("STOP is active");
    const adapter = Object.hasOwn(this.d.adapters, req.vendor) ? this.d.adapters[req.vendor] : undefined;
    if (!adapter) throw new ValidationError("unknown_vendor");

    const now = clock.now();
    let inserted: { row: GateRow; created: boolean };
    try {
      inserted = await ledger.insertRequest(req, await payloadHash(req), now);
    } catch (err) {
      if (err instanceof IdempotencyConflict) {
        await this.stop("idempotency_conflict");
        throw err;
      }
      throw err;
    }
    let row = inserted.row;
    if (!inserted.created) return row;

    let quote: Quote;
    try {
      quote = await adapter.quote(req);
    } catch (err) {
      this.log("quote_failed", { id: row.id, error: err instanceof Error ? err.name : "error" });
      await this.move(row, "failed", { reasons: ["quote_failed"] }, "quote_failed");
      throw new QuoteError("vendor quote failed");
    }
    row = await this.move(row, "quoted", { quote });

    // A malformed quote, or one over the agent's own ceiling, is denied before policy runs.
    const qp = quoteProblem(quote) ?? (quote.totalCents > req.maxTotalCents ? "over_agent_max" : undefined);
    if (qp) return await this.move(row, "denied", { decision: "deny", reasons: [qp] }, qp);

    // Judge and commit under the money lock: once this row is in dm_pending its amount counts in
    // every window, so the next request (waiting on the lock) sees it.
    let tripStop = false;
    row = await this.withMoneyLock(async () => {
      const adapterReach = adapter.reachFor(req);
      const budget = req.budget ?? "general";
      let result = this.d.policy.decide({
        totalCents: quote.totalCents,
        vendor: req.vendor,
        reach: req.reach,
        adapterReach,
        budget,
        fundBalanceCents: await ledger.fundBalance(),
        windows: await ledger.windowsFor(req.vendor, budget, this.d.clock.now(), row.id),
        requestsLast10m: await ledger.requestsLast10m(now),
        stopped: await ledger.isStopped(),
        vendorAllowed: Object.hasOwn(this.d.adapters, req.vendor),
      });
      // Never trust a policy result that lowers reach.
      result = { ...result, effectiveReach: maxReach(result.effectiveReach, maxReach(req.reach, adapterReach)) };
      if (result.effectiveReach === "others" && result.decision === "auto") result = { ...result, decision: "ask" };
      const decision = result.tripStop ? "deny" : result.decision;
      const { silent, sealed } = noticeFor({ ...result, decision }, quote.totalCents, budget, this.notice);
      let r = await this.move(row, "decided", {
        tier: result.tier,
        decision,
        reasons: silent ? [...result.reasons, "silent"] : result.reasons,
        reachEffective: result.effectiveReach,
        silent,
        sealed,
      });
      if (decision === "deny" || (await ledger.isStopped())) {
        tripStop = Boolean(result.tripStop);
        return await this.move(r, "denied", {}, "decide_deny");
      }
      if (r.tier === "fund_auto") {
        await ledger.addFundEntry({ kind: "hold", cents: -quote.totalCents, requestId: r.id }, now);
      }
      // Silent tier: no DM, no cancel window. approved still counts in every window, and tick
      // places it only after a fresh quote and a re-decide under this same lock.
      r = silent ? await this.move(r, "approved", {}, "silent") : await this.move(r, "dm_pending");
      return r;
    });
    if (row.state === "denied") {
      // Trip STOP only after the row is safely denied (decided is not reachable under STOP).
      if (tripStop) await this.stop("velocity");
      return row;
    }
    if (row.silent) return row;
    try {
      await this.sendDm(row, now);
    } catch (err) {
      this.log("dm_error", { id: row.id, error: err instanceof Error ? err.name : "error" });
    }
    return (await ledger.getRequest(row.id)) ?? row;
  }

  // ── DM + approval record (the only place a plaintext token exists) ──
  private readonly sending = new Set<string>();

  private async sendDm(row: GateRow, now: Date): Promise<"sent" | "quiet" | "failed" | "busy"> {
    if (this.sending.has(row.id)) return "busy"; // submit() and tick() never DM the same row twice at once
    this.sending.add(row.id);
    try {
      // Re-read under the slot: tick's list may be stale (submit() may have just delivered this
      // row's DM). Re-minting would overwrite the relay record and kill the first DM's links.
      const fresh = await this.d.ledger.getRequest(row.id);
      if (!fresh || fresh.state !== "dm_pending") return "busy";
      return await this.sendDmOnce(fresh, now);
    } finally {
      this.sending.delete(row.id);
    }
  }

  private async sendDmOnce(row: GateRow, now: Date): Promise<"sent" | "quiet" | "failed"> {
    const { ledger } = this.d;
    if (row.state !== "dm_pending" || !row.quote) return "failed";
    if (await ledger.isStopped()) return "failed";
    if (this.quiet(now)) return "quiet";

    const total = row.quote.totalCents;
    const asks = row.decision === "ask";
    const kind = asks ? "approve" : "veto";
    const existing = await ledger.getApprovalForRequest(row.id);
    const minted = await buildApprovalRecord({
      requestId: row.id,
      vendor: row.vendor,
      boundCents: total,
      kind,
      summary: approvalSummary(row, total),
      now,
      approvalId: existing?.approvalId,
      ttlMs: this.t.approvalTtlMs,
    });
    const record = minted.record;
    // Ask DMs show the cap headroom left if the owner approves (caps are absolute). Sealed fund DMs
    // show today's / this month's headroom too (fund purchases don't count against the caps).
    let headroom: Headroom | undefined;
    let fundAfterCents: number | undefined;
    if ((asks && row.tier !== "fund_auto") || (row.sealed && row.tier === "fund_auto")) {
      const w = await ledger.windowsFor(row.vendor, row.budget, now, row.id);
      const counted = row.tier === "fund_auto" ? 0 : total;
      const left = (k: string) => w[k] ? Math.max(0, w[k].capCents - w[k].spentCents - counted) : 0;
      headroom = { dayCents: left("global/day"), monthCents: left("global/month") };
    }
    if (row.sealed && row.tier === "fund_auto") fundAfterCents = Math.max(0, await ledger.fundBalance());
    let text: string;
    {
      let denyUrl: string, approveUrl = "";
      try {
        const base = this.d.relayPublicUrl ?? relayPublicUrl();
        denyUrl = approvalUrl(record.denyLookupId, minted.denyToken, base);
        if (asks) approveUrl = approvalUrl(record.approveLookupId!, minted.approveToken!, base);
      } catch {
        minted.denyToken = "";
        minted.approveToken = undefined;
        await this.dmFailed(row, "relay_url_unconfigured", now);
        return "failed";
      }
      minted.denyToken = "";
      minted.approveToken = undefined;
      const sealed = row.sealed === true && row.reachEffective !== "others"; // belt and braces: others is never sealed
      text = asks
        ? approvalDm(row, row.quote, approveUrl, denyUrl, { ttlHours: this.t.approvalTtlMs / 3600_000, headroom, sealed })
        : row.tier === "fund_auto"
        ? fundVetoDm(row, row.quote, denyUrl, this.t.fundVetoWindowMs / 60_000, { sealed, headroom, fundAfterCents })
        : vetoDm(row, row.quote, denyUrl, { joy: row.budget === "joy", windowMin: this.t.autoCancelWindowMs / 60_000 });
    }

    // Publish first: a delivered DM must always point at a live record. If the DM then fails, the
    // published hash is orphaned and harmless (its token was never revealed).
    try {
      // Joy / sealed: the public page must not reveal the vendor either (the summary carries the
      // vendor category). Binding is checked against the local record (real vendor), so masking the
      // published copy changes nothing on the gate side.
      await this.d.relay.publish(row.budget === "joy" || row.sealed ? { ...record, vendor: SEALED_VENDOR } : record);
    } catch (err) {
      if (err instanceof RelayAlreadyDecided) {
        // The owner already tapped a link from an earlier DM we thought had failed. We can't know which
        // way from here (the verdict pull settles it), so fail closed: never send a DM whose links the
        // relay rejected, and cancel the request.
        await this.close(row, "cancelled", ["relay_already_decided"], now);
        return "failed";
      }
      await this.dmFailed(row, "relay_publish", now);
      return "failed";
    }
    await ledger.upsertApproval(record);

    let res;
    try {
      res = await this.d.notifier.send(text);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.name : "send_error" };
    }
    text = "";
    if (!res.ok || !res.messageId) {
      await this.dmFailed(row, res.error ?? "no_message_id", now);
      return "failed";
    }
    let next = await this.move(row, "dm_delivered", {
      dmMessageId: res.messageId,
      dmAttempts: row.dmAttempts + 1,
      dmLastError: undefined,
    });
    await ledger.setSetting(DM_DOWN_KEY, null);
    if (next.decision === "ask") next = await this.move(next, "pending_approval");
    return "sent";
  }

  private async dmFailed(row: GateRow, error: string, now: Date) {
    await this.d.ledger.updateRequest(row.id, { dmAttempts: row.dmAttempts + 1, dmLastError: error.slice(0, 80) });
    if (!(await this.d.ledger.getSetting(DM_DOWN_KEY))) await this.d.ledger.setSetting(DM_DOWN_KEY, now.toISOString());
    this.log("dm_failed", { id: row.id, error: error.slice(0, 80) });
  }

  // ── the periodic driver ──
  private ticking: Promise<TickReport> | undefined;

  /** Single-flight: overlapping calls (cron + manual) share one run instead of racing DMs/placements. */
  tick(): Promise<TickReport> {
    if (!this.ticking) this.ticking = this.tickOnce().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async tickOnce(): Promise<TickReport> {
    const { ledger, clock } = this.d;
    const now = clock.now();
    const rep: TickReport = {
      stopped: false, dmsSent: 0, dmFailures: 0, quietHours: this.quiet(now), verdictsApplied: 0,
      placed: 0, denied: 0, expired: 0, closed: 0, errors: 0,
    };
    const each = async (rows: GateRow[], fn: (r: GateRow) => Promise<void>) => {
      for (const r of rows) {
        try {
          await fn(r);
        } catch (err) {
          rep.errors++;
          this.log("tick_row_error", { id: r.id, state: r.state, error: err instanceof Error ? err.name : "error" });
        }
      }
    };

    if (await ledger.isStopped()) {
      rep.stopped = true;
      return rep;
    }

    // 0. DM path health (before sends, so a 24h outage trips STOP rather than quietly expiring rows)
    const downSince = await ledger.getSetting(DM_DOWN_KEY);
    if (downSince) {
      const age = now.getTime() - Date.parse(downSince);
      if (age >= DM_DOWN_STOP_MS) {
        await this.stop("dm_path_down_24h");
        rep.stopped = true;
        return rep;
      }
      if (age > DM_DOWN_ALERT_MS) {
        try {
          await this.d.alerter?.alert("dm_down");
        } catch { /* best effort */ }
      }
    }

    // 0b. verdicts from the relay FIRST: a veto tapped on a DM we believed failed must cancel the
    // row before step 1 retries (and re-mints) its DM.
    try {
      rep.verdictsApplied += await this.pullVerdicts(now);
    } catch (err) {
      rep.errors++;
      this.log("verdict_pull_failed", { error: err instanceof Error ? err.name : "error" });
    }

    // 1. pending DMs (or expire after 24h of failures)
    await each(await ledger.listByState("dm_pending"), async (r) => {
      if (r.dmAttempts > 0 && now.getTime() - Date.parse(r.createdAt) >= DM_DOWN_STOP_MS) {
        await this.close(r, "expired", ["dm_undeliverable"], now);
        rep.expired++;
        return;
      }
      const out = await this.sendDm(r, now);
      if (out === "sent") rep.dmsSent++;
      if (out === "failed") rep.dmFailures++;
    });

    // 2. nothing left failing → the DM path is not "down" any more
    if (await ledger.getSetting(DM_DOWN_KEY)) {
      const stillFailing = (await ledger.listByState("dm_pending")).some((r) => r.dmAttempts > 0);
      if (!stillFailing) await ledger.setSetting(DM_DOWN_KEY, null);
    }

    // 4. cancel / veto windows
    await each(await ledger.listByState("dm_delivered"), async (r) => {
      if (r.decision === "ask") {
        await this.move(r, "pending_approval");
        return;
      }
      const since = await ledger.stateEnteredAt(r.id, "dm_delivered");
      if (!since) return; // no evidence of delivery time → wait (fail closed)
      const win = r.tier === "fund_auto" ? this.t.fundVetoWindowMs : this.t.autoCancelWindowMs;
      if (now.getTime() - Date.parse(since) >= win) await this.move(r, "approved", {}, "window_elapsed");
    });

    // 5. expire unanswered asks
    await each(await ledger.listByState("pending_approval"), async (r) => {
      const a = await ledger.getApprovalForRequest(r.id);
      const since = await ledger.stateEnteredAt(r.id, "dm_delivered");
      const deadline = a ? Date.parse(a.expiresAt) : since ? Date.parse(since) + this.t.approvalTtlMs : 0;
      if (now.getTime() > deadline) {
        await this.close(r, "expired", ["approval_ttl"], now);
        rep.expired++;
      }
    });

    // 6. place approved orders (re-quote, re-bind, re-decide first)
    await each(await ledger.listByState("approved"), async (r) => {
      const out = await this.place(r, now);
      if (out === "placed") rep.placed++;
      else if (out === "denied") rep.denied++;
    });

    // 7. poll vendor status (delivery links and vendor-side blocks ride along in status().raw)
    await each(await ledger.listByState("placed"), async (r) => {
      const adapter = this.d.adapters[r.vendor];
      if (!adapter || !r.vendorOrderId) return;
      await this.sendNeedsActionDm(r, now); // a block reported by place() this very tick
      const s = await adapter.status(r.vendorOrderId);
      const sig = vendorSignals(s.raw, r);
      if (s.state === "delivered") await this.move(r, "delivered", sig);
      else if (s.state === "cancelled") await this.move(r, "cancelled", {}, "vendor_cancelled");
      else if (s.state === "failed") await this.move(r, "cancelled", {}, "vendor_failed");
      else if (Object.keys(sig).length) await this.sendNeedsActionDm(await ledger.updateRequest(r.id, sig), now);
    });

    // 8. close delivered. Joy, silent and sealed purchases wait for THE REVEAL (the why-note DM);
    // a failed send leaves the row `delivered` for the next tick and blocks nothing else.
    await each(await ledger.listByState("delivered"), async (r) => {
      if (!needsWhyNote(r)) {
        await this.move(r, "closed", {}, "closed", { whyNoteDelivered: true });
        rep.closed++;
        return;
      }
      if (this.quiet(now)) return;
      const res = await this.d.notifier.send(deliveredWhyNoteDm(r));
      if (res.ok && res.messageId) {
        await this.move(r, "closed", {}, "why_note_sent", { whyNoteDelivered: true });
        rep.closed++;
      } else {
        await ledger.updateRequest(r.id, { dmLastError: (res.error ?? "no_message_id").slice(0, 80) });
      }
    });
    return rep;
  }

  /**
   * ONE "<label> order needs you: <hint>" DM per request, when an adapter reports the order blocked
   * on the vendor side (Prodigi RequiresPaymentAuthorisation, ...). The row stays `placed` and
   * keeps counting; it is not outcome_unknown (the order is known, and STOP would halt every
   * vendor). Rate limit: needsActionDmAt is set on the first delivered DM and never cleared, so a
   * request is DMed at most once; a failed send (or quiet hours) retries on the next tick.
   */
  private async sendNeedsActionDm(row: GateRow, now: Date): Promise<void> {
    if (!row.needsAction || row.needsActionDmAt || row.state !== "placed") return;
    if (this.quiet(now)) return;
    let res;
    try {
      res = await this.d.notifier.send(needsActionDm(row));
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.name : "send_error" };
    }
    if (res.ok && res.messageId) {
      await this.d.ledger.updateRequest(row.id, { needsActionDmAt: now.toISOString() });
      this.log("needs_action_dm", { id: row.id, vendor: row.vendor, code: row.needsAction });
    } else {
      this.log("needs_action_dm_failed", { id: row.id, error: (res.error ?? "no_message_id").slice(0, 80) });
    }
  }

  private async pullVerdicts(now: Date): Promise<number> {
    const { ledger } = this.d;
    const cursor = (await ledger.getSetting(VERDICT_CURSOR_KEY)) ?? new Date(0).toISOString();
    const since = new Date(Math.max(0, Date.parse(cursor) - VERDICT_OVERLAP_MS)).toISOString();
    const verdicts = await this.d.relay.pullVerdicts(since);
    let applied = 0, maxAt = cursor;
    for (const v of verdicts) {
      try {
        if (await this.applyVerdict(v, now)) applied++;
      } catch (err) {
        this.log("verdict_error", { approvalId: v.approvalId, error: err instanceof Error ? err.name : "error" });
      }
      if (v.at > maxAt && Date.parse(v.at) <= now.getTime() + 60_000) maxAt = v.at;
    }
    if (maxAt !== cursor) await ledger.setSetting(VERDICT_CURSOR_KEY, maxAt);
    return applied;
  }

  private async applyVerdict(v: Verdict, now: Date): Promise<boolean> {
    const { ledger } = this.d;
    const a = await ledger.getApproval(v.approvalId);
    if (!a || a.usedAt) return false;
    if (a.kind === "veto" && v.verdict === "approve") return false; // veto links are deny-only
    if (v.verdict === "approve") {
      if (Date.parse(v.at) > Date.parse(a.expiresAt) || now.getTime() > Date.parse(a.expiresAt)) return false;
      // Don't trust the relay's word alone: an approve must carry the plaintext APPROVE token the
      // owner's tap presented, and it must hash to the approveTokenHash WE stored (the deny token
      // never verifies). A compromised relay or leaked RELAY_TOKEN can then deny things, but never
      // approve them. The token is checked and dropped, never stored.
      const token = v.token;
      if (typeof token !== "string" || !(await verifyApproveToken(token, a))) {
        this.log("verdict_unproven", { approvalId: a.approvalId });
        return false;
      }
    }
    const row = await ledger.getRequest(a.requestId);
    if (!row) return false;
    // Approves must hit the request's current record; a deny from ANY of its records still stops money.
    if (v.verdict === "approve") {
      const current = await ledger.getApprovalForRequest(row.id);
      if (!current || current.approvalId !== a.approvalId) return false;
    }
    // Only consume when the verdict can actually act on the row's current state. A deny is honoured
    // in every pre-placing state, including dm_pending (the DM may have arrived even though the
    // transport reported a failure), so a tapped veto can never be skipped and later outrun.
    const PRE_PLACING_DENY = ["dm_pending", "dm_delivered", "pending_approval", "approved"];
    const actionable = v.verdict === "deny"
      ? [...PRE_PLACING_DENY, ...(a.kind === "veto" ? ["placed"] : [])].includes(row.state)
      : row.state === "pending_approval" || (row.state === "dm_delivered" && row.decision === "ask");
    if (!actionable) return false;
    if (!(await ledger.consumeApproval(a.approvalId, v.verdict, v.at))) return false;

    if (v.verdict === "approve") {
      // A crash between "DM delivered" and the promotion to pending_approval must not lose the tap.
      let cur = row;
      if (cur.state === "dm_delivered") cur = await this.move(cur, "pending_approval");
      await this.move(cur, "approved", { approver: "owner" }, "owner_approved");
      return true;
    }
    if (a.kind === "approve" || row.state !== "placed") {
      const to = row.state === "dm_pending" || row.state === "dm_delivered" ? "cancelled" : "denied";
      await this.close(row, to, [a.kind === "approve" ? "owner_denied" : "vetoed"], now);
      return true;
    }
    // veto (deny) after placement: try a vendor cancel
    if (row.vendorOrderId) {
      const adapter = this.d.adapters[row.vendor];
      const ok = adapter ? await adapter.cancel(row.vendorOrderId) : false;
      if (ok) await this.move(row, "cancelled", { reasons: [...(row.reasons ?? []), "vetoed_late"] }, "vetoed_late");
      else this.log("late_veto_cancel_failed", { id: row.id });
    }
    return true;
  }

  private async place(row: GateRow, now: Date): Promise<"placed" | "denied" | "failed" | "skipped"> {
    const { ledger } = this.d;
    if (await ledger.isStopped()) return "skipped";
    const deny = async (reasons: string[]) => {
      await this.close(row, "denied", reasons, now);
      return "denied" as const;
    };
    const adapter = Object.hasOwn(this.d.adapters, row.vendor) ? this.d.adapters[row.vendor] : undefined;
    if (!adapter) return await deny(["vendor_gone"]);
    // Fail closed: a delivered DM and a stored approval are prerequisites, except for a silent row
    // (auto decision, auto tier, reach self/world, by construction in submit()), which has neither.
    const silent = row.silent === true && row.decision === "auto" && row.tier === "auto" &&
      row.reachEffective !== "others";
    if (!row.quote) return await deny(["no_quote"]);
    let a: ApprovalRecord | undefined;
    if (!silent) {
      if (!row.dmMessageId) return await deny(["no_dm"]);
      a = await ledger.getApprovalForRequest(row.id);
      if (!a) return await deny(["no_approval"]);
      if (row.decision === "ask" && !(a.kind === "approve" && a.usedAt && a.verdict === "approve")) {
        return await deny(["not_approved"]);
      }
      if (a.kind === "veto" && a.usedAt) return await deny(["vetoed"]);
    }
    const boundCents = a ? a.boundCents : row.quote.totalCents;

    const req = rowToRequest(row);
    let q2: Quote;
    try {
      q2 = await adapter.quote(req);
    } catch {
      return await deny(["requote_failed"]);
    }
    const qp = quoteProblem(q2);
    if (qp) return await deny([qp]);
    if (a) {
      const bind = verifyBinding(a, { requestId: row.id, vendor: row.vendor, quoteTotalCents: q2.totalCents });
      if (!bind.ok) return await deny([bind.reason]);
    } else if (q2.totalCents !== boundCents) {
      return await deny(["quote_changed"]); // silent: bound to the quote it was judged on
    }
    if (q2.totalCents > row.maxTotalCents) return await deny(["over_agent_max"]);

    const adapterReach = adapter.reachFor(req);
    // The most this order may ever cost. Stored on the row at placing (before the vendor call, so an
    // outcome_unknown row carries it too): reconcile STOPs only on a charge above it.
    const hardCap = Math.min(boundCents, row.maxTotalCents);
    // Re-decide and enter `placing` under the money lock (same lock as intake). The row's own
    // in-flight amount and fund hold are excluded, or every approved ask would fail its own window.
    const gate = await this.withMoneyLock(async () => {
      const cur = await ledger.getRequest(row.id);
      if (!cur || cur.state !== "approved") return { skip: true as const };
      const pr = this.d.policy.decide({
        totalCents: q2.totalCents,
        vendor: row.vendor,
        reach: row.reachDeclared,
        adapterReach,
        budget: row.budget,
        fundBalanceCents: await ledger.fundBalance(row.id),
        windows: await ledger.windowsFor(row.vendor, row.budget, this.d.clock.now(), row.id),
        requestsLast10m: 0, // velocity is an intake check; it already ran in submit()
        stopped: await ledger.isStopped(),
        vendorAllowed: Object.hasOwn(this.d.adapters, row.vendor),
      });
      const eff = maxReach(pr.effectiveReach, maxReach(row.reachDeclared, adapterReach));
      if (pr.decision === "deny") return { deny: ["policy_changed", ...pr.reasons] };
      if (pr.tier !== row.tier) return { deny: ["policy_changed", `tier:${pr.tier}`] };
      if ((pr.decision === "ask" || eff === "others") && row.decision !== "ask") {
        return { deny: ["policy_changed", "now_needs_ask"] };
      }
      if (silent && !noticeFor({ ...pr, effectiveReach: eff }, q2.totalCents, row.budget, this.notice).silent) {
        return { deny: ["policy_changed", "now_needs_dm"] };
      }
      return {
        placing: await this.move(cur, "placing", { quote: q2, hardCapCents: hardCap }, "redecide_ok", { redecide: pr }),
      };
    });
    if ("skip" in gate) return "skipped";
    if (gate.deny) return await deny(gate.deny);
    const placing = gate.placing!;

    let order;
    try {
      order = await adapter.place(req, q2, hardCap, row.idempotencyKey);
    } catch (err) {
      if (err instanceof GuardRefused) {
        // Refused before the vendor was called: nothing moved. Plain failure, hold released.
        await this.close(placing, "failed", [`guard:${err.code}`], now);
        return "failed";
      }
      // The vendor may have charged before the error (timeout etc.). The outcome is unknown: the
      // row keeps counting against windows, any fund hold is kept, and STOP trips until reconcile
      // or a human resolves it (resolveUnknown), so nothing double-spends.
      await this.move(placing, "outcome_unknown", {
        reasons: [...(row.reasons ?? []), `place_error:${err instanceof Error ? err.name : "error"}`],
      }, "outcome_unknown");
      await this.stop("place_outcome_unknown");
      return "failed";
    }
    await this.move(placing, "placed", {
      vendorOrderId: order.vendorOrderId,
      finalCents: order.chargedCents,
      ...vendorSignals(order.raw, placing),
    });
    if (row.tier === "fund_auto") {
      await ledger.addFundEntry({ kind: "release", cents: q2.totalCents, requestId: row.id }, now);
      await ledger.addFundEntry({ kind: "spend", cents: -order.chargedCents, requestId: row.id }, now);
    }
    if (order.chargedCents > hardCap) {
      this.log("overcharge", { id: row.id });
      await this.stop("overcharge");
    }
    return "placed";
  }

  /**
   * Human/reconcile resolution of an `outcome_unknown` row: the vendor did charge (placed, with
   * its order id and amount) or it did not (failed, fund hold released).
   */
  async resolveUnknown(
    id: string,
    outcome: "placed" | "failed",
    order?: { vendorOrderId: string; chargedCents: number },
  ): Promise<GateRow> {
    const row = await this.d.ledger.getRequest(id);
    if (!row) throw new ValidationError("not_found");
    if (row.state !== "outcome_unknown") throw new IllegalTransition(`not outcome_unknown: ${row.state}`);
    const now = this.d.clock.now();
    if (outcome === "failed") return await this.close(row, "failed", ["resolved_not_charged"], now);
    if (!order || !order.vendorOrderId || !Number.isSafeInteger(order.chargedCents) || order.chargedCents < 0) {
      throw new ValidationError("vendorOrderId and chargedCents required");
    }
    const next = await this.move(row, "placed", { vendorOrderId: order.vendorOrderId, finalCents: order.chargedCents }, "resolved_charged");
    if (row.tier === "fund_auto") {
      await this.d.ledger.addFundEntry({ kind: "release", cents: row.quote?.totalCents ?? 0, requestId: row.id }, now);
      if (order.chargedCents > 0) {
        await this.d.ledger.addFundEntry({ kind: "spend", cents: -order.chargedCents, requestId: row.id }, now);
      }
    }
    return next;
  }

  // ── STOP ──
  async stop(reason: string): Promise<void> {
    const already = await this.d.ledger.isStopped();
    await this.d.ledger.setStop(true, reason);
    this.log("stop", { reason, already });
    for (const a of Object.values(this.d.adapters)) {
      try {
        await a.pause();
      } catch {
        this.log("pause_failed", { vendor: a.id });
      }
    }
    if (already) return;
    try {
      await this.d.alerter?.alert("stop_tripped");
    } catch { /* best effort */ }
    try {
      await this.d.notifier.send(stopDm(reason)); // even in quiet hours: STOP is worth waking for
    } catch { /* best effort */ }
  }

  async clearStop(): Promise<void> {
    await this.d.ledger.setStop(false);
    await this.d.ledger.setSetting(DM_DOWN_KEY, null);
    // Lift the in-process guard pause (guarded adapters). Vendor-side pauses (cards, keys) stay a human job.
    for (const a of Object.values(this.d.adapters)) {
      (a as { resume?: () => void }).resume?.();
    }
    this.log("stop_cleared");
  }

  /** Agent-initiated cancel. Only before money moves, or a vendor cancel after. */
  async cancel(id: string): Promise<GateRow> {
    const row = await this.d.ledger.getRequest(id);
    if (!row) throw new ValidationError("not_found");
    const now = this.d.clock.now();
    if (["dm_pending", "dm_delivered", "pending_approval", "approved"].includes(row.state)) {
      return await this.close(row, "cancelled", ["agent_cancelled"], now);
    }
    if (row.state === "placed" && row.vendorOrderId) {
      const adapter = this.d.adapters[row.vendor];
      if (adapter && (await adapter.cancel(row.vendorOrderId))) {
        return await this.move(row, "cancelled", { reasons: [...(row.reasons ?? []), "agent_cancelled"] });
      }
    }
    throw new IllegalTransition(`cannot cancel from ${row.state}`);
  }

  async rate(id: string, rating: number): Promise<GateRow> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ValidationError("rating must be 1..5");
    const row = await this.d.ledger.getRequest(id);
    if (!row) throw new ValidationError("not_found");
    if (row.state !== "delivered" && row.state !== "closed") throw new IllegalTransition("rate only after delivery");
    return await this.d.ledger.updateRequest(id, { rating });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Test helpers. Policy and state are the REAL policy.ts / state.ts (no drifting copies); only the
// ledger has an in-memory fake. Production wiring (wiring.ts) uses the SQLite ledger.
// ═════════════════════════════════════════════════════════════════════════

/** The real state.ts machine, plus: approved → placing REQUIRES a re-decide result (fail closed). */
export const contractStateGuard: StatePort = {
  assertTransition(from, to, ctx) {
    stateAssert(from, to, ctx);
    if (from === "approved" && to === "placing" && !ctx.redecide) {
      throw new IllegalTransition("placing needs a non-deny redecide");
    }
  },
};

/** The real policy.ts decide() with the types.ts DEFAULT_LIMITS. */
export const contractPolicy: PolicyPort = { decide: (i) => policyDecide(i) };

/** Kept for callers that imported it; it IS state.ts TRANSITIONS. */
export const CONTRACT_TRANSITIONS = TRANSITIONS;

const COUNTED: State[] = [
  "dm_pending", "dm_delivered", "pending_approval", "approved", "placing", "placed", "outcome_unknown", "delivered", "closed",
];

function nyParts(d: Date) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: gateTimezone(), year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d);
  return { day: p, month: p.slice(0, 7) };
}

/**
 * In-memory ledger. `writes` records every mutation as JSON (the token-leak test greps it).
 * Week window is approximated as the trailing 7 days.
 */
export class MemoryLedger implements LedgerPort {
  rows = new Map<string, GateRow>();
  hashes = new Map<string, string>();
  approvals = new Map<string, ApprovalRecord>();
  events: { requestId: string; from: State; to: State; at: string; note?: string }[] = [];
  fund: { kind: FundKind; cents: number; requestId?: string; at: string }[] = [];
  settings = new Map<string, string>();
  writes: string[] = [];
  stopped = false;
  budgets: Record<string, number> = { "global/day": 10_000, "global/month": 25_000, "joy/week": 4_000 };
  vendorMonthCap = 10_000;
  constructor(private readonly clock: Clock) {}
  private w(op: string, data: unknown) {
    this.writes.push(JSON.stringify({ op, data }));
  }

  insertRequest(req: PurchaseRequest, hash: string, now: Date) {
    for (const r of this.rows.values()) {
      if (r.idempotencyKey === req.idempotencyKey) {
        if (this.hashes.get(r.id) !== hash) throw new IdempotencyConflict(req.idempotencyKey);
        return { row: structuredClone(r), created: false };
      }
    }
    const id = crypto.randomUUID();
    const row: GateRow = {
      id, idempotencyKey: req.idempotencyKey, payloadHash: hash, requester: req.requester, taskId: req.taskId,
      vendor: req.vendor, budget: req.budget ?? "general", reachDeclared: req.reach, items: req.items, reason: req.reason,
      maxTotalCents: req.maxTotalCents, state: "received", dmAttempts: 0, createdAt: now.toISOString(),
      updatedAt: now.toISOString(), ...(req.shipTo ? { shipTo: req.shipTo } : {}), ...(req.category ? { category: req.category } : {}),
      ...(req.whyNote ? { whyNote: req.whyNote } : {}), ...(req.hint ? { hint: req.hint } : {}),
    };
    this.rows.set(id, row);
    this.hashes.set(id, hash);
    this.w("insertRequest", row);
    return { row: structuredClone(row), created: true };
  }
  getRequest(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }
  listByState(state: State) {
    return [...this.rows.values()].filter((r) => r.state === state).map((r) => structuredClone(r));
  }
  listAll(state?: State) {
    return [...this.rows.values()].filter((r) => !state || r.state === state).map((r) => structuredClone(r));
  }
  updateRequest(id: string, patch: Partial<GateRow>) {
    const r = this.rows.get(id);
    if (!r) throw new Error("not found");
    const { state: _s, id: _i, ...rest } = patch;
    Object.assign(r, rest, { updatedAt: this.clock.now().toISOString() });
    this.w("updateRequest", { id, patch: rest });
    return structuredClone(r);
  }
  transition(id: string, from: State, to: State, patch: Partial<GateRow> = {}, note?: string) {
    const r = this.rows.get(id);
    if (!r || r.state !== from) throw new IllegalTransition(`${id}: expected ${from}`);
    const at = this.clock.now().toISOString();
    Object.assign(r, patch, { state: to, updatedAt: at });
    this.events.push({ requestId: id, from, to, at, note });
    this.w("transition", { id, from, to, patch, note });
    return structuredClone(r);
  }
  stateEnteredAt(id: string, state: State) {
    return this.events.filter((e) => e.requestId === id && e.to === state).at(-1)?.at;
  }
  windowsFor(vendor: string, budget: "general" | "joy", now: Date, exclude?: string) {
    const live = [...this.rows.values()].filter((r) => r.id !== exclude && COUNTED.includes(r.state) && r.tier !== "fund_auto");
    const amt = (r: GateRow) => r.finalCents ?? r.quote?.totalCents ?? 0;
    const n = nyParts(now);
    const sum = (f: (r: GateRow) => boolean) => live.filter(f).reduce((s, r) => s + amt(r), 0);
    const day = (r: GateRow) => nyParts(new Date(r.createdAt)).day === n.day;
    const month = (r: GateRow) => nyParts(new Date(r.createdAt)).month === n.month;
    const week = (r: GateRow) => now.getTime() - Date.parse(r.createdAt) < 7 * 86400_000;
    const out: Record<string, WindowUsage> = {
      "global/day": { spentCents: sum(day), capCents: this.budgets["global/day"] },
      "global/month": { spentCents: sum(month), capCents: this.budgets["global/month"] },
      [`${vendor}/month`]: { spentCents: sum((r) => r.vendor === vendor && month(r)), capCents: this.vendorMonthCap },
    };
    if (budget === "joy") out["joy/week"] = { spentCents: sum((r) => r.budget === "joy" && week(r)), capCents: this.budgets["joy/week"] };
    return out;
  }
  fundBalance(excludeHoldFor?: string) {
    const total = this.fund.reduce((s, e) => s + e.cents, 0);
    if (!excludeHoldFor) return total;
    // add back this request's net hold (holds are negative, releases positive)
    const netHold = this.fund
      .filter((e) => e.requestId === excludeHoldFor && (e.kind === "hold" || e.kind === "release"))
      .reduce((s, e) => s + e.cents, 0);
    return total - netHold;
  }
  addFundEntry(e: { kind: FundKind; cents: number; requestId?: string; note?: string }, now: Date) {
    this.fund.push({ kind: e.kind, cents: e.cents, requestId: e.requestId, at: now.toISOString() });
    this.w("addFundEntry", e);
  }
  requestsLast10m(now: Date) {
    return [...this.rows.values()].filter((r) => now.getTime() - Date.parse(r.createdAt) < 600_000).length;
  }
  isStopped() {
    return this.stopped;
  }
  setStop(on: boolean, reason?: string) {
    this.stopped = on;
    this.w("setStop", { on, reason });
  }
  upsertApproval(a: ApprovalRecord) {
    this.approvals.set(a.approvalId, structuredClone(a));
    this.w("upsertApproval", a);
  }
  getApproval(id: string) {
    const a = this.approvals.get(id);
    return a ? structuredClone(a) : undefined;
  }
  getApprovalForRequest(requestId: string) {
    const a = [...this.approvals.values()].find((x) => x.requestId === requestId);
    return a ? structuredClone(a) : undefined;
  }
  consumeApproval(id: string, verdict: "approve" | "deny", at: string) {
    const a = this.approvals.get(id);
    if (!a || a.usedAt) return false;
    a.usedAt = at;
    a.verdict = verdict;
    this.w("consumeApproval", { id, verdict, at });
    return true;
  }
  getSetting(k: string) {
    return this.settings.get(k);
  }
  setSetting(k: string, v: string | null) {
    if (v === null) this.settings.delete(k);
    else this.settings.set(k, v);
    this.w("setSetting", { k, v });
  }
}
