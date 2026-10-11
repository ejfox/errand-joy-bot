// WP4: compare every vendor's charges against the ledger. Any surprise money → STOP + pause + one DM.
// Deps are injected so this file never imports ledger.ts.
// Non-goal for Phase 1: ledger orders with no vendor charge (money not moving is not a leak).
//
// The rule (real vendors legitimately differ from the quote: Zinc holds max_price + fee and refunds
// the rest, Prodigi and Lulu add real tax):
//  - a charge with no ledger order, or a second charge against an already-matched order → STOP;
//  - a matched charge ABOVE that order's hard cap (the most the gate ever authorized, stored on
//    the row at placing time) → STOP;
//  - a matched charge at or under the cap is the real amount: the ledger's finalCents is set to it
//    (windows count finalCents once known) and an event is logged. No STOP.
import type { Charge, Notifier, VendorAdapter } from "./types.ts";

export interface LedgerOrder {
  vendorOrderId: string;
  /** What the ledger currently counts for this order (finalCents, else the quote). */
  chargedCents: number;
  /** The most the gate authorized for this order. A charge above it trips STOP. */
  hardCapCents: number;
  requestId?: string;
}

/** unmatched: no ledger order, or a second charge against an already-matched order. */
export type ChargeIssue = "unmatched" | "over_cap";

export type ChargeRecord = Charge & { vendor: string; matched: boolean; reason?: ChargeIssue };

export interface FinalAdjustment {
  vendor: string;
  vendorOrderId: string;
  requestId?: string;
  fromCents: number;
  toCents: number;
  hardCapCents: number;
}

export interface RunRecord {
  at: string;
  sinceISO: string;
  ok: 0 | 1;
  charges: number;
  unmatched: number;
  /** Matched charges above the order's hard cap. */
  overCap: number;
  /** Matched charges under the cap whose amount differed from the ledger (finalCents updated). */
  adjusted: number;
  error?: string;
}

export interface ReconcileDeps {
  adapters: VendorAdapter[];
  listOrders(vendor: string, sinceISO: string): LedgerOrder[] | Promise<LedgerOrder[]>;
  recordCharge(c: ChargeRecord): void | Promise<void>;
  recordRun(r: RunRecord): void | Promise<void>;
  setStop(active: boolean): void | Promise<void>;
  /** Set the order's finalCents to the real charged amount and log an event. */
  updateFinal(a: FinalAdjustment): void | Promise<void>;
  notifier: Notifier;
}

function classify(c: Charge, unclaimed: Map<string, LedgerOrder>): { issue?: ChargeIssue; order?: LedgerOrder } {
  const order = c.vendorOrderId === undefined ? undefined : unclaimed.get(c.vendorOrderId);
  if (!order) return { issue: "unmatched" };
  unclaimed.delete(order.vendorOrderId); // one charge per order; a repeat is unmatched
  if (!Number.isSafeInteger(c.amountCents) || c.amountCents < 0) return { issue: "unmatched", order };
  // A row without a usable cap fails closed: anything above what it counts trips.
  const cap = Number.isSafeInteger(order.hardCapCents) && order.hardCapCents > 0 ? order.hardCapCents : order.chargedCents;
  if (c.amountCents > cap) return { issue: "over_cap", order };
  return { order };
}

export async function reconcile(deps: ReconcileDeps, sinceISO: string): Promise<RunRecord> {
  const run: RunRecord = {
    at: new Date().toISOString(),
    sinceISO,
    ok: 1,
    charges: 0,
    unmatched: 0,
    overCap: 0,
    adjusted: 0,
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
      const unclaimed = new Map(orders.map((o) => [o.vendorOrderId, o]));
      for (const c of charges) {
        run.charges++;
        const { issue, order } = classify(c, unclaimed);
        const rec: ChargeRecord = { ...c, vendor: adapter.id, matched: !issue, reason: issue };
        if (issue) {
          bad.push(rec);
          badAdapters.add(adapter);
          if (issue === "unmatched") run.unmatched++;
          else run.overCap++;
        } else if (order && c.amountCents !== order.chargedCents) {
          await deps.updateFinal({
            vendor: adapter.id,
            vendorOrderId: order.vendorOrderId,
            requestId: order.requestId,
            fromCents: order.chargedCents,
            toCents: c.amountCents,
            hardCapCents: order.hardCapCents,
          });
          run.adjusted++;
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
