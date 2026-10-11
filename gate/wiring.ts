// Wires the real parts together: the SQLite ledger (ledger.ts / fund.ts / budgets.ts) behind the
// orchestrator's LedgerPort, the real policy.ts and state.ts, guarded vendor adapters, the notifier,
// the relay client and reconcile. main.ts and the end-to-end test both build through buildDeps().
import { type Db, openDb, tx } from "./db.ts";
import * as L from "./ledger.ts";
import * as F from "./fund.ts";
import { upsertBudget, windowUsage } from "./budgets.ts";
import { assertTransition } from "./state.ts";
import { decide } from "./policy.ts";
import type { GateConfig } from "./config.ts";
import {
  type Clock,
  type GateRow,
  type LedgerPort,
  Orchestrator,
  type TransitionCtx,
} from "./orchestrator.ts";
import { buildRegistry, type GuardedAdapter } from "./adapters/registry.ts";
import { FakeRelayClient, HttpRelayClient } from "./relay_client.ts";
import { type HealthAlerter, makeHealthAlerter, makeNotifier } from "./notify.ts";
import { reconcile, type RunRecord } from "./reconcile.ts";
import type { ServerDeps } from "./server.ts";
import {
  type ApprovalRecord,
  type FundKind,
  IllegalTransition,
  type Notifier,
  type PurchaseRequest,
  type RelayClient,
  type State,
  type VendorAdapter,
  type WindowUsage,
} from "./types.ts";

const PATCH_KEYS = [
  "reachEffective", "quote", "finalCents", "tier", "decision", "reasons", "approver", "vendorOrderId",
  "dmMessageId", "dmAttempts", "dmLastError", "whyNote", "silent", "sealed", "rating",
] as const satisfies readonly (keyof L.RequestPatch)[];

/** Keep only the columns the ledger lets callers change; state/id/hash/etc. are never patchable. */
function toPatch(p: Partial<GateRow> | undefined): L.RequestPatch {
  const out: Record<string, unknown> = {};
  if (!p) return out;
  for (const k of PATCH_KEYS) if (k in p) out[k] = p[k];
  return out as L.RequestPatch;
}

/**
 * LedgerPort over the SQLite ledger. Every transition runs state.ts assertTransition (with STOP
 * re-read inside the same transaction) and is a compare-and-set on the current state. All
 * timestamps come from the injected clock, so events agree with the orchestrator's notion of now.
 *
 * Fund sign convention (ONE convention, fund.ts + a CHECK in schema.sql): topup/income/release/
 * refund are positive, hold/spend negative. A `release` always releases what is still held for the
 * request (never more), so a double release is a no-op.
 */
export class SqliteLedger implements LedgerPort {
  constructor(
    readonly db: Db,
    private readonly dataDir: string,
    private readonly clock: Clock,
    private readonly tz?: string,
  ) {}

  private now() {
    return this.clock.now();
  }

  insertRequest(req: PurchaseRequest, payloadHash: string, now: Date) {
    return tx(this.db, () => {
      const existing = L.getRequestByKey(this.db, req.idempotencyKey);
      const row = L.createRequest(this.db, req, payloadHash, now); // throws IdempotencyConflict on a hash mismatch
      return { row, created: !existing };
    });
  }

  getRequest(id: string) {
    return L.getRequest(this.db, id);
  }

  /** Oldest first. */
  listByState(state: State) {
    return L.listRequests(this.db, { state, limit: 10_000 }).reverse();
  }

  updateRequest(id: string, patch: Partial<GateRow>) {
    L.updateRequest(this.db, id, toPatch(patch), this.now());
    return L.getRequest(this.db, id)!;
  }

  transition(id: string, from: State, to: State, patch?: Partial<GateRow>, note?: string, ctx?: TransitionCtx) {
    return tx(this.db, () => {
      const cur = L.getRequest(this.db, id);
      if (!cur) throw new IllegalTransition(`${id}: not found`);
      if (cur.state !== from) throw new IllegalTransition(`${id}: expected ${from}, found ${cur.state}`);
      assertTransition(from, to, {
        budget: cur.budget,
        messageId: patch?.dmMessageId ?? cur.dmMessageId,
        ...ctx,
        // The persisted flags win over the caller's: a silent/sealed row is judged as what it IS.
        silent: patch?.silent ?? cur.silent,
        sealed: patch?.sealed ?? cur.sealed,
        stopped: this.isStopped(), // always re-read; never trust a caller's snapshot
      });
      return L.transition(this.db, id, to, note ?? "", toPatch(patch), this.now(), from);
    });
  }

