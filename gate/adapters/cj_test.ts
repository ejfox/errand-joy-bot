// CJdropshipping adapter tests: doc-shaped fixtures and a stubbed fetch. No network.
// The one live test is opt-in (CJ_LIVE=1 + CJ_API_KEY + CJ_LIVE_SKU) and only ever makes
// sandbox orders (isSandbox=1, simulated payment).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { GuardRefused } from "./registry.ts";
import {
  CjAdapter,
  type CjAdapterOptions,
  cjDutyEstimateCents,
  CjError,
  cjFromEnv,
  cjOrderNumber,
  cjSourcingRequest,
  mapCjStatus,
  parseCjSku,
  priceFreightLine,
} from "./cj.ts";

const FX = new URL("./cj_fixtures/", import.meta.url);
const fx = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, FX)));
const TOKEN = fx("token.json");
const VARIANT = fx("variant.json");
const FREIGHT = fx("freight.json");
const ORD = fx("orders.json");
const W = fx("wallet_errors.json");

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
  token?: string;
}
type Reply = { status: number; body?: unknown };
type Route = [(c: Call) => boolean, Reply | ((c: Call) => Reply)];

/** Fake fetch: routes are tried in order; the token endpoints answer by default after them. */
function stub(routes: Route[]) {
  const calls: Call[] = [];
  const all: Route[] = [
    ...routes,
    [(c) => c.url.endsWith("/authentication/getAccessToken"), { status: 200, body: TOKEN }],
    [(c) => c.url.endsWith("/authentication/refreshAccessToken"), { status: 200, body: TOKEN }],
  ];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const c: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      token: h.get("cj-access-token") ?? undefined,
    };
    calls.push(c);
    const hit = all.find(([p]) => p(c));
    if (!hit) return Promise.resolve(new Response(JSON.stringify(W.param_error), { status: 200 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    return Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status }));
  }) as typeof fetch;
  return { calls, fetchImpl, biz: () => calls.filter((c) => !c.url.includes("/authentication/")) };
}

function adapter(fetchImpl: typeof fetch, extra: Partial<CjAdapterOptions> = {}) {
  return new CjAdapter({
    apiKey: "example@api@fake-key",
    baseUrl: "https://cj.example/api2.0/v1",
    ownerShipTo: OWNER,
    minIntervalMs: 0,
    fetchImpl,
    ...extra,
  });
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "example-idem-1",
    requester: "test-agent",
    taskId: "example-task",
    vendor: "cj",
    items: [{ sku: "fake-pid-0001:fake-vid-0001", qty: 2 }],
    reason: "x".repeat(60),
    reach: "self",
    maxTotalCents: 6_000,
    shipTo: OWNER_HOME,
    ...over,
  };
}

const get = (frag: string) => (c: Call) => c.method === "GET" && c.url.includes(frag);
const post = (frag: string) => (c: Call) => c.method === "POST" && c.url.includes(frag);
const del = (frag: string) => (c: Call) => c.method === "DELETE" && c.url.includes(frag);
const ok = (body: unknown): Reply => ({ status: 200, body });

const quoteRoutes = (freight = FREIGHT.ddp_and_not): Route[] => [
  [get("/product/variant/queryByVid"), ok(VARIANT)],
  [post("/logistic/freightCalculate"), ok(freight)],
];

async function goodQuote(): Promise<Quote> {
  const { fetchImpl } = stub(quoteRoutes());
  return await adapter(fetchImpl).quote(req());
}

/** Routes for a full place(): create → detail (created, then paid) → balance → pay. */
function placeRoutes(over: { detailFirst?: unknown; balance?: unknown; pay?: Reply; create?: Reply } = {}): Route[] {
  let detailCalls = 0;
  return [
    [post("/shopping/order/createOrderV2"), over.create ?? ok(ORD.create)],
    [get("/shopping/order/getOrderDetail"), () => ok(detailCalls++ === 0 ? (over.detailFirst ?? ORD.detail_created) : ORD.detail_paid)],
    [get("/shopping/pay/getBalance"), ok(over.balance ?? W.balance)],
    [post("/shopping/pay/payBalance"), over.pay ?? ok(W.pay_ok)],
    [del("/shopping/order/deleteOrder"), ok(W.delete_ok)],
  ];
}

