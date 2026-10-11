// Zinc adapter tests: recorded / doc-derived fixtures and a stubbed fetch. No network.
// The one live test is opt-in (ZINC_SANDBOX_LIVE=1 + a zn_test_ key) and talks only to the sandbox.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { GuardRefused } from "./registry.ts";
import {
  mapZincStatus,
  readZincError,
  ZincAdapter,
  type ZincAdapterOptions,
  ZincError,
  zincFromEnv,
  zincIdempotencyKey,
  zincMaxPrice,
} from "./zinc.ts";

const FX = new URL("./zinc_fixtures/", import.meta.url);
const fx = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, FX)));
const ERR = fx("errors.json");

const OWNER = JSON.stringify({
  first_name: "Example",
  last_name: "Owner",
  address_line1: "101 Example St",
  city: "Exampleville",
  state: "NY",
  postal_code: "10001",
  phone_number: "5555550100",
  country: "US",
});

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  auth?: string;
}
type Reply = { status: number; body?: unknown };

/** Fake fetch: routes are tried in order; the first whose predicate matches answers. */
function stub(routes: [(c: Call) => boolean, Reply | ((c: Call) => Reply)][]) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const c: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: h.get("authorization") ?? undefined,
    };
    calls.push(c);
    const hit = routes.find(([p]) => p(c));
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ code: "not_found" }), { status: 404 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    const body = r.body === undefined ? null : JSON.stringify(r.body);
    return Promise.resolve(new Response(body, { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function adapter(fetchImpl: typeof fetch, extra: Partial<ZincAdapterOptions> = {}) {
  return new ZincAdapter({
    apiKey: "fake_zn_test_key",
    baseUrl: "https://zinc.example",
    ownerShipTo: OWNER,
    taxRate: 0.1,
    fetchImpl,
    ...extra,
  });
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "example-idem-1",
    requester: "test-agent",
    taskId: "example-task",
    vendor: "zinc",
    items: [{ sku: "B00KFP6NHO", qty: 1 }],
    reason: "x".repeat(60),
    reach: "self",
    maxTotalCents: 5_000,
    shipTo: OWNER_HOME,
    ...over,
  };
}

function quoteOf(totalCents: number): Quote {
  return { subtotalCents: 0, taxCents: 0, shippingCents: 0, totalCents, currency: "USD", quotedAt: new Date().toISOString() };
}

const isGet = (frag: string) => (c: Call) => c.method === "GET" && c.url.includes(frag);
const isPost = (frag: string) => (c: Call) => c.method === "POST" && c.url.includes(frag);

// ── quote math ─────────────────────────────────────────────────────────────
Deno.test("quote: cheapest delivered New offer, tax buffer, $1 fee folded into the total", async () => {
  const { calls, fetchImpl } = stub([[isGet("/offers"), { status: 200, body: fx("offers_amazon.json") }]]);
  const q = await adapter(fetchImpl).quote(req({ items: [{ sku: "B00KFP6NHO", qty: 2 }] }));
  // New offers: 799 + 0 ship (wins: 1598) vs 749 + 399 ship (1897); used and unavailable are ignored.
  assertEquals(q.subtotalCents, 1_598);
  assertEquals(q.shippingCents, 0);
  assertEquals(q.taxCents, 160); // round(1598 × 0.10)
  assertEquals(q.totalCents, 1_598 + 160 + 0 + 100);
  assertEquals(calls[0].url, "https://zinc.example/products/B00KFP6NHO/offers?retailer=amazon");
  assertEquals(calls[0].auth, "Bearer fake_zn_test_key");
});

Deno.test("quote: maxUnitCents filters offers; none left → zinc_no_offer", async () => {
  const { fetchImpl } = stub([[isGet("/offers"), { status: 200, body: fx("offers_amazon.json") }]]);
  const a = adapter(fetchImpl);
  const q = await a.quote(req({ items: [{ sku: "B00KFP6NHO", qty: 1, maxUnitCents: 750 }] }));
  assertEquals(q.subtotalCents, 749);
  assertEquals(q.shippingCents, 399);
  const e = await assertRejects(() => a.quote(req({ items: [{ sku: "B00KFP6NHO", qty: 1, maxUnitCents: 100 }] })), ZincError);
  assertEquals(e.code, "zinc_no_offer");
});

Deno.test("quote: metered 402 {detail} maps to insufficient_funds", async () => {
  const { fetchImpl } = stub([[isGet("/offers"), ERR.data_402_detail]]);
  const e = await assertRejects(() => adapter(fetchImpl).quote(req()), ZincError);
  assertEquals(e.code, "insufficient_funds");
});

// ── max_price ceiling ──────────────────────────────────────────────────────
Deno.test("zincMaxPrice: min(hard cap, quote × 1.10) minus the fee; the hold never exceeds the cap", () => {
  assertEquals(zincMaxPrice(5_000, 1_858), 1_943); // floor(2043.8) − 100
  assertEquals(zincMaxPrice(2_000, 1_858), 1_900); // hard cap binds
  for (const [cap, total] of [[6_900, 6_899], [1_000, 999], [500, 10_000], [101, 101]]) {
    const mp = zincMaxPrice(cap, total);
    assert(mp + 100 <= cap, `hold ${mp + 100} > cap ${cap}`);
    assert(mp + 100 <= Math.floor(total * 1.1));
  }
});

Deno.test("place: sends the gate-computed max_price, idempotency key, owner address; charged = hold", async () => {
  const { calls, fetchImpl } = stub([[isPost("/orders"), { status: 201, body: fx("order_pending.json") }]]);
  const o = await adapter(fetchImpl).place(req(), quoteOf(1_858), 5_000, "example-idem-1");
  const body = calls[0].body!;
  assertEquals(body.max_price, 1_943);
  assertEquals(body.idempotency_key, "example-idem-1");
  assertEquals((body.metadata as Record<string, string>).ejb_idempotency_key, "example-idem-1");
  assertEquals(body.products, [{ url: "https://www.amazon.com/dp/B00KFP6NHO", quantity: 1 }]);
  assertEquals((body.shipping_address as Record<string, string>).city, "Exampleville");
  assertEquals(o.vendorOrderId, "00000000-0000-4000-8000-000000000001");
  assertEquals(o.chargedCents, 1_035 + 100); // Zinc's echoed max_price + fee
});

Deno.test("place: long idempotency keys become a stable ≤36-char key", async () => {
  const long = "agent-x:task-y:" + "z".repeat(60);
  const k1 = await zincIdempotencyKey(long);
  assertEquals(k1, await zincIdempotencyKey(long));
  assert(k1.length <= 36);
  assertEquals(await zincIdempotencyKey("short-key"), "short-key");
});

// ── owner address ──────────────────────────────────────────────────────────
Deno.test("place: missing or incomplete owner address refuses before any network call", async () => {
  for (const [owner, code] of [
    [undefined, "zinc_owner_address_missing"],
    ["not json", "zinc_owner_address_invalid_json"],
    [JSON.stringify({ ...JSON.parse(OWNER), city: "" }), "zinc_owner_address_missing_city"],
    [JSON.stringify({ ...JSON.parse(OWNER), address_line1: "  " }), "zinc_owner_address_missing_address_line1"],
    [JSON.stringify({ ...JSON.parse(OWNER), postal_code: "" }), "zinc_owner_address_missing_postal_code"],
    [JSON.stringify({ ...JSON.parse(OWNER), postal_code: "1234" }), "zinc_owner_address_bad_zip"],
    [JSON.stringify({ ...JSON.parse(OWNER), country: "USA" }), "zinc_owner_address_bad_country"],
  ] as const) {
    const { calls, fetchImpl } = stub([]);
    const a = adapter(fetchImpl, { ownerShipTo: owner });
    const e = await assertRejects(() => a.place(req(), quoteOf(1_000), 5_000, "k"), GuardRefused);
    assertEquals(e.code, code);
    assertEquals(calls.length, 0);
  }
});

Deno.test("place: a third-party shipTo, missing key, url/sku mismatch and pause all refuse offline", async () => {
  const { calls, fetchImpl } = stub([]);
  const third = { name: "A Friend", line1: "1 Elsewhere Rd", city: "Town", state: "CA", zip: "94105" };
  const cases: [ZincAdapter, PurchaseRequest, string][] = [
    [adapter(fetchImpl), req({ shipTo: third }), "zinc_third_party_shipto_unsupported"],
    [adapter(fetchImpl, { apiKey: "" }), req(), "zinc_api_key_missing"],
    [adapter(fetchImpl), req({ items: [{ sku: "B00KFP6NHO", qty: 1, url: "https://www.amazon.com/dp/B0OTHER000" }] }), "zinc_url_sku_mismatch"],
    [adapter(fetchImpl, { retailer: "walmart" }), req({ items: [{ sku: "12345", qty: 1 }] }), "zinc_item_url_missing"],
  ];
  for (const [a, r, code] of cases) {
    const e = await assertRejects(() => a.place(r, quoteOf(1_000), 5_000, "k"), GuardRefused);
    assertEquals(e.code, code);
  }
  const p = adapter(fetchImpl);
  await p.pause();
  assertEquals((await assertRejects(() => p.place(req(), quoteOf(1_000), 5_000, "k"), GuardRefused)).code, "vendor_paused");
  assertEquals(calls.length, 0);
});

// ── error mapping ──────────────────────────────────────────────────────────
Deno.test("readZincError: nested, flat and {detail} shapes", () => {
  assertEquals(readZincError(402, ERR.insufficient_funds_nested.body).code, "insufficient_funds");
  assertEquals(readZincError(400, ERR.invalid_address_flat.body).code, "invalid_shipping_address");
  assertEquals(readZincError(402, ERR.data_402_detail.body).code, "insufficient_funds");
  assertEquals(readZincError(503, undefined).code, "zinc_server_error");
});

Deno.test("place: definite rejections (no order created) are GuardRefused with a clear code", async () => {
  for (const r of [ERR.insufficient_funds_nested, ERR.invalid_address_flat]) {
    const { fetchImpl } = stub([[isPost("/orders"), r]]);
    const e = await assertRejects(() => adapter(fetchImpl).place(req(), quoteOf(1_000), 5_000, "k"), GuardRefused);
    assertEquals(e.code, r.body.error?.code ?? r.body.code);
  }
});

Deno.test("place: 5xx and network errors stay ZincError (money may have moved → outcome_unknown)", async () => {
  const { fetchImpl } = stub([[isPost("/orders"), ERR.server_error]]);
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), quoteOf(1_000), 5_000, "k"), ZincError);
  assertEquals(e.code, "external_service_error");
  const boom = (() => Promise.reject(new TypeError("connection reset"))) as typeof fetch;
  const e2 = await assertRejects(() => adapter(boom).place(req(), quoteOf(1_000), 5_000, "k"), ZincError);
  assertEquals(e2.code, "zinc_network_error");
});

