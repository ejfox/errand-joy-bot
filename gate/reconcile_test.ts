import { strict as assert } from "node:assert";
import type { Charge, DmResult, PurchaseRequest } from "./types.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { type ChargeRecord, type FinalAdjustment, type LedgerOrder, reconcile, type RunRecord } from "./reconcile.ts";

/** The ledger's view of a placed order: counted at `counted`, authorized up to `cap`. */
const lo = (o: { vendorOrderId: string; chargedCents: number }, cap = o.chargedCents, counted = o.chargedCents): LedgerOrder => ({
  vendorOrderId: o.vendorOrderId,
  chargedCents: counted,
  hardCapCents: cap,
  requestId: "req-1",
});

const SINCE = "2000-01-01T00:00:00Z";

const req: PurchaseRequest = {
  idempotencyKey: "k1",
  requester: "test",
  taskId: "t1",
  vendor: "mock",
  items: [{ sku: "led-red", qty: 3 }],
  reason: "test",
  reach: "self",
  maxTotalCents: 10_000,
};

function harness(adapter: MockAdapter, ledger: LedgerOrder[]) {
  const charges: ChargeRecord[] = [];
  const runs: RunRecord[] = [];
  const dms: string[] = [];
  const stops: boolean[] = [];
  const finals: FinalAdjustment[] = [];
  return {
    charges,
    runs,
    dms,
    stops,
    finals,
    deps: {
      adapters: [adapter],
      listOrders: (vendor: string) => (vendor === adapter.id ? ledger : []),
      recordCharge: (c: ChargeRecord) => void charges.push(c),
      updateFinal: (a: FinalAdjustment) => void finals.push(a),
      recordRun: (r: RunRecord) => void runs.push(r),
      setStop: (s: boolean) => void stops.push(s),
      notifier: {
        send: (t: string): Promise<DmResult> => {
          dms.push(t);
          return Promise.resolve({ ok: true, messageId: "m1" });
        },
      },
    },
  };
}

async function placed(adapter: MockAdapter) {
  const q = await adapter.quote(req);
  return adapter.place(req, q, q.totalCents, "k1");
}

Deno.test("clean run is ok and matched charges are recorded as matched", async () => {
  const a = new MockAdapter();
  const o = await placed(a);
  const h = harness(a, [lo(o)]);
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 1);
  assert.deepEqual(h.runs, [run]);
  assert.equal(h.charges.length, 1);
  assert.equal(h.charges[0].matched, true);
  assert.equal(h.charges[0].reason, undefined);
  assert.deepEqual(h.stops, []);
  assert.deepEqual(h.dms, []);
  assert.deepEqual(h.finals, []); // same amount: nothing to adjust
  assert.equal(a.paused, false);
});

Deno.test("Zinc-style hold above the quote but within the hard cap: no STOP, finalCents updated", async () => {
  const a = new MockAdapter();
  const o = await placed(a);
  // The ledger counts the quote (charge - 150); the gate authorized up to charge + 50.
  const h = harness(a, [lo(o, o.chargedCents + 50, o.chargedCents - 150)]);
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 1);
  assert.equal(run.adjusted, 1);
  assert.equal(run.overCap, 0);
  assert.deepEqual(h.stops, []);
  assert.deepEqual(h.dms, []);
  assert.equal(a.paused, false);
  assert.deepEqual(h.finals, [{
    vendor: "mock",
    vendorOrderId: o.vendorOrderId,
    requestId: "req-1",
    fromCents: o.chargedCents - 150,
    toCents: o.chargedCents,
    hardCapCents: o.chargedCents + 50,
  }]);
  assert.equal(h.charges[0].matched, true);
});

Deno.test("a charge below what the ledger counts (refunded hold) updates finalCents down, no STOP", async () => {
  const a = new MockAdapter();
  const o = await placed(a);
  const h = harness(a, [lo(o, o.chargedCents + 100, o.chargedCents + 100)]);
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 1);
  assert.deepEqual(h.stops, []);
  assert.equal(h.finals.length, 1);
  assert.equal(h.finals[0].toCents, o.chargedCents);
});

