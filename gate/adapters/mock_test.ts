import { strict as assert } from "node:assert";
import type { PurchaseRequest, VendorAdapter } from "../types.ts";
import { MockAdapter } from "./mock.ts";
import { buildRegistry, GuardRefused, guarded, knownVendors, VENDOR_HOSTS, vendorHosts } from "./registry.ts";

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "k1",
    requester: "test",
    taskId: "t1",
    vendor: "mock",
    items: [{ sku: "resistor-10k", qty: 2 }],
    reason: "test",
    reach: "self",
    maxTotalCents: 10_000,
    ...over,
  };
}

Deno.test("pricing is deterministic and overridable", async () => {
  const a = new MockAdapter();
  const b = new MockAdapter();
  const qa = await a.quote(req());
  const qb = await b.quote(req());
  assert.equal(qa.totalCents, qb.totalCents);
  assert.equal(qa.subtotalCents, a.unitPriceCents("resistor-10k") * 2);
  assert.ok(a.unitPriceCents("x") >= 100 && a.unitPriceCents("x") < 10_000);

  const c = new MockAdapter({ prices: { widget: 1_000 } });
  const small = await c.quote(req({ items: [{ sku: "widget", qty: 1 }] }));
  assert.deepEqual(
    [small.subtotalCents, small.taxCents, small.shippingCents, small.totalCents],
    [1_000, 80, 599, 1_679],
  );
  const big = await c.quote(req({ items: [{ sku: "widget", qty: 4 }] }));
  assert.equal(big.shippingCents, 0); // free at >= $35
  assert.equal(big.totalCents, 4_000 + 320);
  // configurable tax rate
  const noTax = new MockAdapter({ prices: { widget: 1_000 }, taxRate: 0 });
  assert.equal((await noTax.quote(req({ items: [{ sku: "widget", qty: 1 }] }))).totalCents, 1_599);
  assert.throws(() => new MockAdapter({ taxRate: 1.5 }));
});

Deno.test("hard cap rejects place-time price drift", async () => {
  const drift = new MockAdapter({ priceDriftPct: 10 });
  const q = await drift.quote(req());
  await assert.rejects(drift.place(req(), q, q.totalCents, "k1"), /max_price_exceeded/);

  const steady = new MockAdapter();
  const q2 = await steady.quote(req());
  const o = await steady.place(req(), q2, q2.totalCents, "k1");
  assert.equal(o.chargedCents, q2.totalCents);
  // same idempotency key returns the same order
  assert.deepEqual(await steady.place(req(), q2, q2.totalCents, "k1"), o);
});

Deno.test("scripted failures", async () => {
  const a = new MockAdapter({ failPlaceWith: "declined" });
  const q = await a.quote(req());
  await assert.rejects(a.place(req(), q, q.totalCents, "k"), /declined/);
});

Deno.test("paused adapter refuses to place", async () => {
  const a = new MockAdapter();
  const q = await a.quote(req());
  await a.pause();
  await assert.rejects(a.place(req(), q, 1_000_000, "k"), /vendor_paused/);
});

Deno.test("reachFor", () => {
  const a = new MockAdapter();
  assert.equal(a.reachFor(req()), "self");
  assert.equal(a.reachFor(req({ shipTo: "owner-home" })), "self");
  assert.equal(a.reachFor(req({ category: "tree" })), "world");
  assert.equal(a.reachFor(req({ category: "telescope" })), "world");
  const away = { name: "A", line1: "1 Main", city: "Beacon", state: "NY", zip: "12508" };
  assert.equal(a.reachFor(req({ shipTo: away })), "others");
  assert.equal(a.reachFor(req({ shipTo: away, category: "tree" })), "others");
});

Deno.test("status advances and listCharges includes orders plus phantoms", async () => {
  const phantom = { vendorChargeId: "ph1", amountCents: 999, at: "2026-10-01T00:00:00Z" };
  const a = new MockAdapter({ phantomCharges: [phantom] });
  const q = await a.quote(req());
  const o = await a.place(req(), q, q.totalCents, "k");
  assert.equal((await a.status(o.vendorOrderId)).state, "open");
  assert.equal((await a.status(o.vendorOrderId)).state, "shipped");
  assert.equal((await a.status(o.vendorOrderId)).state, "delivered");
  assert.equal((await a.status(o.vendorOrderId)).state, "delivered");
  assert.equal(await a.cancel(o.vendorOrderId), false);

  const charges = await a.listCharges("2000-01-01T00:00:00Z");
  assert.equal(charges.length, 2);
  assert.ok(charges.some((c) => c.vendorOrderId === o.vendorOrderId && c.amountCents === q.totalCents));
  assert.equal((await a.listCharges("2099-01-01T00:00:00Z")).length, 0);
});