// ── pure helpers ───────────────────────────────────────────────────────────
Deno.test("parseCjSku: bare vid or pid:vid; junk refused", () => {
  assertEquals(parseCjSku("fake-vid-0001"), { vid: "fake-vid-0001" });
  assertEquals(parseCjSku("fake-pid-0001:fake-vid-0001"), { pid: "fake-pid-0001", vid: "fake-vid-0001" });
  for (const bad of ["", "a:b:c", "has space", "x/../y", "a:"]) {
    assertEquals((() => {
      try {
        parseCjSku(bad);
        return "accepted";
      } catch (e) {
        return (e as CjError).code;
      }
    })(), "cj_bad_sku", bad);
  }
});

Deno.test("cjOrderNumber: the gate key when it fits 50 chars, else a stable ejb- hash", async () => {
  assertEquals(await cjOrderNumber("example-idem-1"), "example-idem-1");
  const long = "k".repeat(80);
  const a = await cjOrderNumber(long);
  assertEquals(a, await cjOrderNumber(long));
  assert(a.startsWith("ejb-") && a.length === 36);
  assert((await cjOrderNumber("has spaces in it")).startsWith("ejb-"));
});

Deno.test("cjDutyEstimateCents: 40% of goods + shipping, plus $3", () => {
  assertEquals(cjDutyEstimateCents(2_971), 1_488);
  assertEquals(cjDutyEstimateCents(1_000, 0.55, 300), 850);
});

Deno.test("priceFreightLine: DDP needs a positive taxesFee; an unitemized totalPostageFee part is counted", () => {
  assertEquals(priceFreightLine({ logisticPrice: 4.71, taxesFee: 7.2, clearanceOperationFee: 0.5, totalPostageFee: 12.41 }, true), {
    ok: true,
    shippingCents: 471,
    taxCents: 720,
    feeCents: 50,
  });
  assertEquals(priceFreightLine({ logisticPrice: 4.71 }, true), { ok: false, reason: "not_ddp" });
  assertEquals(priceFreightLine({ logisticPrice: 4.71, taxesFee: 0 }, true), { ok: false, reason: "not_ddp" });
  assertEquals(priceFreightLine({ logisticPrice: 4.71 }, false), { ok: true, shippingCents: 471, taxCents: 0, feeCents: 0 });
  // CJ's total is $1 higher than the itemized parts: the extra $1 lands in the fee.
  assertEquals(priceFreightLine({ logisticPrice: 1, taxesFee: 2, clearanceOperationFee: 0.5, totalPostageFee: 4.5 }, true), {
    ok: true,
    shippingCents: 100,
    taxCents: 200,
    feeCents: 150,
  });
});

Deno.test("mapCjStatus covers the documented order statuses", () => {
  for (const s of ["CREATED", "IN_CART", "UNPAID", "UNSHIPPED", "PENDING", "PROCESSING", undefined]) assertEquals(mapCjStatus(s), "open");
  assertEquals(mapCjStatus("SHIPPED"), "shipped");
  assertEquals(mapCjStatus("DELIVERED"), "delivered");
  assertEquals(mapCjStatus("CANCELLED"), "cancelled");
});

// ── auth ───────────────────────────────────────────────────────────────────
Deno.test("auth: token minted once from the API key, cached, sent as CJ-Access-Token", async () => {
  const { calls, fetchImpl } = stub(quoteRoutes());
  const a = adapter(fetchImpl);
  await a.quote(req());
  await a.quote(req());
  const mints = calls.filter((c) => c.url.endsWith("/authentication/getAccessToken"));
  assertEquals(mints.length, 1);
  assertEquals(mints[0].body, { apiKey: "example@api@fake-key" });
  for (const c of calls.filter((c) => !c.url.includes("/authentication/"))) assertEquals(c.token, "fake-cj-access-token-0001");
});

Deno.test("auth: a bad-token answer re-mints once and retries; the token never appears in errors", async () => {
  let n = 0;
  const { calls, fetchImpl } = stub([
    [get("/product/variant/queryByVid"), () => n++ === 0 ? ok(W.bad_token) : ok(VARIANT)],
    [post("/logistic/freightCalculate"), ok(FREIGHT.ddp_and_not)],
  ]);
  const q = await adapter(fetchImpl).quote(req());
  assertEquals(q.totalCents, 3_741);
  assertEquals(calls.filter((c) => c.url.endsWith("/getAccessToken")).length, 2);

  const bad = stub([[get("/product/variant/queryByVid"), ok(W.bad_token)]]);
  const e = await assertRejects(() => adapter(bad.fetchImpl).quote(req()), CjError);
  assertEquals(e.code, "cj_1600001");
  assert(!e.message.includes("fake-cj-access-token"));
});

