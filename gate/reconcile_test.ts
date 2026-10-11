import { strict as assert } from "node:assert";
import type { Charge, DmResult, PurchaseRequest } from "./types.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { type ChargeRecord, type LedgerOrder, reconcile, type RunRecord } from "./reconcile.ts";

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
  return {
    charges,
    runs,
    dms,
    stops,
    deps: {
      adapters: [adapter],
      listOrders: (vendor: string) => (vendor === adapter.id ? ledger : []),
      recordCharge: (c: ChargeRecord) => void charges.push(c),
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
  const h = harness(a, [{ vendorOrderId: o.vendorOrderId, chargedCents: o.chargedCents + 1 }]); // 1c tolerance
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 1);
  assert.deepEqual(h.runs, [run]);
  assert.equal(h.charges.length, 1);
  assert.equal(h.charges[0].matched, true);
  assert.equal(h.charges[0].reason, undefined);
  assert.deepEqual(h.stops, []);
  assert.deepEqual(h.dms, []);
  assert.equal(a.paused, false);
});

Deno.test("phantom charge trips STOP, pause and exactly one DM", async () => {
  const phantoms: Charge[] = [
    { vendorChargeId: "ph1", amountCents: 4_200, at: "2026-10-10T00:00:00Z" },
    { vendorChargeId: "ph2", amountCents: 100, at: "2026-10-10T01:00:00Z", vendorOrderId: "nope" },
  ];
  const a = new MockAdapter({ phantomCharges: phantoms });
  const o = await placed(a);
  const h = harness(a, [o]);
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

Deno.test("amount mismatch over 1 cent trips", async () => {
  const a = new MockAdapter();
  const o = await placed(a);
  const h = harness(a, [{ vendorOrderId: o.vendorOrderId, chargedCents: o.chargedCents - 2 }]);
  const run = await reconcile(h.deps, SINCE);
  assert.equal(run.ok, 0);
  assert.equal(run.mismatched, 1);
  assert.equal(h.charges[0].reason, "amount_mismatch");
  assert.deepEqual(h.stops, [true]);
  assert.equal(h.dms.length, 1);
  assert.equal(a.paused, true);
});

Deno.test("a second charge against the same order is unmatched", async () => {
  const a = new MockAdapter();
  const o = await placed(a);
  const dup: Charge = { vendorChargeId: "dup", amountCents: o.chargedCents, at: SINCE, vendorOrderId: o.vendorOrderId };
  const real = await a.listCharges(SINCE);
  a.listCharges = () => Promise.resolve([...real, dup]);
  const h = harness(a, [o]);
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
