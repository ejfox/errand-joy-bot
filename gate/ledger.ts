// WP2: requests, events, approvals, STOP, ratings.
// This module records; it does NOT judge. Transition legality lives in state.ts (WP1).
import {
  type ApprovalRecord,
  type Decision,
  IdempotencyConflict,
  type Item,
  type PolicyResult,
  type PurchaseRequest,
  type Quote,
  type Reach,
  IllegalTransition,
  type RequestRow,
  type ShipTo,
  type State,
  type Tier,
} from "./types.ts";
import { type Db, nowISO, tx } from "./db.ts";

type SqlVal = string | number | null;
type Row = Record<string, SqlVal>;

const nn = <T>(
  v: T | undefined | null,
): T | null => (v === undefined ? null : v);
const str = (
  v: SqlVal,
): string | undefined => (v === null ? undefined : String(v));
const num = (
  v: SqlVal,
): number | undefined => (v === null ? undefined : Number(v));

/** Canonical JSON (sorted keys) so the hash is stable across key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${
      Object.keys(o).filter((k) => o[k] !== undefined).sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")
    }}`;
  }
  return JSON.stringify(v);
}

/** Hex sha256 of the canonical request payload; pass to createRequest. */
export async function hashPayload(req: PurchaseRequest): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(req)),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function rowToRequest(r: Row): RequestRow {
  const quote: Quote | undefined = r.quote_total_cents === null ? undefined : {
    subtotalCents: Number(r.quote_subtotal_cents ?? 0),
    taxCents: Number(r.quote_tax_cents ?? 0),
    shippingCents: Number(r.quote_shipping_cents ?? 0),
    totalCents: Number(r.quote_total_cents),
    currency: "USD",
    vendorRef: str(r.quote_ref),
    quotedAt: String(r.quoted_at ?? ""),
    raw: r.quote_raw_json === null
      ? undefined
      : JSON.parse(String(r.quote_raw_json)),
  };
  return {
    id: String(r.id),
    idempotencyKey: String(r.idempotency_key),
    payloadHash: String(r.payload_hash),
    requester: String(r.requester),
    taskId: String(r.task_id),
    vendor: String(r.vendor),
    budget: r.budget as "general" | "joy",
    reachDeclared: r.reach_declared as Reach,
    reachEffective: str(r.reach_effective) as Reach | undefined,
    items: JSON.parse(String(r.items_json)) as Item[],
    reason: String(r.reason),
    maxTotalCents: Number(r.max_total_cents),
    ...(r.category === null || r.category === undefined ? {} : { category: String(r.category) }),
    ...(r.ship_to_json === null || r.ship_to_json === undefined
      ? {}
      : { shipTo: JSON.parse(String(r.ship_to_json)) as ShipTo }),
    quote,
    finalCents: num(r.final_cents),
    tier: str(r.tier) as Tier | undefined,
    decision: str(r.decision) as Decision | undefined,
    reasons: r.reasons_json === null
      ? undefined
      : JSON.parse(String(r.reasons_json)),
    state: r.state as State,
    approver: str(r.approver),
    vendorOrderId: str(r.vendor_order_id),
    dmMessageId: str(r.dm_message_id),
    dmAttempts: Number(r.dm_attempts),
    dmLastError: str(r.dm_last_error),
    whyNote: str(r.why_note),
    rating: num(r.rating),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Fields of the original PurchaseRequest not carried on RequestRow. */
export function getRequestExtras(
  db: Db,
  id: string,
): { category?: string; shipTo?: PurchaseRequest["shipTo"] } | undefined {
  const r = db.prepare(
    "SELECT category, ship_to_json FROM requests WHERE id = ?",
  ).get(id) as
    | Row
    | undefined;
  if (!r) return undefined;
  return {
    category: str(r.category),
    shipTo: r.ship_to_json === null
      ? undefined
      : JSON.parse(String(r.ship_to_json)),
  };
}

export function getRequest(db: Db, id: string): RequestRow | undefined {
  const r = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as
    | Row
    | undefined;
  return r ? rowToRequest(r) : undefined;
}

export function getRequestByKey(
  db: Db,
  idempotencyKey: string,
): RequestRow | undefined {
  const r = db.prepare("SELECT * FROM requests WHERE idempotency_key = ?").get(
    idempotencyKey,
  ) as
    | Row
    | undefined;
  return r ? rowToRequest(r) : undefined;
}

/**
 * Insert a request in state `received` (plus its initial event).
 * Same key + same hash → returns the existing row unchanged.
 * Same key + different hash → throws IdempotencyConflict (caller trips STOP).
 */
export function createRequest(
  db: Db,
  req: PurchaseRequest,
  payloadHash: string,
  now: Date = new Date(),
): RequestRow {
  return tx(db, () => {
    const existing = getRequestByKey(db, req.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new IdempotencyConflict(
          `idempotency key ${req.idempotencyKey} reused with a different payload`,
        );
      }
      return existing;
    }
    const id = crypto.randomUUID();
    const at = nowISO(now);
    db.prepare(
      `INSERT INTO requests (id, idempotency_key, payload_hash, requester, task_id, vendor,
         budget, reach_declared, items_json, reason, max_total_cents, category, ship_to_json,
         why_note, state, dm_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, ?, ?)`,
    ).run(
      id,
      req.idempotencyKey,
      payloadHash,
      req.requester,
      req.taskId,
      req.vendor,
      req.budget ?? "general",
      req.reach,
      JSON.stringify(req.items),
      req.reason,
      req.maxTotalCents,
      nn(req.category),
      req.shipTo === undefined ? null : JSON.stringify(req.shipTo),
      nn(req.whyNote),
      at,
      at,
    );
    db.prepare(
      "INSERT INTO events (request_id, from_state, to_state, note, at) VALUES (?, NULL, 'received', ?, ?)",
    ).run(id, "intake", at);
    return getRequest(db, id)!;
  });
}

export function listRequests(
  db: Db,
  opts: { state?: State; since?: string; limit?: number } = {},
): RequestRow[] {
  const where: string[] = [];
  const args: SqlVal[] = [];
  if (opts.state) {
    where.push("state = ?");
    args.push(opts.state);
  }
  if (opts.since) {
    where.push("created_at >= ?");
    args.push(opts.since);
  }
  const sql = `SELECT * FROM requests ${
    where.length ? "WHERE " + where.join(" AND ") : ""
  }
    ORDER BY created_at DESC, id LIMIT ?`;
  args.push(opts.limit ?? 1000);
  return (db.prepare(sql).all(...args) as Row[]).map(rowToRequest);
}

/** Count of requests created at or after `sinceISO`, all states (velocity check). */
export function requestsSince(db: Db, sinceISO: string): number {
  const r = db.prepare(
    "SELECT COUNT(*) AS n FROM requests WHERE created_at >= ?",
  ).get(
    sinceISO,
  ) as Row;
  return Number(r.n);
}

export type RequestPatch = Partial<
  Pick<
    RequestRow,
    | "reachEffective"
    | "quote"
    | "finalCents"
    | "tier"
    | "decision"
    | "reasons"
    | "approver"
    | "vendorOrderId"
    | "dmMessageId"
    | "dmAttempts"
    | "dmLastError"
    | "whyNote"
    | "rating"
  >
>;

function patchColumns(p: RequestPatch): [string, SqlVal][] {
  const cols: [string, SqlVal][] = [];
  const set = (k: keyof RequestPatch, col: string, v: () => SqlVal) => {
    if (k in p) cols.push([col, p[k] === undefined ? null : v()]);
  };
  set("reachEffective", "reach_effective", () => p.reachEffective!);
  set("finalCents", "final_cents", () => p.finalCents!);
  set("tier", "tier", () => p.tier!);
  set("decision", "decision", () => p.decision!);
  set("reasons", "reasons_json", () => JSON.stringify(p.reasons));
  set("approver", "approver", () => p.approver!);
  set("vendorOrderId", "vendor_order_id", () => p.vendorOrderId!);
  set("dmMessageId", "dm_message_id", () => p.dmMessageId!);
  set("dmAttempts", "dm_attempts", () => p.dmAttempts!);
  set("dmLastError", "dm_last_error", () => p.dmLastError!);
  set("whyNote", "why_note", () => p.whyNote!);
  set("rating", "rating", () => p.rating!);
  if ("quote" in p) {
    const q = p.quote;
    cols.push(
      ["quote_subtotal_cents", q ? q.subtotalCents : null],
      ["quote_tax_cents", q ? q.taxCents : null],
      ["quote_shipping_cents", q ? q.shippingCents : null],
      ["quote_total_cents", q ? q.totalCents : null],
      ["quote_currency", q ? q.currency : null],
      ["quote_ref", q ? nn(q.vendorRef) : null],
      ["quoted_at", q ? q.quotedAt : null],
      [
        "quote_raw_json",
        q && q.raw !== undefined ? JSON.stringify(q.raw) : null,
      ],
    );
  }
  return cols;
}

/** Apply a field patch (no state change, no event). Bumps updated_at. */
export function updateRequest(
  db: Db,
  id: string,
  patch: RequestPatch,
  now = new Date(),
): void {
  const cols = patchColumns(patch);
  cols.push(["updated_at", nowISO(now)]);
  const res = db.prepare(
    `UPDATE requests SET ${
      cols.map(([c]) => `${c} = ?`).join(", ")
    } WHERE id = ?`,
  ).run(...cols.map(([, v]) => v), id);
  if (res.changes !== 1) throw new Error(`request ${id} not found`);
}

/**
 * Move a request to `to`, applying `patch`, in ONE transaction with its events row.
 * No legality check here: callers pass transitions already validated by state.ts (wiring.ts
 * SqliteLedger always does). With `expectFrom`, the UPDATE is a compare-and-set on the current
 * state and throws IllegalTransition when the row has moved on.
 */
export function transition(
  db: Db,
  id: string,
  to: State,
  note: string,
  patch: RequestPatch = {},
  now: Date = new Date(),
  expectFrom?: State,
): RequestRow {
  return tx(db, () => {
    const cur = db.prepare("SELECT state FROM requests WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!cur) throw new Error(`request ${id} not found`);
    const at = nowISO(now);
    const cols = patchColumns(patch);
    cols.push(["state", to], ["updated_at", at]);
    const cas = expectFrom === undefined ? "" : " AND state = ?";
    const res = db.prepare(
      `UPDATE requests SET ${
        cols.map(([c]) => `${c} = ?`).join(", ")
      } WHERE id = ?${cas}`,
    ).run(...cols.map(([, v]) => v), id, ...(expectFrom === undefined ? [] : [expectFrom]));
    if (Number(res.changes) !== 1) {
      throw new IllegalTransition(`${id}: expected ${expectFrom}, found ${cur.state}`);
    }
    db.prepare(
      "INSERT INTO events (request_id, from_state, to_state, note, at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, cur.state, to, note, at);
    return getRequest(db, id)!;
  });
}

/** Store the vendor quote (no state change; pair with transition(..., "quoted")). */
export function recordQuote(
  db: Db,
  id: string,
  quote: Quote,
  now = new Date(),
): void {
  updateRequest(db, id, { quote }, now);
}

/** Store a policy result (no state change; pair with transition(..., "decided")). */
export function recordDecision(
  db: Db,
  id: string,
  result: PolicyResult,
  now = new Date(),
): void {
  updateRequest(db, id, {
    decision: result.decision,
    tier: result.tier,
    reasons: result.reasons,
    reachEffective: result.effectiveReach,
  }, now);
}

export function recordRating(
  db: Db,
  id: string,
  rating: number,
  now = new Date(),
): void {
  if (!Number.isInteger(rating)) throw new Error("rating must be an integer");
  updateRequest(db, id, { rating }, now);
}

export interface EventRow {
  id: number;
  requestId: string;
  fromState?: State;
  toState: State;
  note?: string;
  at: string;
}

export function listEvents(db: Db, requestId: string): EventRow[] {
  return (db.prepare("SELECT * FROM events WHERE request_id = ? ORDER BY id")
    .all(
      requestId,
    ) as Row[]).map((r) => ({
      id: Number(r.id),
      requestId: String(r.request_id),
      fromState: str(r.from_state) as State | undefined,
      toState: r.to_state as State,
      note: str(r.note),
      at: String(r.at),
    }));
}

// ── Approvals ─────────────────────────────────────────────────────────────
function rowToApproval(r: Row): ApprovalRecord {
  return {
    approvalId: String(r.approval_id),
    requestId: String(r.request_id),
    denyTokenHash: String(r.deny_token_hash),
    ...(r.approve_token_hash === null ? {} : { approveTokenHash: String(r.approve_token_hash) }),
    denyLookupId: r.deny_lookup_id == null ? "" : String(r.deny_lookup_id), // "" = pre-lookup-id row
    ...(r.approve_lookup_id == null ? {} : { approveLookupId: String(r.approve_lookup_id) }),
    vendor: String(r.vendor),
    boundCents: Number(r.bound_cents),
    kind: r.kind as "approve" | "veto",
    summary: String(r.summary),
    expiresAt: String(r.expires_at),
    usedAt: str(r.used_at),
    verdict: str(r.verdict) as "approve" | "deny" | undefined,
  };
}

export function insertApproval(
  db: Db,
  a: ApprovalRecord,
  now = new Date(),
): void {
  db.prepare(
    `INSERT INTO approvals (approval_id, request_id, deny_token_hash, approve_token_hash, deny_lookup_id,
       approve_lookup_id, vendor, bound_cents, kind, summary, expires_at, used_at, verdict, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.approvalId,
    a.requestId,
    a.denyTokenHash,
    nn(a.approveTokenHash),
    a.denyLookupId || null,
    nn(a.approveLookupId),
    a.vendor,
    a.boundCents,
    a.kind,
    a.summary,
    a.expiresAt,
    nn(a.usedAt),
    nn(a.verdict),
    nowISO(now),
  );
}

export function getApproval(
  db: Db,
  approvalId: string,
): ApprovalRecord | undefined {
  const r = db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(
    approvalId,
  ) as
    | Row
    | undefined;
  return r ? rowToApproval(r) : undefined;
}

/**
 * Insert, or (on a DM retry that reuses the approvalId) rotate the hashes and refresh the record.
 * A consumed record (used_at set) is never overwritten.
 */
export function upsertApproval(db: Db, a: ApprovalRecord, now = new Date()): void {
  db.prepare(
    `INSERT INTO approvals (approval_id, request_id, deny_token_hash, approve_token_hash, deny_lookup_id,
       approve_lookup_id, vendor, bound_cents, kind, summary, expires_at, used_at, verdict, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(approval_id) DO UPDATE SET
       deny_token_hash = excluded.deny_token_hash,
       approve_token_hash = excluded.approve_token_hash,
       deny_lookup_id = excluded.deny_lookup_id,
       approve_lookup_id = excluded.approve_lookup_id,
       vendor = excluded.vendor,
       bound_cents = excluded.bound_cents,
       kind = excluded.kind,
       summary = excluded.summary,
       expires_at = excluded.expires_at
     WHERE approvals.used_at IS NULL AND approvals.request_id = excluded.request_id`,
  ).run(
    a.approvalId,
    a.requestId,
    a.denyTokenHash,
    nn(a.approveTokenHash),
    a.denyLookupId || null,
    nn(a.approveLookupId),
    a.vendor,
    a.boundCents,
    a.kind,
    a.summary,
    a.expiresAt,
    nowISO(now),
  );
}

/** Look up by either token hash. */
export function getApprovalByTokenHash(
  db: Db,
  tokenHash: string,
): ApprovalRecord | undefined {
  const r = db.prepare(
    "SELECT * FROM approvals WHERE deny_token_hash = ? OR approve_token_hash = ?",
  ).get(tokenHash, tokenHash) as
    | Row
    | undefined;
  return r ? rowToApproval(r) : undefined;
}

export function listApprovals(db: Db, requestId: string): ApprovalRecord[] {
  return (db.prepare(
    "SELECT * FROM approvals WHERE request_id = ? ORDER BY created_at, rowid",
  ).all(
    requestId,
  ) as Row[]).map(rowToApproval);
}

/**
 * Single-use consume: atomic UPDATE ... WHERE used_at IS NULL AND not expired.
 * Returns true exactly once per approval; false if used, expired or unknown.
 */
export function consumeApproval(
  db: Db,
  approvalId: string,
  verdict: "approve" | "deny",
  now: Date = new Date(),
): boolean {
  const at = nowISO(now);
  const res = db.prepare(
    `UPDATE approvals SET used_at = ?, verdict = ?
     WHERE approval_id = ? AND used_at IS NULL AND expires_at > ?`,
  ).run(at, verdict, approvalId, at);
  return Number(res.changes) === 1;
}

// ── STOP ──────────────────────────────────────────────────────────────────
/** STOP if the file `${dataDir}/STOP` exists OR settings.stop = '1'. */
export function isStopped(db: Db, dataDir: string): boolean {
  try {
    Deno.statSync(`${dataDir.replace(/\/+$/, "")}/STOP`);
    return true;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) return true; // can't tell → fail closed
  }
  const r = db.prepare("SELECT value FROM settings WHERE key = 'stop'").get() as
    | Row
    | undefined;
  return r?.value === "1";
}

/** Sets settings.stop only. The STOP file is the owner's manual switch and is never touched here. */
export function setStop(db: Db, on: boolean): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('stop', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(on ? "1" : "0");
}

export function getSetting(db: Db, key: string): string | undefined {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | Row
    | undefined;
  return r ? String(r.value) : undefined;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function deleteSetting(db: Db, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// ── Reconcile ─────────────────────────────────────────────────────────────
/** Orders this vendor placed for us (any row with a vendor order id) created at or after `sinceISO`. */
export function listVendorOrders(
  db: Db,
  vendor: string,
  sinceISO: string,
): { vendorOrderId: string; chargedCents: number }[] {
  return (db.prepare(
    `SELECT vendor_order_id, COALESCE(final_cents, quote_total_cents, 0) AS c FROM requests
     WHERE vendor = ? AND vendor_order_id IS NOT NULL AND created_at >= ?`,
  ).all(vendor, sinceISO) as Row[]).map((r) => ({
    vendorOrderId: String(r.vendor_order_id),
    chargedCents: Number(r.c),
  }));
}

export interface ChargeRow {
  vendor: string;
  vendorChargeId: string;
  amountCents: number;
  at: string;
  vendorOrderId?: string;
}

/** Record a vendor-side charge once (UNIQUE vendor + charge id); links it to its request when known. */
export function recordCharge(db: Db, c: ChargeRow, now = new Date()): void {
  const req = c.vendorOrderId === undefined ? undefined : db.prepare(
    "SELECT id FROM requests WHERE vendor = ? AND vendor_order_id = ?",
  ).get(c.vendor, c.vendorOrderId) as Row | undefined;
  db.prepare(
    `INSERT OR IGNORE INTO charges (vendor, vendor_charge_id, amount_cents, at, vendor_order_id, request_id, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.vendor,
    c.vendorChargeId,
    c.amountCents,
    c.at,
    nn(c.vendorOrderId),
    req ? String(req.id) : null,
    nowISO(now),
  );
}

export function recordReconcileRun(
  db: Db,
  r: { startedAt: string; finishedAt: string; charges: number; unmatched: number; ok: boolean; note?: string },
): void {
  db.prepare(
    `INSERT INTO reconcile_runs (vendor, started_at, finished_at, charges_seen, unmatched, ok, note)
     VALUES (NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(r.startedAt, r.finishedAt, r.charges, r.unmatched, r.ok ? 1 : 0, nn(r.note));
}