Deno.test("place: already_exists is success; the order is recovered by its metadata key", async () => {
  const { calls, fetchImpl } = stub([
    [isPost("/orders"), ERR.already_exists_flat],
    [isGet("metadata_key=ejb_idempotency_key"), { status: 200, body: { orders: [fx("order_pending.json")], total: 1, limit: 2, offset: 0 } }],
  ]);
  const o = await adapter(fetchImpl).place(req(), quoteOf(1_000), 5_000, "example-idem-1");
  assertEquals(o.vendorOrderId, "00000000-0000-4000-8000-000000000001");
  assert(calls[1].url.includes("metadata_value=example-idem-1"));
});

Deno.test("status: max_price_exceeded arrives async as order_failed → cancelled with the error_type", async () => {
  const { fetchImpl } = stub([[isGet("/orders/"), { status: 200, body: fx("order_failed_max_price.json") }]]);
  const s = await adapter(fetchImpl).status("00000000-0000-4000-8000-000000000002");
  assertEquals(s.state, "cancelled");
  assertEquals((s.raw as { error_type: string }).error_type, "max_price_exceeded");
});

// ── reach ──────────────────────────────────────────────────────────────────
Deno.test("reach: self only for the owner's home; others for any other address", () => {
  const a = adapter(stub([]).fetchImpl);
  assertEquals(a.maxReach, "others");
  assertEquals(a.reachFor(req()), "self");
  assertEquals(a.reachFor(req({ shipTo: undefined })), "self");
  assertEquals(a.reachFor(req({ shipTo: { name: "N", line1: "L", city: "C", state: "NY", zip: "10001" } })), "others");
});