  importOrder(o: L.ImportOrder) {
    return L.importOrder(this.db, o, this.now());
  }

  stateEnteredAt(id: string, state: State) {
    return L.listEvents(this.db, id).filter((e) => e.toState === state).at(-1)?.at;
  }

  windowsFor(vendor: string, budget: "general" | "joy", now: Date, excludeRequestId?: string): Record<string, WindowUsage> {
    return windowUsage(this.db, now, vendor, budget, { excludeRequestId, tz: this.tz });
  }

  fundBalance(excludeHoldFor?: string) {
    return F.fundBalance(this.db, { excludeHoldFor });
  }

  addFundEntry(e: { kind: FundKind; cents: number; requestId?: string; note?: string }, now: Date) {
    if (e.kind === "release") {
      if (!e.requestId) throw new Error("release needs a requestId");
      F.release(this.db, e.requestId, "gate", now);
      return;
    }
    if (e.cents === 0) return;
    F.addEntry(this.db, {
      kind: e.kind,
      cents: e.cents, // signed; addEntry throws on the wrong sign
      source: e.requestId ? "gate" : "admin",
      ...(e.requestId ? { requestId: e.requestId } : {}),
      ...(e.note ? { ref: e.note } : {}),
    }, now);
  }

  requestsLast10m(now: Date) {
    return L.requestsSince(this.db, new Date(now.getTime() - 600_000).toISOString());
  }

  isStopped() {
    return L.isStopped(this.db, this.dataDir);
  }

  setStop(on: boolean, reason?: string) {
    tx(this.db, () => {
      L.setStop(this.db, on);
      if (on) L.setSetting(this.db, "stop_reason", (reason ?? "unspecified").slice(0, 80));
      else L.deleteSetting(this.db, "stop_reason");
    });
  }

  upsertApproval(a: ApprovalRecord) {
    L.upsertApproval(this.db, a, this.now());
  }

  getApproval(approvalId: string) {
    return L.getApproval(this.db, approvalId);
  }

  getApprovalForRequest(requestId: string) {
    return L.listApprovals(this.db, requestId).at(-1);
  }

  consumeApproval(approvalId: string, verdict: "approve" | "deny", atISO: string) {
    const at = new Date(atISO);
    if (Number.isNaN(at.getTime())) return false;
    return L.consumeApproval(this.db, approvalId, verdict, at);
  }

  getSetting(key: string) {
    return L.getSetting(this.db, key);
  }

  setSetting(key: string, value: string | null) {
    if (value === null) L.deleteSetting(this.db, key);
    else L.setSetting(this.db, key, value);
  }
}

/** Write the configured caps into the budgets table (config is the source of truth for caps). */
export function applyBudgets(db: Db, config: GateConfig): void {
  tx(db, () => {
    for (const b of config.budgets) upsertBudget(db, b);
    for (const v of config.vendors) upsertBudget(db, { key: `${v}/month`, window: "month", capCents: config.vendorMonthCapCents });
  });
}