Deno.test("auth: an expired access token is refreshed with the refresh token", async () => {
  let now = Date.parse("2026-10-11T00:00:00Z");
  const soon = {
    ...TOKEN,
    data: { ...TOKEN.data, accessTokenExpiryDate: "2026-10-12T12:00:00Z", refreshTokenExpiryDate: "2027-04-01T00:00:00Z" },
  };
  const { calls, fetchImpl } = stub([
    [(c) => c.url.endsWith("/getAccessToken"), ok(soon)],
    ...quoteRoutes(),
  ]);
  const a = adapter(fetchImpl, { now: () => now });
  await a.quote(req());
  now += 2 * 24 * 3600_000; // past the access token's expiry
  await a.quote(req());
  assertEquals(calls.filter((c) => c.url.endsWith("/getAccessToken")).length, 1);
  assertEquals(calls.filter((c) => c.url.endsWith("/refreshAccessToken")).length, 1);
});

Deno.test("auth: missing key → cj_api_key_missing, no network", async () => {
  const { calls, fetchImpl } = stub([]);
  const e = await assertRejects(() => adapter(fetchImpl, { apiKey: "" }).quote(req()), CjError);
  assertEquals(e.code, "cj_api_key_missing");
  assertEquals(calls.length, 0);
});

// ── quote ──────────────────────────────────────────────────────────────────
Deno.test("quote: goods + cheapest DDP line; duties and clearance itemized; parts sum to the total", async () => {
  const { biz, fetchImpl } = stub(quoteRoutes());
  const q = await adapter(fetchImpl).quote(req());
  assertEquals(q.subtotalCents, 2_500); // 2 × $12.50
  assertEquals(q.shippingCents, 471); // "Example DDP Line", not the cheaper non-DDP postal line
  assertEquals(q.taxCents, 720);
  assertEquals(q.feeCents, 50);
  assertEquals(q.totalCents, 2_500 + 471 + 720 + 50);
  assertEquals(q.vendorRef, "cj:Example DDP Line");
  const raw = q.raw as Record<string, unknown>;
  assertEquals(raw.logisticName, "Example DDP Line");
  assertEquals(raw.ddp, true);
  assertEquals(raw.sandbox, true);
  const [v, f] = biz();
  assert(v.url.includes("vid=fake-vid-0001") && v.url.includes("features=enable_inventory"));
  assertEquals(f.body, { startCountryCode: "CN", endCountryCode: "US", zip: "10001", products: [{ vid: "fake-vid-0001", quantity: 2 }] });
});

Deno.test("quote: no line carries US taxes → cj_not_ddp", async () => {
  const { fetchImpl } = stub(quoteRoutes(FREIGHT.none_ddp));
  const e = await assertRejects(() => adapter(fetchImpl).quote(req()), CjError);
  assertEquals(e.code, "cj_not_ddp");
});

Deno.test("quote: CJ duties under half the fallback estimate → cj_duty_suspicious", async () => {
  const { fetchImpl } = stub(quoteRoutes(FREIGHT.low_duty));
  const e = await assertRejects(() => adapter(fetchImpl).quote(req()), CjError);
  assertEquals(e.code, "cj_duty_suspicious");
  // A lower configured rate accepts the same line.
  const ok2 = stub(quoteRoutes(FREIGHT.low_duty));
  const q = await adapter(ok2.fetchImpl, { dutyRate: 0.01, dutyFlatCents: 0 }).quote(req());
  assertEquals(q.taxCents + (q.feeCents ?? 0), 110);
});

Deno.test("quote: CJ_LOGISTIC_NAME pins a line; it still has to be DDP", async () => {
  const a = stub(quoteRoutes());
  const q = await adapter(a.fetchImpl, { logisticName: "Example DDP Express" }).quote(req());
  assertEquals(q.shippingCents, 990);
  const b = stub(quoteRoutes());
  const e = await assertRejects(() => adapter(b.fetchImpl, { logisticName: "Example Postal (no tax)" }).quote(req()), CjError);
  assertEquals(e.code, "cj_not_ddp");
});