// ── status mapping ─────────────────────────────────────────────────────────
Deno.test("status: Zinc statuses and tracking map to open / shipped / delivered / cancelled", async () => {
  const t = (...s: string[]) => s.map((status) => ({ tracking_number: "T", status }));
  assertEquals(mapZincStatus({ status: "pending" }), "open");
  assertEquals(mapZincStatus({ status: "in_progress" }), "open");
  assertEquals(mapZincStatus({ status: "order_placed", tracking_numbers: [] }), "open");
  assertEquals(mapZincStatus({ status: "order_placed", tracking_numbers: t("pending") }), "open");
  assertEquals(mapZincStatus({ status: "order_placed", tracking_numbers: t("in_transit") }), "shipped");
  assertEquals(mapZincStatus({ status: "order_placed", tracking_numbers: t("delivered", "in_transit") }), "shipped");
  assertEquals(mapZincStatus({ status: "order_placed", tracking_numbers: t("delivered", "delivered") }), "delivered");
  for (const s of ["order_failed", "cancelled", "cancelled_by_retailer"]) assertEquals(mapZincStatus({ status: s }), "cancelled");

  const { fetchImpl } = stub([[isGet("/orders/"), { status: 200, body: fx("order_in_transit.json") }]]);
  const st = await adapter(fetchImpl).status("00000000-0000-4000-8000-000000000001");
  assertEquals(st.state, "shipped");
  assertEquals(st.tracking, "ZINC_TEST_123456789");
});