export interface BuildOptions {
  /** Where the STOP file and gate.db live. */
  dataDir: string;
  /** An already-open DB (tests); otherwise `${dataDir}/gate.db` is opened. */
  db?: Db;
  /** Env lookup; defaults to Deno.env. */
  env?: (name: string) => string | undefined;
  clock?: Clock;
  notifier?: Notifier;
  relay?: RelayClient;
  alerter?: HealthAlerter;
  /** Substitute vendor instances (tests); they are guarded like any other. */
  adapterOverrides?: Record<string, VendorAdapter>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface GateDeps {
  config: GateConfig;
  db: Db;
  ledger: SqliteLedger;
  orch: Orchestrator;
  adapters: Record<string, GuardedAdapter>;
  notifier: Notifier;
  relay: RelayClient;
  dryRun: boolean;
  reconcile: () => Promise<RunRecord>;
  /** ServerDeps minus the two bearer tokens (main.ts adds them from env). */
  server: Omit<ServerDeps, "agentToken" | "adminToken">;
}

/** How far back reconcile compares vendor charges with the ledger. */
export const RECONCILE_LOOKBACK_MS = 35 * 24 * 3600_000;

function envDefault(name: string): string | undefined {
  try {
    const v = Deno.env.get(name);
    return v && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build every runtime dependency from the policy config plus env.
 * DRY_RUN (default "1"; only exactly "0" is live): FakeNotifier, FakeRelayClient, and the guard
 * refuses place() on every non-simulated vendor.
 */
export function buildDeps(config: GateConfig, opts: BuildOptions): GateDeps {
  const env = opts.env ?? envDefault;
  const dryRun = env("DRY_RUN") !== "0";
  const clock: Clock = opts.clock ?? { now: () => new Date() };
  const db = opts.db ?? openDb(`${opts.dataDir.replace(/\/+$/, "")}/gate.db`);
  applyBudgets(db, config);
  const ledger = new SqliteLedger(db, opts.dataDir, clock, config.timezone);

  const adapters = buildRegistry(config.vendors, {
    isStopped: () => ledger.isStopped(),
    dryRun,
    worldCategories: config.worldCategories,
    mockTaxRate: config.mockTaxRate,
  }, opts.adapterOverrides);

  const notifier = opts.notifier ?? makeNotifier();
  let relay = opts.relay;
  if (!relay) {
    if (dryRun) relay = new FakeRelayClient();
    else {
      const url = env("RELAY_URL"), token = env("RELAY_TOKEN");
      if (!url || !token) throw new Error("RELAY_URL and RELAY_TOKEN are required when DRY_RUN=0");
      relay = new HttpRelayClient(url, token);
    }
  }
  const relayPublicUrl = env("RELAY_PUBLIC_URL") ?? (dryRun ? "https://relay.invalid" : undefined);
  if (!relayPublicUrl) throw new Error("RELAY_PUBLIC_URL is required when DRY_RUN=0");
  const alerter = opts.alerter ?? makeHealthAlerter(() => clock.now());

  const orch = new Orchestrator({
    ledger,
    policy: { decide: (i) => decide(i, config.limits) },
    state: {
      assertTransition(from, to, ctx) {
        assertTransition(from, to, ctx);
        // fail closed: placing needs a re-decide result in hand
        if (from === "approved" && to === "placing" && !ctx.redecide) {
          throw new IllegalTransition("placing needs a non-deny redecide");
        }
      },
    },
    adapters,
    notifier,
    relay,
    clock,
    alerter,
    log: opts.log,
    relayPublicUrl,
    quietHours: config.quietHours,
    timing: config.timing,
    minReasonChars: config.minReasonChars,
    ownerHomeLabel: config.ownerHomeLabel,
    notice: config.notice,
  });

  const runReconcile = async (): Promise<RunRecord> => {
    const started = clock.now().toISOString();
    const since = new Date(clock.now().getTime() - RECONCILE_LOOKBACK_MS).toISOString();
    return await reconcile({
      adapters: Object.values(adapters),
      listOrders: (vendor, s) => L.listVendorOrders(db, vendor, s),
      recordCharge: (c) => L.recordCharge(db, c, clock.now()),
      recordRun: (r) =>
        L.recordReconcileRun(db, {
          startedAt: started,
          finishedAt: clock.now().toISOString(),
          charges: r.charges,
          unmatched: r.unmatched + r.mismatched,
          ok: r.ok === 1,
          note: r.error?.slice(0, 500),
        }),
      setStop: (on) => ledger.setStop(on, "reconcile_mismatch"),
      notifier,
    }, since);
  };

  return {
    config,
    db,
    ledger,
    orch,
    adapters,
    notifier,
    relay,
    dryRun,
    reconcile: runReconcile,
    server: { orch, ledger, now: () => clock.now(), reconcile: runReconcile },
  };
}