Deno.test("quote: pid mismatch, maxUnitCents, stock, item/qty limits, third-party shipTo", async () => {
  const s = () => stub(quoteRoutes()).fetchImpl;
  const code = async (r: PurchaseRequest) => (await assertRejects(() => adapter(s()).quote(r), CjError)).code;
  assertEquals(await code(req({ items: [{ sku: "other-pid:fake-vid-0001", qty: 1 }] })), "cj_sku_pid_mismatch");
  assertEquals(await code(req({ items: [{ sku: "fake-vid-0001", qty: 1, maxUnitCents: 1_000 }] })), "cj_over_max_unit");
  assertEquals(await code(req({ items: [{ sku: "fake-vid-0001", qty: 0 }] })), "cj_bad_qty");
  assertEquals(await code(req({ items: [] })), "cj_no_items");
  assertEquals(await code(req({ shipTo: { name: "X", line1: "1 St", city: "C", state: "NY", zip: "10001" } })), "cj_third_party_shipto_unsupported");
  const usOnly = stub(quoteRoutes());
  const e = await assertRejects(() => adapter(usOnly.fetchImpl, { fromCountry: "TH" }).quote(req()), CjError);
  assertEquals(e.code, "cj_no_stock_at_origin");
});

Deno.test("quote: a US-warehouse origin needs no DDP line (domestic, no import duty)", async () => {
  const usVariant = { ...VARIANT, data: { ...VARIANT.data, inventories: [{ countryCode: "US", totalInventory: 9 }] } };
  const { fetchImpl } = stub([
    [get("/product/variant/queryByVid"), ok(usVariant)],
    [post("/logistic/freightCalculate"), ok(FREIGHT.none_ddp)],
  ]);
  const q = await adapter(fetchImpl, { fromCountry: "US" }).quote(req());
  assertEquals([q.taxCents, q.feeCents, q.shippingCents], [0, 0, 471]);
  assertEquals((q.raw as { ddp: boolean }).ddp, false);
});

Deno.test("quote: rate limit codes map to rate_limit_exceeded", async () => {
  const { fetchImpl } = stub([[get("/product/variant/queryByVid"), ok(W.rate_limited)]]);
  const e = await assertRejects(() => adapter(fetchImpl).quote(req()), CjError);
  assertEquals(e.code, "rate_limit_exceeded");
});

// ── place ──────────────────────────────────────────────────────────────────
Deno.test("place: create unpaid (payType 3, sandbox) → re-read → balance → pay → confirm", async () => {
  const q = await goodQuote();
  const { biz, fetchImpl } = stub(placeRoutes());
  const o = await adapter(fetchImpl).place(req(), q, 6_000, "example-idem-1");
  assertEquals(o.vendorOrderId, "fake-order-0001");
  assertEquals(o.chargedCents, 3_741);
  const order = biz().map((c) => `${c.method} ${new URL(c.url).pathname.replace("/api2.0/v1", "")}`);
  assertEquals(order, [
    "POST /shopping/order/createOrderV2",
    "GET /shopping/order/getOrderDetail",
    "GET /shopping/pay/getBalance",
    "POST /shopping/pay/payBalanceV2",
    "GET /shopping/order/getOrderDetail",
  ]);
  const create = biz()[0].body!;
  assertEquals(create.payType, 3);
  assertEquals(create.isSandbox, 1);
  assertEquals(create.orderNumber, "example-idem-1");
  assertEquals(create.logisticName, "Example DDP Line");
  assertEquals(create.fromCountryCode, "CN");
  assertEquals(create.shippingCountryCode, "US");
  assertEquals(create.shippingZip, "10001");
  assertEquals(create.products, [{ vid: "fake-vid-0001", quantity: 2 }]);
  assertEquals(biz()[3].body, { shipmentOrderId: "fake-shipment-0001" });
});

