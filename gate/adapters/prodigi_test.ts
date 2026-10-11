// Prodigi adapter tests: doc-derived fixtures (fake values) and a stubbed fetch. No network.
// The one live test is opt-in (PRODIGI_LIVE=1) and only ever talks to api.sandbox.prodigi.com.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { GuardRefused } from "./registry.ts";
import { hashedRef, moneyToCents, moneyToMicros } from "./money.ts";
import {
  mapProdigiStatus,
  PRODIGI_LIVE_BASE_URL,
  PRODIGI_SANDBOX_BASE_URL,
  ProdigiAdapter,
  type ProdigiAdapterOptions,
  ProdigiError,
  prodigiFromEnv,
  readProdigiError,
} from "./prodigi.ts";

const FX = new URL("./prodigi_fixtures/", import.meta.url);
const fx = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, FX)));
const ERR = fx("errors.json");
const FAKE_KEY = "fake-prodigi-test-key";

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
  apiKey?: string;
}
type Reply = { status: number; body?: unknown };

function stub(routes: [(c: Call) => boolean, Reply | ((c: Call) => Reply)][]) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const c: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      apiKey: h.get("x-api-key") ?? undefined,
    };
    calls.push(c);
    const hit = routes.find(([p]) => p(c));
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ outcome: "EntityNotFound" }), { status: 404 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    const body = r.body === undefined ? null : JSON.stringify(r.body);
    return Promise.resolve(new Response(body, { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const isQuote = (c: Call) => c.method === "POST" && c.url.endsWith("/v4.0/quotes");
const isOrder = (c: Call) => c.method === "POST" && c.url.endsWith("/v4.0/orders");

function adapter(fetchImpl: typeof fetch, extra: Partial<ProdigiAdapterOptions> = {}) {
  return new ProdigiAdapter({
    apiKey: FAKE_KEY,
    baseUrl: "https://prodigi.example",
    ownerShipTo: OWNER,
    fetchImpl,
    log: () => {},
    ...extra,
  });
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "example-idem-1",
    requester: "test-agent",
    taskId: "example-task",
    vendor: "prodigi",
    items: [{ sku: "GLOBAL-FAP-12X16", qty: 2, url: "https://example.com/test-art.png" }],
    reason: "x".repeat(60),
    reach: "self",
    maxTotalCents: 6_000,
    ...over,
  };
}

function quoteOf(totalCents: number): Quote {
  return { subtotalCents: totalCents, taxCents: 0, shippingCents: 0, totalCents, currency: "USD", quotedAt: "x" };
}

Deno.test("money: decimal strings to cents without float drift", () => {
  assertEquals(moneyToCents("11.10"), 1110);
  assertEquals(moneyToCents("$1,234.5"), 123450);
  assertEquals(moneyToCents("-12.00"), -1200);
  assertEquals(moneyToCents(0.1 + 0.2), 30);
  assertEquals(moneyToMicros("$0.0123"), 12_300);
  assertEquals(moneyToCents("1.2.3"), undefined);
  assertEquals(moneyToCents("abc"), undefined);
  assertEquals(moneyToCents(undefined), undefined);
});

Deno.test("hashedRef is deterministic and short", async () => {
  const a = await hashedRef("example-key");
  assertEquals(a, await hashedRef("example-key"));
  assert(/^ejb-[0-9a-f]{32}$/.test(a));
  assert(a !== await hashedRef("example-key-2"));
});

Deno.test("env: sandbox by default, production only when PRODIGI_ENV=production", () => {
  const a = prodigiFromEnv((k) => ({ PRODIGI_API_KEY: FAKE_KEY } as Record<string, string>)[k]);
  assertEquals(a.baseUrl, PRODIGI_SANDBOX_BASE_URL);
  assert(a.isSandbox);
  const b = prodigiFromEnv((k) => ({ PRODIGI_API_KEY: FAKE_KEY, PRODIGI_ENV: "production" } as Record<string, string>)[k]);
  assertEquals(b.baseUrl, PRODIGI_LIVE_BASE_URL);
  assert(!b.isSandbox);
  assertThrows(() => prodigiFromEnv((k) => ({ PRODIGI_ENV: "live" } as Record<string, string>)[k]));
  assertThrows(() => new ProdigiAdapter({ baseUrl: "http://prodigi.example" }));
  assertThrows(() => new ProdigiAdapter({ shippingMethod: "Teleport" }));
});

Deno.test("reachFor: self for owner-home, others otherwise", () => {
  const a = adapter(stub([]).fetchImpl);
  assertEquals(a.reachFor(req()), "self");
  assertEquals(a.reachFor(req({ shipTo: OWNER_HOME })), "self");
  assertEquals(a.reachFor(req({ shipTo: { name: "A", line1: "1 B St", city: "C", state: "NY", zip: "10001" } })), "others");
});

Deno.test("quote: POST /v4.0/quotes, USD, owner country, US tax buffer when Prodigi quotes none", async () => {
  const s = stub([[isQuote, { status: 200, body: fx("quote_budget_us.json") }]]);
  const q = await adapter(s.fetchImpl).quote(req());
  assertEquals(s.calls.length, 1);
  assertEquals(s.calls[0].apiKey, FAKE_KEY);
  const b = s.calls[0].body!;
  assertEquals(b.shippingMethod, "Budget");
  assertEquals(b.destinationCountryCode, "US");
  assertEquals(b.currencyCode, "USD");
  assertEquals(b.items, [{ sku: "GLOBAL-FAP-12X16", copies: 2, attributes: {}, assets: [{ printArea: "default" }] }]);
  assertEquals(q.subtotalCents, 2140);
  assertEquals(q.shippingCents, 695);
  assertEquals(q.taxCents, 284); // round((2140 + 695) × 0.10)
  assertEquals(q.feeCents, 0);
  assertEquals(q.totalCents, 2140 + 695 + 284);
  assertEquals(q.subtotalCents + q.taxCents + q.shippingCents + (q.feeCents ?? 0), q.totalCents);
});

Deno.test("quote: refuses non-USD, inconsistent totals, maxUnitCents, missing image URL", async () => {
  const gbp = structuredClone(fx("quote_budget_us.json"));
  gbp.quotes[0].costSummary.items.currency = "GBP";
  await assertRejects(() => adapter(stub([[isQuote, { status: 200, body: gbp }]]).fetchImpl).quote(req()), ProdigiError, "prodigi_currency_not_usd");

  const bad = structuredClone(fx("quote_budget_us.json"));
  bad.quotes[0].costSummary.totalCost.amount = "99.00";
  await assertRejects(() => adapter(stub([[isQuote, { status: 200, body: bad }]]).fetchImpl).quote(req()), ProdigiError, "prodigi_quote_inconsistent");

  const ok = stub([[isQuote, { status: 200, body: fx("quote_budget_us.json") }]]);
  await assertRejects(
    () => adapter(ok.fetchImpl).quote(req({ items: [{ sku: "GLOBAL-FAP-12X16", qty: 2, url: "https://example.com/a.png", maxUnitCents: 1000 }] })),
    ProdigiError,
    "prodigi_over_max_unit",
  );
  await assertRejects(() => adapter(ok.fetchImpl).quote(req({ items: [{ sku: "GLOBAL-FAP-12X16", qty: 1 }] })), ProdigiError, "prodigi_item_url_missing");
  await assertRejects(
    () => adapter(ok.fetchImpl).quote(req({ items: [{ sku: "GLOBAL-FAP-12X16", qty: 1, url: "http://example.com/a.png" }] })),
    ProdigiError,
    "prodigi_item_url_invalid",
  );
});

Deno.test("place: re-quotes, then one order with idempotencyKey, recipient from owner address", async () => {
  const s = stub([
    [isQuote, { status: 200, body: fx("quote_budget_us.json") }],
    [isOrder, { status: 200, body: fx("order_created.json") }],
  ]);
  const a = adapter(s.fetchImpl);
  const r = req();
  const o = await a.place(r, quoteOf(3119), 3500, r.idempotencyKey);
  assertEquals(o.vendorOrderId, "ord_100001");
  assertEquals(o.chargedCents, 3119);
  assertEquals(s.calls.map((c) => c.url.split("/v4.0")[1]), ["/quotes", "/orders"]);
  // deno-lint-ignore no-explicit-any
  const b = s.calls[1].body as Record<string, any>;
  const key = await hashedRef(r.idempotencyKey);
  assertEquals(b.idempotencyKey, key);
  assertEquals(b.merchantReference, key);
  assertEquals(b.shippingMethod, "Budget");
  assertEquals(b.recipient.name, "Example Owner");
  assertEquals(b.recipient.address, { line1: "101 Example St", postalOrZipCode: "10001", countryCode: "US", townOrCity: "Exampleville", stateOrCounty: "NY" });
  assertEquals(b.items[0].sizing, "fillPrintArea");
  assertEquals(b.items[0].assets, [{ printArea: "default", url: "https://example.com/test-art.png" }]);
});

Deno.test("place: sizing and attributes pass through when the item carries them", async () => {
  const s = stub([
    [isQuote, { status: 200, body: fx("quote_budget_us.json") }],
    [isOrder, { status: 200, body: fx("order_created.json") }],
  ]);
  const item = { sku: "GLOBAL-FAP-12X16", qty: 2, url: "https://example.com/test-art.png", sizing: "fitPrintArea", attributes: { color: "black" } };
  await adapter(s.fetchImpl).place(req({ items: [item] }), quoteOf(3119), 3500, "k");
  assertEquals((s.calls[0].body!.items as Record<string, unknown>[])[0].attributes, { color: "black" });
  const line = (s.calls[1].body!.items as Record<string, unknown>[])[0];
  assertEquals(line.sizing, "fitPrintArea");
  assertEquals(line.attributes, { color: "black" });
});

Deno.test("place: RequiresPaymentAuthorisation = placed but blocked, returned once, logged, never retried", async () => {
  const s = stub([
    [isQuote, { status: 200, body: fx("quote_budget_us.json") }],
    [isOrder, { status: 200, body: fx("order_payment_auth.json") }],
  ]);
  const lines: string[] = [];
  const o = await adapter(s.fetchImpl, { log: (l) => lines.push(l) }).place(req(), quoteOf(3119), 3500, "k");
  assertEquals(o.vendorOrderId, "ord_100002");
  assertEquals(o.chargedCents, 3119); // max(fresh quote 31.19, payment 29.10)
  assertEquals((o.raw as Record<string, unknown>).blocked, "RequiresPaymentAuthorisation");
  assertEquals(s.calls.filter(isOrder).length, 1);
  assertEquals(lines.length, 1);
  assert(lines[0].includes("ord_100002") && lines[0].includes("BLOCKED"));
  assert(!lines[0].includes(FAKE_KEY));

  const st = stub([[(c) => c.url.endsWith("/v4.0/orders/ord_100002"), { status: 200, body: { outcome: "Ok", order: fx("order_payment_auth.json").order } }]]);
  const status = await adapter(st.fetchImpl).status("ord_100002");
  assertEquals(status.state, "open");
  assertEquals((status.raw as Record<string, unknown>).blocked, "RequiresPaymentAuthorisation");
});

Deno.test("place: refusals before any order call (GuardRefused)", async () => {
  const s = stub([[isQuote, { status: 200, body: fx("quote_budget_us.json") }]]);
  const a = adapter(s.fetchImpl);
  const third = { name: "A", line1: "1 B St", city: "C", state: "NY", zip: "10001" };
  await assertRejects(() => a.place(req({ shipTo: third }), quoteOf(3119), 3500, "k"), GuardRefused, "prodigi_third_party_shipto_unsupported");
  await assertRejects(() => a.place(req(), quoteOf(3119), 3000, "k"), GuardRefused, "max_price_exceeded");
  // The stale quote fits but the fresh one doesn't.
  await assertRejects(() => a.place(req(), quoteOf(2000), 3000, "k"), GuardRefused, "max_price_exceeded");
  await assertRejects(() => adapter(s.fetchImpl, { apiKey: "" }).place(req(), quoteOf(3119), 3500, "k"), GuardRefused, "prodigi_api_key_missing");
  await assertRejects(() => adapter(s.fetchImpl, { ownerShipTo: undefined }).place(req(), quoteOf(3119), 3500, "k"), GuardRefused, "prodigi_owner_address_missing");
  await a.pause();
  await assertRejects(() => a.place(req(), quoteOf(3119), 3500, "k"), GuardRefused, "vendor_paused");
  assertEquals(s.calls.filter(isOrder).length, 0);
});

Deno.test("place: 400 validationFailed / 401 → GuardRefused; 5xx and network → ProdigiError", async () => {
  const mk = (r: Reply) => stub([[isQuote, { status: 200, body: fx("quote_budget_us.json") }], [isOrder, r]]).fetchImpl;
  await assertRejects(() => adapter(mk({ status: 400, body: ERR.validationFailed })).place(req(), quoteOf(3119), 3500, "k"), GuardRefused, "prodigi_validationfailed");
  await assertRejects(() => adapter(mk({ status: 401, body: ERR.unauthorised })).place(req(), quoteOf(3119), 3500, "k"), GuardRefused, "prodigi_unauthorized");
  await assertRejects(() => adapter(mk({ status: 500, body: ERR.internalServerError })).place(req(), quoteOf(3119), 3500, "k"), ProdigiError, "internalservererror");
  await assertRejects(() => adapter(mk({ status: 200, body: { outcome: "Weird" } })).place(req(), quoteOf(3119), 3500, "k"), ProdigiError);
  const boom = ((input: string | URL | Request) =>
    String(input).endsWith("/quotes")
      ? Promise.resolve(new Response(JSON.stringify(fx("quote_budget_us.json")), { status: 200 }))
      : Promise.reject(new TypeError("network down"))) as typeof fetch;
  await assertRejects(() => adapter(boom).place(req(), quoteOf(3119), 3500, "k"), ProdigiError, "prodigi_network_error");
});

Deno.test("place: alreadyExists returns the original order", async () => {
  const dup = { ...fx("order_created.json"), outcome: "AlreadyExists" };
  const s = stub([[isQuote, { status: 200, body: fx("quote_budget_us.json") }], [isOrder, { status: 200, body: dup }]]);
  const o = await adapter(s.fetchImpl).place(req(), quoteOf(3119), 3500, "k");
  assertEquals(o.vendorOrderId, "ord_100001");
});

Deno.test("status: stage and shipments map to gate states", async () => {
  assertEquals(mapProdigiStatus({ status: { stage: "InProgress" } }), "open");
  assertEquals(mapProdigiStatus({}), "open"); // paused orders carry no status
  assertEquals(mapProdigiStatus({ status: { stage: "InProgress" }, shipments: [{ status: "Shipped" }] }), "shipped");
  assertEquals(mapProdigiStatus({ status: { stage: "Complete" } }), "delivered");
  assertEquals(mapProdigiStatus({ status: { stage: "Cancelled" } }), "cancelled");
  const s = stub([[(c) => c.url.endsWith("/v4.0/orders/ord_100001"), { status: 200, body: fx("order_complete.json") }]]);
  const st = await adapter(s.fetchImpl).status("ord_100001");
  assertEquals(st.state, "delivered");
  assertEquals(st.tracking, "test-1Z000");
  await assertRejects(() => adapter(s.fetchImpl).status("../evil"), ProdigiError, "prodigi_bad_order_id");
});

Deno.test("cancel: cancelled → true, failedToCancel → false", async () => {
  const isCancel = (c: Call) => c.method === "POST" && c.url.endsWith("/actions/cancel");
  assert(await adapter(stub([[isCancel, { status: 200, body: ERR.cancelled }]]).fetchImpl).cancel("ord_100001"));
  assert(!await adapter(stub([[isCancel, { status: 200, body: ERR.failedToCancel }]]).fetchImpl).cancel("ord_100001"));
});

Deno.test("listCharges: net of charges per order, refunds and uncharged orders skipped", async () => {
  const s = stub([[(c) => c.url.includes("/v4.0/orders?"), { status: 200, body: fx("orders_list.json") }]]);
  const ch = await adapter(s.fetchImpl).listCharges("2026-10-01T00:00:00Z");
  assertEquals(ch, [{ vendorChargeId: "prodigi:ord_100001", amountCents: 2835, at: "2026-10-11T14:40:05.120Z", vendorOrderId: "ord_100001" }]);
  const u = new URL(s.calls[0].url);
  assertEquals(u.searchParams.get("createdFrom"), "2026-10-01T00:00:00.000Z");
  assertEquals(u.searchParams.get("top"), "100");
  await assertRejects(() => adapter(s.fetchImpl).listCharges("nope"), ProdigiError);
});

Deno.test("readProdigiError reads outcome, falls back on status", () => {
  assertEquals(readProdigiError(400, ERR.validationFailed), "validationfailed");
  assertEquals(readProdigiError(401, ERR.unauthorised), "unauthorized");
  assertEquals(readProdigiError(503, undefined), "prodigi_server_error");
});

const LIVE = Deno.env.get("PRODIGI_LIVE") === "1";
Deno.test({
  name: "LIVE sandbox: quote → place → status → cancel (api.sandbox.prodigi.com only)",
  ignore: !LIVE,
  async fn() {
    const a = prodigiFromEnv((k) => k === "PRODIGI_ENV" ? "sandbox" : Deno.env.get(k));
    assertEquals(new URL(a.baseUrl).hostname, "api.sandbox.prodigi.com", "the live test runs only against the sandbox");
    const sku = Deno.env.get("PRODIGI_LIVE_SKU") ?? "GLOBAL-FAP-12X16";
    const url = Deno.env.get("PRODIGI_LIVE_ASSET_URL") ?? "https://pwintyimages.blob.core.windows.net/samples/stars/test-sample-grey.png";
    const r = req({ idempotencyKey: crypto.randomUUID(), items: [{ sku, qty: 1, url }] });
    const q = await a.quote(r);
    console.log(`live sandbox quote total=${q.totalCents}`);
    const o = await a.place(r, q, q.totalCents + 500, r.idempotencyKey);
    console.log(`live sandbox order ${o.vendorOrderId} charged=${o.chargedCents}`);
    console.log(`live sandbox status ${(await a.status(o.vendorOrderId)).state}`);
    console.log(`live sandbox cancel ${await a.cancel(o.vendorOrderId)}`);
  },
});
