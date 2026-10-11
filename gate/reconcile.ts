// WP4: compare every vendor's charges against the ledger. Any surprise money → STOP + pause + one DM.
// Deps are injected so this file never imports ledger.ts.
// Non-goal for Phase 1: ledger orders with no vendor charge (money not moving is not a leak).
import type { Charge, Notifier, Order, VendorAdapter } from "./types.ts";

export type LedgerOrder = Pick<Order, "vendorOrderId" | "chargedCents">;

/** unmatched: no ledger order, or a second charge against an already-matched order. */
export type ChargeIssue = "unmatched" | "amount_mismatch";

export type ChargeRecord = Charge & { vendor: string; matched: boolean; reason?: ChargeIssue };

export interface RunRecord {
  at: string;
  sinceISO: string;
  ok: 0 | 1;
  charges: number;
  unmatched: number;
  mismatched: number;
  error?: string;
}

export interface ReconcileDeps {
  adapters: VendorAdapter[];
  listOrders(vendor: string, sinceISO: string): LedgerOrder[] | Promise<LedgerOrder[]>;
  recordCharge(c: ChargeRecord): void | Promise<void>;
  recordRun(r: RunRecord): void | Promise<void>;
  setStop(active: boolean): void | Promise<void>;
  notifier: Notifier;
}

/** Amounts within this many cents are treated as equal (rounding). */
const TOLERANCE_CENTS = 1;

function classify(c: Charge, unclaimed: Map<string, number>): ChargeIssue | undefined {
  const expected = c.vendorOrderId === undefined ? undefined : unclaimed.get(c.vendorOrderId);
  if (expected === undefined) return "unmatched";
  unclaimed.delete(c.vendorOrderId!); // one charge per order; a repeat is unmatched
  if (Math.abs(c.amountCents - expected) > TOLERANCE_CENTS) return "amount_mismatch";
}

export async function reconcile(deps: ReconcileDeps, sinceISO: string): Promise<RunRecord> {
  const run: RunRecord = {
    at: new Date().toISOString(),
    sinceISO,
    ok: 1,
    charges: 0,
    unmatched: 0,
    mismatched: 0,
  };
  const bad: ChargeRecord[] = [];
  const badAdapters = new Set<VendorAdapter>();
  const errors: string[] = [];

  for (const adapter of deps.adapters) {
    try {
      const [charges, orders] = await Promise.all([
        adapter.listCharges(sinceISO),
        deps.listOrders(adapter.id, sinceISO),
      ]);
      const unclaimed = new Map(orders.map((o) => [o.vendorOrderId, o.chargedCents]));
      for (const c of charges) {
        run.charges++;
        const reason = classify(c, unclaimed);
        const rec: ChargeRecord = { ...c, vendor: adapter.id, matched: !reason, reason };
        if (reason) {
          bad.push(rec);
          badAdapters.add(adapter);
          if (reason === "unmatched") run.unmatched++;
          else run.mismatched++;
        }
        await deps.recordCharge(rec);
      }
    } catch (e) {
      // Can't verify = fail closed.
      errors.push(`check:${adapter.id}:${errMsg(e)}`);
      badAdapters.add(adapter);
    }
  }

  if (badAdapters.size) {
    run.ok = 0;
    // STOP first: if the DM or a pause fails, the gate is already closed.
    await deps.setStop(true);
    try {
      const unchecked = [...badAdapters].filter((a) => !bad.some((b) => b.vendor === a.id)).map((a) => a.id);
      const dm = await deps.notifier.send(alertText(bad, unchecked));
      if (!dm.ok) errors.push(`dm:${dm.error ?? "failed"}`);
    } catch (e) {
      errors.push(`dm:${errMsg(e)}`);
    }
    for (const a of badAdapters) {
      try {
        await a.pause();
      } catch (e) {
        errors.push(`pause:${a.id}:${errMsg(e)}`);
      }
    }
  }
  if (errors.length) run.error = errors.join("; ");

  await deps.recordRun(run);
  return run;
}

/** Ids, vendors and cents only. Never interpolate vendor raw payloads or error messages. */
function alertText(bad: ChargeRecord[], unchecked: string[]): string {
  const lines = bad.slice(0, 10).map((b) =>
    `- ${b.vendor} ${b.vendorChargeId} $${(b.amountCents / 100).toFixed(2)} ${b.reason}` +
    (b.vendorOrderId ? ` (order ${b.vendorOrderId})` : "")
  );
  if (bad.length > 10) lines.push(`- ...and ${bad.length - 10} more`);
  for (const id of unchecked) lines.push(`- ${id} could not be checked (see reconcile_runs)`);
  return `CRITICAL purchase-gate reconcile: ${bad.length} charge(s) do not match the ledger` +
    `${unchecked.length ? ` and ${unchecked.length} vendor(s) could not be checked` : ""}. ` +
    `STOP is set and the vendor(s) are paused.\n` +
    lines.join("\n");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