const OPEN = { isStopped: () => false, dryRun: false };

Deno.test("VENDOR_HOSTS covers exactly the registered vendors; vendorHosts dedupes and refuses unknowns", () => {
  assert.deepEqual(Object.keys(VENDOR_HOSTS).sort(), knownVendors().sort());
  for (const hosts of Object.values(VENDOR_HOSTS)) {
    for (const h of hosts) assert.match(h, /^[a-z0-9.-]+$/); // install.sh's --allow-net host check
  }
  assert.deepEqual(vendorHosts(["mock", "zinc", "lulu", "zinc"]), ["api.zinc.com", "api.lulu.com", "api.sandbox.lulu.com"]);
  assert.deepEqual(vendorHosts(["mock"]), []);
  assert.throws(() => vendorHosts(["nope"]), /unknown vendor/);
});

Deno.test("registry is a closed allowlist and hands out only guarded adapters", () => {
  assert.deepEqual(knownVendors(), [
    "mock",
    "zinc",
    "treenation",
    "skyfi",
    "stannp",
    "lulu",
    "slant3d",
    "prodigi",
    "mouser",
    "lob",
    "oshpark",
  ]);
  const reg = buildRegistry(["mock"], OPEN);
  assert.deepEqual(Object.keys(reg), ["mock"]);
  assert.equal(reg.mock.guarded, true);
  assert.throws(() => buildRegistry(["amazon"], OPEN), /unknown vendor/);
});

/** An adapter that skips every check, to prove the guard holds anyway. */
function careless(): VendorAdapter & { placed: number } {
  const a = new MockAdapter();
  return {
    id: "mock", maxReach: "others", placed: 0,
    reachFor: () => "self",
    quote: (r) => a.quote(r),
    place(_r, q) {
      this.placed++;
      return Promise.resolve({ vendorOrderId: "x1", chargedCents: q.totalCents });
    },
    status: (id) => a.status(id), cancel: (id) => a.cancel(id), listCharges: (s) => a.listCharges(s),
    pause: () => Promise.resolve(),
  };
}

Deno.test("guarded(): hard cap, pause, STOP, DRY_RUN and reach floor hold for a careless adapter", async () => {
  let stopped = false;
  const inner = careless();
  const g = guarded(inner, { isStopped: () => stopped, dryRun: false, worldCategories: ["tree"] });
  const q = await g.quote(req());
  await assert.rejects(g.place(req(), q, q.totalCents - 1, "k"), (e: Error) => e instanceof GuardRefused && e.message === "max_price_exceeded");
  await assert.rejects(g.place(req(), q, 0, "k"), GuardRefused);
  stopped = true;
  await assert.rejects(g.place(req(), q, q.totalCents, "k"), /stopped/);
  stopped = false;
  await g.pause();
  await assert.rejects(g.place(req(), q, q.totalCents, "k"), /vendor_paused/);
  g.resume();
  assert.equal((await g.place(req(), q, q.totalCents, "k")).vendorOrderId, "x1");
  assert.equal(inner.placed, 1, "only the one allowed call reached the vendor");
  // isStopped throwing fails closed
  const g2 = guarded(careless(), { isStopped: () => { throw new Error("db"); }, dryRun: false });
  await assert.rejects(g2.place(req(), q, q.totalCents, "k"), /stopped/);
  // DRY_RUN refuses non-simulated adapters, allows the mock
  const g3 = guarded(careless(), { isStopped: () => false, dryRun: true });
  await assert.rejects(g3.place(req(), q, q.totalCents, "k"), /dry_run/);
  const gm = guarded(new MockAdapter(), { isStopped: () => false, dryRun: true });
  const qm = await gm.quote(req());
  assert.ok((await gm.place(req(), qm, qm.totalCents, "k")).vendorOrderId);
  // reach floor: the careless adapter says "self" for everything
  const away = { name: "A", line1: "1 Main", city: "X", state: "NY", zip: "10001" };
  assert.equal(g.reachFor(req({ shipTo: away })), "others");
  assert.equal(g.reachFor(req({ category: "tree" })), "world");
  assert.equal(g.reachFor(req({ shipTo: "owner-home" })), "self");
  // guarding twice is a no-op
  assert.equal(guarded(g, OPEN), g);
});