Deno.test("a charge exactly at the hard cap is fine", async () => {
  const a = new MockAdapter();
  const o = await placed(a);
  const h = harness(a, [lo(o, o.chargedCents, o.chargedCents - 1)]);
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 1);
  assert.deepEqual(h.stops, []);
});

Deno.test("phantom charge trips STOP, pause and exactly one DM", async () => {
  const phantoms: Charge[] = [
    { vendorChargeId: "ph1", amountCents: 4_200, at: "2026-10-10T00:00:00Z" },
    { vendorChargeId: "ph2", amountCents: 100, at: "2026-10-10T01:00:00Z", vendorOrderId: "nope" },
  ];
  const a = new MockAdapter({ phantomCharges: phantoms });
  const o = await placed(a);
  const h = harness(a, [lo(o, o.chargedCents * 10)]); // a generous cap never covers a phantom
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 0);
  assert.equal(run.unmatched, 2);
  assert.deepEqual(h.stops, [true]);
  assert.equal(h.dms.length, 1);
  assert.match(h.dms[0], /CRITICAL/);
  assert.match(h.dms[0], /ph1 \$42\.00 unmatched/);
  assert.equal(a.paused, true);
  assert.equal(h.charges.filter((c) => c.matched).length, 1);
  assert.equal(h.charges.filter((c) => c.reason === "unmatched").length, 2);
  await assert.rejects(placed(a), /vendor_paused/);
});

Deno.test("a charge over the hard cap trips STOP, pause and one DM; finalCents is not touched", async () => {
  const a = new MockAdapter();
  const o = await placed(a);
  const h = harness(a, [lo(o, o.chargedCents - 1, o.chargedCents - 50)]);
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 0);
  assert.equal(run.overCap, 1);
  assert.equal(h.charges[0].reason, "over_cap");
  assert.equal(h.charges[0].matched, false);
  assert.deepEqual(h.stops, [true]);
  assert.equal(h.dms.length, 1);
  assert.match(h.dms[0], /over_cap/);
  assert.deepEqual(h.finals, []);
  assert.equal(a.paused, true);
});

Deno.test("a row with no usable cap fails closed on anything above what it counts", async () => {
  const a = new MockAdapter();
  const o = await placed(a);
  const h = harness(a, [{ vendorOrderId: o.vendorOrderId, chargedCents: o.chargedCents - 1, hardCapCents: 0 }]);
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 0);
  assert.deepEqual(h.stops, [true]);
});

Deno.test("a second charge against the same order is unmatched", async () => {
  const a = new MockAdapter();
  const o = await placed(a);
  const dup: Charge = { vendorChargeId: "dup", amountCents: o.chargedCents, at: SINCE, vendorOrderId: o.vendorOrderId };
  const real = await a.listCharges(SINCE);
  a.listCharges = () => Promise.resolve([...real, dup]);
  const h = harness(a, [lo(o, o.chargedCents * 3)]); // even when both fit under the cap
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 0);
  assert.equal(run.unmatched, 1);
  assert.deepEqual(h.stops, [true]);
  assert.equal(h.dms.length, 1);
});

Deno.test("a vendor that cannot be checked fails closed without leaking the error", async () => {
  const a = new MockAdapter();
  a.listCharges = () => Promise.reject(new Error("401 https://vendor/api?key=sk-secret"));
  const h = harness(a, []);
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 0);
  assert.deepEqual(h.stops, [true]);
  assert.equal(h.dms.length, 1);
  assert.doesNotMatch(h.dms[0], /secret/);
  assert.match(h.dms[0], /mock could not be checked/);
  assert.equal(a.paused, true);
  assert.deepEqual(h.runs, [run]);
});

Deno.test("failed DM still stops and pauses, error recorded", async () => {
  const a = new MockAdapter({ phantomCharges: [{ vendorChargeId: "ph", amountCents: 1, at: SINCE }] });
  const h = harness(a, []);
  h.deps.notifier.send = () => Promise.resolve({ ok: false, error: "dm_down" });
  const run = await reconcile(h.deps, SINCE);
  assert.deepEqual(h.stops, [true]);
  assert.equal(a.paused, true);
  assert.match(run.error ?? "", /dm_down/);
});