Deno.test("cancel: 204 → true, order_not_cancellable → false", async () => {
  const ok = stub([[isPost("/cancel"), { status: 204 }]]);
  assertEquals(await adapter(ok.fetchImpl).cancel("00000000-0000-4000-8000-000000000001"), true);
  const no = stub([[isPost("/cancel"), ERR.not_cancellable_flat]]);
  assertEquals(await adapter(no.fetchImpl).cancel("00000000-0000-4000-8000-000000000001"), false);
});

// ── listCharges ────────────────────────────────────────────────────────────
Deno.test("listCharges: one hold-sized charge per non-refunded order since the cutoff", async () => {
  const { calls, fetchImpl } = stub([[isGet("/orders?"), { status: 200, body: fx("orders_list.json") }]]);
  const charges = await adapter(fetchImpl).listCharges("2026-10-11T00:00:00Z");
  assertEquals(charges, [
    { vendorChargeId: "00000000-0000-4000-8000-000000000001", amountCents: 1_135, at: "2026-10-11T15:00:00.000Z", vendorOrderId: "00000000-0000-4000-8000-000000000001" },
    { vendorChargeId: "00000000-0000-4000-8000-000000000003", amountCents: 2_600, at: "2026-10-11T16:00:00.000Z", vendorOrderId: "00000000-0000-4000-8000-000000000003" },
  ]);
  assert(calls[0].url.includes("created_after=2026-10-11T00%3A00%3A00Z"));
});