Deno.test("place: no shipmentOrderId from create (CJ's own example) → payBalance {orderId}", async () => {
  const q = await goodQuote();
  const noShipment = { ...ORD.create, data: { ...ORD.create.data, shipmentOrderId: "" } };
  const { biz, fetchImpl } = stub(placeRoutes({ create: ok(noShipment) }));
  const o = await adapter(fetchImpl).place(req(), q, 6_000, "example-idem-1");
  assertEquals(o.vendorOrderId, "fake-order-0001");
  const pay = biz().filter((c) => c.url.includes("/shopping/pay/payBalance"));
  assertEquals(pay.length, 1);
  assertEquals(new URL(pay[0].url).pathname, "/api2.0/v1/shopping/pay/payBalance");
  assertEquals(pay[0].body, { orderId: "fake-order-0001" });
});

Deno.test("place: production sends isSandbox 0; a sandbox quote can't be placed in production", async () => {
  const q = await goodQuote();
  const { fetchImpl } = stub(placeRoutes());
  const e = await assertRejects(() => adapter(fetchImpl, { env: "production" }).place(req(), q, 6_000, "k1"), GuardRefused);
  assertEquals(e.code, "cj_quote_env_mismatch");
  const prodQuote = { ...q, raw: { ...(q.raw as object), sandbox: false } };
  const realDetail = { ...ORD.detail_created, data: { ...ORD.detail_created.data, isSandbox: 0 } };
  const p = stub(placeRoutes({ detailFirst: realDetail }));
  const o = await adapter(p.fetchImpl, { env: "production" }).place(req(), prodQuote, 6_000, "k1");
  assertEquals(o.chargedCents, 3_741);
  assertEquals(p.biz()[0].body!.isSandbox, 0);
  // CJ re-reading a sandbox order while we are in production mode (or vice versa) is refused unpaid.
  const s = stub(placeRoutes());
  const e2 = await assertRejects(() => adapter(s.fetchImpl, { env: "production" }).place(req(), prodQuote, 6_000, "k1"), GuardRefused);
  assertEquals(e2.code, "cj_sandbox_mismatch");
  assert(!s.biz().some((c) => c.url.includes("/pay/")));
});

Deno.test("place: order total over the hard cap → delete the unpaid order, GuardRefused, never pay", async () => {
  const q = await goodQuote();
  const big = { ...ORD.detail_created, data: { ...ORD.detail_created.data, orderAmount: 60.01 } };
  const { biz, fetchImpl } = stub(placeRoutes({ detailFirst: big }));
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), q, 6_000, "k1"), GuardRefused);
  assertEquals(e.code, "max_price_exceeded");
  assert(!biz().some((c) => c.url.includes("/pay/")));
  assert(biz().some((c) => c.method === "DELETE" && c.url.includes("orderId=fake-order-0001")));
});

Deno.test("place: an order total that lost the duties → cj_order_total_excludes_duties", async () => {
  const q = await goodQuote();
  const noDuty = { ...ORD.detail_created, data: { ...ORD.detail_created.data, orderAmount: 29.71 } };
  const { biz, fetchImpl } = stub(placeRoutes({ detailFirst: noDuty }));
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), q, 6_000, "k1"), GuardRefused);
  assertEquals(e.code, "cj_order_total_excludes_duties");
  assert(!biz().some((c) => c.url.includes("/pay/payBalance")));
});

Deno.test("place: production wallet short (amount − frozen) → insufficient_funds, no payment", async () => {
  const q = { ...(await goodQuote()) };
  q.raw = { ...(q.raw as object), sandbox: false };
  const realDetail = { ...ORD.detail_created, data: { ...ORD.detail_created.data, isSandbox: 0 } };
  const { biz, fetchImpl } = stub(placeRoutes({ detailFirst: realDetail, balance: W.balance_low }));
  const e = await assertRejects(() => adapter(fetchImpl, { env: "production" }).place(req(), q, 6_000, "k1"), GuardRefused);
  assertEquals(e.code, "insufficient_funds"); // $40 − $10 frozen < $37.41
  assert(!biz().some((c) => c.url.includes("/pay/payBalance")));
});

Deno.test("place: CJ answers 1604000 on pay → insufficient_funds (GuardRefused: nothing was paid)", async () => {
  const q = await goodQuote();
  const { fetchImpl } = stub(placeRoutes({ pay: ok(W.balance_insufficient) }));
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), q, 6_000, "k1"), GuardRefused);
  assertEquals(e.code, "insufficient_funds");
});