Deno.test("listCharges: amounts equal what place() recorded, so reconcile matches", async () => {
  const placed = stub([[isPost("/orders"), { status: 201, body: fx("order_pending.json") }]]);
  const o = await adapter(placed.fetchImpl).place(req(), quoteOf(1_858), 5_000, "example-idem-1");
  const listed = stub([[isGet("/orders?"), { status: 200, body: fx("orders_list.json") }]]);
  const c = (await adapter(listed.fetchImpl).listCharges("2026-10-11T00:00:00Z")).find((x) => x.vendorOrderId === o.vendorOrderId);
  assertEquals(c?.amountCents, o.chargedCents);
});

// ── config ─────────────────────────────────────────────────────────────────
Deno.test("zincFromEnv: defaults and https-only base URL", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  const a = zincFromEnv(env({}));
  assertEquals(a.retailer, "amazon");
  assertEquals(a.feeCents, 100);
  let threw = false;
  try {
    zincFromEnv(env({ ZINC_BASE_URL: "http://api.zinc.example" }));
  } catch {
    threw = true;
  }
  assert(threw);
});

// ── opt-in live sandbox run ────────────────────────────────────────────────
const LIVE = Deno.env.get("ZINC_SANDBOX_LIVE") === "1";
Deno.test({
  name: "LIVE sandbox: quote → place → status → cancel (zn_test_ key only)",
  ignore: !LIVE,
  async fn() {
    const key = Deno.env.get("ZINC_API_KEY") ?? "";
    assert(key.startsWith("zn_test_"), "the live test runs only with a sandbox key");
    // The docs' own sandbox address (https://www.zinc.com/docs/v2/agent-sandbox/quickstart).
    const ownerShipTo = JSON.stringify({
      first_name: "Sandbox", last_name: "Agent", address_line1: "101 Market St", city: "San Francisco",
      state: "CA", postal_code: "94105", phone_number: "4155552671", country: "US",
    });
    const baseUrl = Deno.env.get("ZINC_BASE_URL");
    const a = new ZincAdapter({ apiKey: key, baseUrl, ownerShipTo });
    assert(a.isSandbox);
    let q: Quote;
    try {
      q = await a.quote(req());
      console.log(`live quote total=${q.totalCents}`);
    } catch (e) {
      console.log(`live quote failed (${(e as Error).message}); using a synthetic quote`);
      q = quoteOf(2_000);
    }
    const sku = "test-success";
    const r = req({
      idempotencyKey: crypto.randomUUID(),
      items: [{ sku, qty: 1, url: `https://zinc.com/shop/products/${sku}` }],
    });
    // Zinc's rehearsal product lives at a zinc.com URL, so order it with a non-amazon retailer slug.
    const z = new ZincAdapter({ apiKey: key, baseUrl, retailer: "zinc", ownerShipTo });
    const o = await z.place(r, quoteOf(Math.min(q.totalCents, 2_000)), 2_500, r.idempotencyKey);
    console.log(`live place ok charged=${o.chargedCents}`);
    const again = await z.place(r, quoteOf(Math.min(q.totalCents, 2_000)), 2_500, r.idempotencyKey);
    assertEquals(again.vendorOrderId, o.vendorOrderId); // idempotent retry
    const s1 = await z.status(o.vendorOrderId);
    console.log(`live status=${s1.state} raw=${JSON.stringify(s1.raw)}`);
    const cancelled = await z.cancel(o.vendorOrderId);
    console.log(`live cancel=${cancelled}`);
    assertEquals(typeof cancelled, "boolean");
    await new Promise((res) => setTimeout(res, 6_000));
    const s2 = await z.status(o.vendorOrderId);
    console.log(`live status after 6s=${s2.state} tracking=${s2.tracking ? "yes" : "no"}`);
    const charges = await z.listCharges(new Date(Date.now() - 3600_000).toISOString());
    console.log(`live listCharges n=${charges.length}`);
  },
});