Deno.test("place: pay call errors (5xx / network) → CjError, so the gate records outcome_unknown", async () => {
  const q = await goodQuote();
  const { fetchImpl } = stub(placeRoutes({ pay: { status: 502, body: {} } }));
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), q, 6_000, "k1"), CjError);
  assertEquals(e.code, "cj_server_error");
});

Deno.test("place: pay 'succeeds' but the order isn't paid on re-read → cj_pay_unconfirmed", async () => {
  const q = await goodQuote();
  const { fetchImpl } = stub([
    [post("/shopping/order/createOrderV2"), ok(ORD.create)],
    [get("/shopping/order/getOrderDetail"), ok(ORD.detail_created)],
    [get("/shopping/pay/getBalance"), ok(W.balance)],
    [post("/shopping/pay/payBalance"), ok(W.pay_ok)],
  ]);
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), q, 6_000, "k1"), CjError);
  assertEquals(e.code, "cj_pay_unconfirmed");
});

Deno.test("place: create errors never pay → GuardRefused; intercepted orders are deleted", async () => {
  const q = await goodQuote();
  const a = stub(placeRoutes({ create: ok(W.param_error) }));
  assertEquals((await assertRejects(() => adapter(a.fetchImpl).place(req(), q, 6_000, "k1"), GuardRefused)).code, "cj_1600100");
  const b = stub(placeRoutes({ create: { status: 503, body: {} } }));
  assertEquals((await assertRejects(() => adapter(b.fetchImpl).place(req(), q, 6_000, "k1"), GuardRefused)).code, "cj_server_error");
  const intercepted = { ...ORD.create, data: { ...ORD.create.data, interceptOrderReasons: [{ code: 1001, message: "example" }] } };
  const c = stub(placeRoutes({ create: ok(intercepted) }));
  assertEquals((await assertRejects(() => adapter(c.fetchImpl).place(req(), q, 6_000, "k1"), GuardRefused)).code, "cj_order_intercepted");
  assert(c.biz().some((x) => x.method === "DELETE"));
  assert(!c.biz().some((x) => x.url.includes("/pay/")));
});

Deno.test("place: duplicate order number resumes the existing order; an already-paid one is returned as is", async () => {
  const q = await goodQuote();
  const { biz, fetchImpl } = stub([
    [post("/shopping/order/createOrderV2"), ok(W.duplicate_order)],
    [get("/shopping/order/getOrderDetail"), ok(ORD.detail_paid)],
  ]);
  const o = await adapter(fetchImpl).place(req(), q, 6_000, "example-idem-1");
  assertEquals(o.vendorOrderId, "fake-order-0001");
  assert(biz()[1].url.includes("orderId=example-idem-1")); // looked up by our order number
  assert(!biz().some((c) => c.url.includes("/pay/")));
});

Deno.test("place: refuses third-party shipTo, paused, missing logistic, non-DDP quotes, missing key", async () => {
  const q = await goodQuote();
  const { calls, fetchImpl } = stub(placeRoutes());
  const code = async (p: Promise<unknown>) => (await assertRejects(() => p, GuardRefused)).code;
  const a = adapter(fetchImpl);
  assertEquals(await code(a.place(req({ shipTo: { name: "X", line1: "1 St", city: "C", state: "NY", zip: "10001" } }), q, 6_000, "k")), "cj_third_party_shipto_unsupported");
  assertEquals(await code(a.place(req(), { ...q, raw: { sandbox: true, ddp: true } }, 6_000, "k")), "cj_quote_missing_logistic");
  assertEquals(await code(a.place(req(), { ...q, raw: { ...(q.raw as object), ddp: false } }, 6_000, "k")), "cj_not_ddp");
  assertEquals(await code(a.place(req(), q, 3_000, "k")), "max_price_exceeded");
  assertEquals(await code(adapter(fetchImpl, { apiKey: "" }).place(req(), q, 6_000, "k")), "cj_api_key_missing");
  await a.pause();
  assertEquals(await code(a.place(req(), q, 6_000, "k")), "vendor_paused");
  assertEquals(calls.length, 0);
});

Deno.test("place: owner address must exist and be US", async () => {
  const q = await goodQuote();
  const { fetchImpl } = stub(placeRoutes());
  const e = await assertRejects(() => adapter(fetchImpl, { ownerShipTo: "" }).place(req(), q, 6_000, "k"), GuardRefused);
  assertEquals(e.code, "zinc_owner_address_missing");
  const ca = JSON.stringify({ ...JSON.parse(OWNER), country: "CA" });
  const e2 = await assertRejects(() => adapter(fetchImpl, { ownerShipTo: ca }).place(req(), q, 6_000, "k"), GuardRefused);
  assertEquals(e2.code, "cj_owner_address_not_us");
});

// ── status / cancel / charges ─────────────────────────────────────────────
Deno.test("status: shipped with tracking number and an https tracking link in raw.links", async () => {
  const { fetchImpl } = stub([[get("/shopping/order/getOrderDetail"), ok(ORD.detail_shipped)]]);
  const s = await adapter(fetchImpl).status("fake-order-0001");
  assertEquals(s.state, "shipped");
  assertEquals(s.tracking, "TESTTRACK0001");
  assertEquals((s.raw as { links: string[] }).links, ["https://track.example.com/search?no=TESTTRACK0001"]);
});

Deno.test("cancel: deletes a CREATED order; a paid order → false without a delete call", async () => {
  const a = stub([
    [get("/shopping/order/getOrderDetail"), ok(ORD.detail_created)],
    [del("/shopping/order/deleteOrder"), ok(W.delete_ok)],
  ]);
  assertEquals(await adapter(a.fetchImpl).cancel("fake-order-0001"), true);
  const b = stub([[get("/shopping/order/getOrderDetail"), ok(ORD.detail_paid)]]);
  assertEquals(await adapter(b.fetchImpl).cancel("fake-order-0001"), false);
  assert(!b.biz().some((c) => c.method === "DELETE"));
  const c = stub([[get("/shopping/order/getOrderDetail"), ok(W.order_not_found)]]);
  assertEquals(await adapter(c.fetchImpl).cancel("nope"), false);
});

Deno.test("listCharges: paid orders by paymentDate, same mode only, keyed by orderId, since honored", async () => {
  const now = Date.parse("2026-10-11T13:00:00Z");
  const { biz, fetchImpl } = stub([
    [(c) => c.url.includes("/shopping/order/list") && c.url.includes("status=UNSHIPPED"), ok(ORD.list_unshipped)],
    [get("/shopping/order/list"), ok(ORD.list_empty)],
  ]);
  const charges = await adapter(fetchImpl, { now: () => now }).listCharges("2026-10-05T00:00:00Z");
  assertEquals(charges, [
    { vendorChargeId: "fake-order-0001", amountCents: 3_741, at: "2026-10-11T12:01:00.000Z", vendorOrderId: "fake-order-0001" },
  ]); // -0002 paid before since; -real-0003 is not a sandbox order
  const statuses = biz().map((c) => new URL(c.url).searchParams.get("status"));
  assertEquals(statuses, ["UNSHIPPED", "SHIPPED", "DELIVERED"]);
  const u = new URL(biz()[0].url);
  assertEquals(u.searchParams.get("paymentDateFrom"), "2026-10-05 00:00:00");
  assertEquals(u.searchParams.get("paymentDateTo"), "2026-10-11 13:00:00");
});

Deno.test("listCharges: windows stay under CJ's 90-day limit; an order without amount fails closed", async () => {
  const now = Date.parse("2026-10-11T00:00:00Z");
  const { biz, fetchImpl } = stub([[get("/shopping/order/list"), ok(ORD.list_empty)]]);
  await adapter(fetchImpl, { now: () => now }).listCharges("2026-05-01T00:00:00Z");
  for (const c of biz()) {
    const u = new URL(c.url).searchParams;
    const span = Date.parse(u.get("paymentDateTo")!.replace(" ", "T") + "Z") - Date.parse(u.get("paymentDateFrom")!.replace(" ", "T") + "Z");
    assert(span <= 90 * 24 * 3600_000);
  }
  const bad = { ...ORD.list_unshipped, data: { ...ORD.list_unshipped.data, list: [{ orderId: "x", isSandbox: 1, paymentDate: "2026-10-10 00:00:00" }] } };
  const b = stub([[get("/shopping/order/list"), ok(bad)]]);
  const e = await assertRejects(() => adapter(b.fetchImpl, { now: () => now }).listCharges("2026-10-01T00:00:00Z"), CjError);
  assertEquals(e.code, "cj_order_without_amount");
});

// ── sourcing (research errand, not a purchase) ────────────────────────────
Deno.test("cjSourcingRequest: posts a sourcing request (code 0 = success), validates input, never orders", async () => {
  const { biz, fetchImpl } = stub([[post("/product/sourcing/create"), ok(W.sourcing_ok)]]);
  const a = adapter(fetchImpl);
  const r = await cjSourcingRequest("https://detail.1688.example/offer/123.html", "example: small brass hinge, 20mm", { adapter: a });
  assertEquals(r, { sourcingId: "285" });
  assertEquals(biz().length, 1);
  assertEquals(biz()[0].body!.productUrl, "https://detail.1688.example/offer/123.html");
  assertEquals(biz()[0].body!.productName, "example: small brass hinge, 20mm");
  const e = await assertRejects(() => cjSourcingRequest("http://insecure.example/x", "note", { adapter: a }), CjError);
  assertEquals(e.code, "cj_sourcing_bad_url");
  const e2 = await assertRejects(() => cjSourcingRequest("https://ok.example/x", "  ", { adapter: a }), CjError);
  assertEquals(e2.code, "cj_sourcing_bad_note");
});

// ── env / construction ─────────────────────────────────────────────────────
Deno.test("cjFromEnv: sandbox by default; production only when CJ_ENV=production; bad values refused", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assertEquals(cjFromEnv(env({})).env, "sandbox");
  assertEquals(cjFromEnv(env({ CJ_ENV: "production" })).env, "production");
  let threw = false;
  try {
    cjFromEnv(env({ CJ_ENV: "prod" }));
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(cjFromEnv(env({ CJ_DUTY_RATE: "0.55" })).dutyRate, 0.55);
  assertEquals(new CjAdapter().reachFor(req()), "self");
  assertEquals(new CjAdapter().reachFor(req({ shipTo: { name: "X", line1: "1", city: "C", state: "NY", zip: "10001" } })), "others");
});

// ── opt-in live test (sandbox only) ────────────────────────────────────────
const LIVE = Deno.env.get("CJ_LIVE") === "1";

Deno.test({
  name: "LIVE sandbox: quote → place (isSandbox=1, simulated pay) → status → cancel",
  ignore: !LIVE,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = Deno.env.get("CJ_ENV") ?? "sandbox";
    if (env !== "sandbox") throw new Error("CJ live test runs only with CJ_ENV unset or sandbox");
    const sku = Deno.env.get("CJ_LIVE_SKU");
    if (!sku) throw new Error("set CJ_LIVE_SKU to a CJ variant id (or pid:vid)");
    // Every create must be a sandbox order; anything else is refused before it leaves the process.
    const guardedFetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/shopping/order/createOrder")) {
        const b = JSON.parse(String(init?.body ?? "{}"));
        if (b.isSandbox !== 1) throw new Error("refusing a non-sandbox create");
      }
      if (String(input).includes("/shopping/pay/")) {
        // sandbox payment is simulated per CJ docs; still log that it was reached
        console.log("LIVE: pay call on a sandbox order");
      }
      return fetch(input, init);
    }) as typeof fetch;
    const a = new CjAdapter({
      apiKey: Deno.env.get("CJ_API_KEY"),
      env: "sandbox",
      ownerShipTo: Deno.env.get("OWNER_SHIP_TO_JSON"),
      fetchImpl: guardedFetch,
    });
    assert(a.isSandbox);
    const r = req({ items: [{ sku, qty: 1 }], idempotencyKey: `example-live-${Date.now()}` });
    let q: Quote;
    try {
      q = await a.quote(r);
    } catch (e) {
      console.log("LIVE: quote refused:", e instanceof CjError ? e.code : e);
      return; // cj_not_ddp / cj_duty_suspicious are real answers worth seeing
    }
    console.log("LIVE quote", { total: q.totalCents, tax: q.taxCents, fee: q.feeCents, line: q.vendorRef });
    const o = await a.place(r, q, q.totalCents, r.idempotencyKey);
    console.log("LIVE order", { id: o.vendorOrderId, charged: o.chargedCents });
    console.log("LIVE status", (await a.status(o.vendorOrderId)).state);
    console.log("LIVE cancel (paid → expected false)", await a.cancel(o.vendorOrderId));
  },
});
