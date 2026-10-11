// Mouser adapter tests: Swagger-derived fixtures (fake values) and a stubbed fetch. No network.
// The one live test is opt-in (MOUSER_LIVE=1) and only ever searches/quotes; it never orders.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { GuardRefused } from "./registry.ts";
import { hashedRef } from "./money.ts";
import {
  mapMouserStatus,
  MouserAdapter,
  type MouserAdapterOptions,
  mouserDate,
  MouserError,
  mouserFromEnv,
  mouserOrderTotalCents,
  scrubUrl,
  unitMicrosFor,
} from "./mouser.ts";

const FX = new URL("./mouser_fixtures/", import.meta.url);
const fx = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, FX)));
const ERR = fx("errors.json");
const DETAIL = fx("order_detail.json");
// Fake UUID-shaped keys, distinct per key so tests can tell which one a call used.
const SEARCH_KEY = "fa4e0000-0000-4000-8000-00000000aaaa";
const ORDER_KEY = "fa4e0000-0000-4000-8000-00000000bbbb";

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
  path: string;
  url: string;
  key?: string;
  qs: URLSearchParams;
  body?: Record<string, unknown>;
}
type Reply = { status: number; body?: unknown };

function stub(routes: [(c: Call) => boolean, Reply | ((c: Call) => Reply)][]) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const c: Call = {
      method: init?.method ?? "GET",
      path: u.pathname,
      url: String(input),
      key: u.searchParams.get("apiKey") ?? undefined,
      qs: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const hit = routes.find(([p]) => p(c));
    if (!hit) return Promise.resolve(new Response("{}", { status: 404 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    return Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const at = (p: string) => (c: Call) => c.path === `/api/v1${p}`;
const isSubmit = (v: boolean) => (c: Call) => c.path === "/api/v1/order" && (c.body?.Order as Record<string, unknown>)?.SubmitOrder === v;
const EMPTY_HISTORY = { Errors: [], NumberOfOrders: 0, OrderHistoryItems: [] };

function happy(extra: [(c: Call) => boolean, Reply | ((c: Call) => Reply)][] = []) {
  return stub([
    ...extra,
    [at("/search/partnumber"), { status: 200, body: fx("search_partnumber.json") }],
    [at("/orderhistory/ByDateRange"), { status: 200, body: EMPTY_HISTORY }],
    [at("/cart/items/insert"), { status: 200, body: fx("cart_insert.json") }],
    [at("/order/options/query"), { status: 200, body: fx("options_query.json") }],
    [isSubmit(false), { status: 200, body: fx("order_dry_run.json") }],
    [isSubmit(true), { status: 200, body: fx("order_submitted.json") }],
  ]);
}

function adapter(fetchImpl: typeof fetch, extra: Partial<MouserAdapterOptions> = {}) {
  return new MouserAdapter({
    searchApiKey: SEARCH_KEY,
    orderApiKey: ORDER_KEY,
    cardLast4: "0000",
    ownerShipTo: OWNER,
    baseUrl: "https://mouser.example",
    fetchImpl,
    ...extra,
  });
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "example-idem-1",
    requester: "test-agent",
    taskId: "example-task",
    vendor: "mouser",
    items: [{ sku: "485-EXAMPLE1", qty: 2 }],
    reason: "x".repeat(60),
    reach: "self",
    maxTotalCents: 6_000,
    ...over,
  };
}

function quoteOf(totalCents: number): Quote {
  return { subtotalCents: totalCents, taxCents: 0, shippingCents: 0, totalCents, currency: "USD", quotedAt: "x" };
}

Deno.test("scrubUrl redacts the apiKey query value", () => {
  assertEquals(scrubUrl(`https://api.mouser.com/api/v1/order?apiKey=${ORDER_KEY}&x=1`), "https://api.mouser.com/api/v1/order?apiKey=REDACTED&x=1");
  assertEquals(scrubUrl(`https://h/p?x=1&APIKEY=${ORDER_KEY}`), "https://h/p?x=1&APIKEY=REDACTED");
});

Deno.test("helpers: price breaks, order totals, dates, status names", () => {
  const part = fx("search_partnumber.json").SearchResults.Parts[1];
  assertEquals(unitMicrosFor(part, 10), 12_300);
  assertEquals(unitMicrosFor(part, 250), 8_900);
  assertEquals(unitMicrosFor(part, 5), undefined);
  assertEquals(mouserOrderTotalCents(fx("order_dry_run.json").Order), 3525);
  // A missing OrderTotal can't make it look cheaper than its parts.
  assertEquals(mouserOrderTotalCents({ MerchandiseTotal: 25, TaxAmount: 2.26, ShippingMethod: { PrimaryShippingRate: 7.99 } }), 3525);
  assertEquals(mouserDate(new Date("2026-01-05T12:00:00Z")), "1/5/2026");
  assertEquals(mapMouserStatus(DETAIL.shipped), "shipped");
  assertEquals(mapMouserStatus(DETAIL.cancelled), "cancelled");
  assertEquals(mapMouserStatus(DETAIL.open), "open");
});

Deno.test("reachFor: self for owner-home, others otherwise", () => {
  const a = adapter(stub([]).fetchImpl);
  assertEquals(a.reachFor(req()), "self");
  assertEquals(a.reachFor(req({ shipTo: OWNER_HOME })), "self");
  assertEquals(a.reachFor(req({ shipTo: { name: "A", line1: "1 B St", city: "C", state: "NY", zip: "10001" } })), "others");
});

Deno.test("quote: one Exact part search with the SEARCH key; price break × qty + buffers", async () => {
  const s = happy();
  const q = await adapter(s.fetchImpl).quote(req({ items: [{ sku: "485-EXAMPLE1", qty: 2 }, { sku: "603-EXAMPLE2", qty: 250 }] }));
  assertEquals(s.calls.length, 1);
  assertEquals(s.calls[0].method, "POST");
  assertEquals(s.calls[0].key, SEARCH_KEY);
  assertEquals(s.calls[0].body, { SearchByPartRequest: { mouserPartNumber: "485-EXAMPLE1|603-EXAMPLE2", partSearchOptions: "Exact" } });
  assertEquals(q.subtotalCents, 2500 + 223); // 2 × $12.50 + ceil(250 × $0.0089 = $2.225)
  assertEquals(q.taxCents, Math.round(2723 * 0.1));
  assertEquals(q.shippingCents, 999);
  assertEquals(q.subtotalCents + q.taxCents + q.shippingCents, q.totalCents);
});

Deno.test("quote: refusals (min/mult, not found, max unit, stock, pipes, >10, search errors)", async () => {
  const a = adapter(happy().fetchImpl);
  await assertRejects(() => a.quote(req({ items: [{ sku: "603-EXAMPLE2", qty: 5 }] })), MouserError, "mouser_below_min_qty");
  await assertRejects(() => a.quote(req({ items: [{ sku: "603-EXAMPLE2", qty: 15 }] })), MouserError, "mouser_not_order_multiple");
  await assertRejects(() => a.quote(req({ items: [{ sku: "485-NOPE", qty: 1 }] })), MouserError, "mouser_part_not_found");
  await assertRejects(() => a.quote(req({ items: [{ sku: "485-EXAMPLE1", qty: 2, maxUnitCents: 1000 }] })), MouserError, "mouser_over_max_unit");
  await assertRejects(() => a.quote(req({ items: [{ sku: "485-EXAMPLE1", qty: 500 }] })), MouserError, "mouser_insufficient_stock");
  await assertRejects(() => a.quote(req({ items: [{ sku: "485-EXAMPLE1|603-X", qty: 1 }] })), MouserError, "mouser_bad_part_number");
  const many = Array.from({ length: 11 }, (_, i) => ({ sku: `485-EX${i}`, qty: 1 }));
  await assertRejects(() => a.quote(req({ items: many })), MouserError, "mouser_too_many_items");
  const bad = adapter(stub([[at("/search/partnumber"), { status: 200, body: ERR.search_invalid_key }]]).fetchImpl);
  await assertRejects(() => bad.quote(req()), MouserError, "mouser_search_invalid");
});

Deno.test("place: history → cart → options → dry run → submit, with the ORDER key and the Privacy card", async () => {
  const s = happy();
  const r = req();
  const o = await adapter(s.fetchImpl).place(r, quoteOf(3749), 4000, r.idempotencyKey);
  assertEquals(o.vendorOrderId, "900000001");
  assertEquals(o.chargedCents, 3525);
  assertEquals(s.calls.map((c) => c.path), [
    "/api/v1/orderhistory/ByDateRange",
    "/api/v1/cart/items/insert",
    "/api/v1/order/options/query",
    "/api/v1/order",
    "/api/v1/order",
  ]);
  assert(s.calls.every((c) => c.key === ORDER_KEY), "cart/order/history use the order key");
  assertEquals(s.calls[1].body, { CartItems: [{ MouserPartNumber: "485-EXAMPLE1", Quantity: 2 }] }); // no CartKey → new cart
  const dry = s.calls[3].body!.Order as Record<string, unknown>;
  const sub = s.calls[4].body!.Order as Record<string, unknown>;
  assertEquals(dry.SubmitOrder, false);
  assertEquals(sub.SubmitOrder, true);
  assertEquals({ ...dry, SubmitOrder: true }, sub); // the submit is exactly the dry-run body
  const po = await hashedRef(r.idempotencyKey, 16);
  assertEquals(dry.Payment, { Method: 3, CreditCardLastFourDigits: "0000", PoNumber: po });
  assertEquals(dry.PrimaryShipping, { Code: 101 }); // cheapest
  assertEquals(dry.CartKey, "00000000-0000-0000-0000-000000000000");
  assertEquals((dry.ShippingAddress as Record<string, unknown>).PostalCode, "10001");
});

Deno.test("place: an order already carrying this PoNumber is returned, not re-placed", async () => {
  const po = await hashedRef("example-idem-1", 16);
  const history = structuredClone(fx("order_history.json"));
  history.OrderHistoryItems[0].PoNumber = po;
  const s = happy([
    [at("/orderhistory/ByDateRange"), { status: 200, body: history }],
    [at("/orderhistory/webOrderNumber"), { status: 200, body: DETAIL.shipped }],
  ]);
  const o = await adapter(s.fetchImpl).place(req(), quoteOf(3749), 4000, "example-idem-1");
  assertEquals(o.vendorOrderId, "900000001");
  assertEquals(o.chargedCents, 3525);
  assertEquals(s.calls.filter((c) => c.path === "/api/v1/order").length, 0);
});

Deno.test("place: every pre-submit failure is GuardRefused and never reaches the submit", async () => {
  const third = { name: "A", line1: "1 B St", city: "C", state: "NY", zip: "10001" };
  const cases: [string, MouserAdapter, PurchaseRequest, number][] = [
    ["mouser_third_party_shipto_unsupported", adapter(happy().fetchImpl), req({ shipTo: third }), 4000],
    ["mouser_card_last4_missing", adapter(happy().fetchImpl, { cardLast4: "" }), req(), 4000],
    ["mouser_order_api_key_missing", adapter(happy().fetchImpl, { orderApiKey: "" }), req(), 4000],
    ["mouser_owner_address_missing", adapter(happy().fetchImpl, { ownerShipTo: undefined }), req(), 4000],
    ["mouser_card_not_on_file", adapter(happy().fetchImpl, { cardLast4: "9999" }), req(), 4000],
    ["mouser_shipping_method_unavailable", adapter(happy().fetchImpl, { shippingCode: 999 }), req(), 4000],
    ["max_price_exceeded", adapter(happy().fetchImpl), req(), 3500], // dry run $35.25 > cap
    ["mouser_cart:invalidpartnumber", adapter(happy([[at("/cart/items/insert"), { status: 200, body: ERR.cart_bad_part }]]).fetchImpl), req(), 4000],
    ["mouser_history:mouser_http_500", adapter(happy([[at("/orderhistory/ByDateRange"), { status: 500 }]]).fetchImpl), req(), 4000],
  ];
  for (const [code, a, r, cap] of cases) {
    await assertRejects(() => a.place(r, quoteOf(3749), cap, "k"), GuardRefused, code);
  }
  // Dry run far above the quote (drift > 10%) even though under the hard cap.
  const s = happy();
  await assertRejects(() => adapter(s.fetchImpl).place(req(), quoteOf(3000), 4000, "k"), GuardRefused, "mouser_dry_run_over_quote");
  assertEquals(s.calls.filter(isSubmit(true)).length, 0);
  // Cart lines that don't match the request.
  const cart = structuredClone(fx("cart_insert.json"));
  cart.CartItems[0].Quantity = 3;
  await assertRejects(
    () => adapter(happy([[at("/cart/items/insert"), { status: 200, body: cart }]]).fetchImpl).place(req(), quoteOf(3749), 4000, "k"),
    GuardRefused,
    "mouser_lines_mismatch",
  );
});

Deno.test("place: submit without an OrderID, 5xx or network → MouserError (outcome unknown)", async () => {
  const mk = (r: Reply) => adapter(happy([[isSubmit(true), r]]).fetchImpl);
  await assertRejects(() => mk({ status: 200, body: ERR.submit_no_order_id }).place(req(), quoteOf(3749), 4000, "k"), MouserError, "mouser_submit_no_order_id_paymentdeclined");
  await assertRejects(() => mk({ status: 502 }).place(req(), quoteOf(3749), 4000, "k"), MouserError, "mouser_http_502");
  await assertRejects(() => mk({ status: 401 }).place(req(), quoteOf(3749), 4000, "k"), GuardRefused, "mouser_http_401");
  const odd = structuredClone(fx("order_submitted.json"));
  odd.Order.OrderID = "test-ABC"; // status()/listCharges() need a numeric web order number
  await assertRejects(() => mk({ status: 200, body: odd }).place(req(), quoteOf(3749), 4000, "k"), MouserError, "mouser_submit_no_order_id");
});

Deno.test("place: two orders already carry this PoNumber → MouserError (a human must look)", async () => {
  const po = await hashedRef("k", 16);
  const history = structuredClone(fx("order_history.json"));
  for (const h of history.OrderHistoryItems) h.PoNumber = po;
  const s = happy([[at("/orderhistory/ByDateRange"), { status: 200, body: history }]]);
  await assertRejects(() => adapter(s.fetchImpl).place(req(), quoteOf(3749), 4000, "k"), MouserError, "mouser_duplicate_po_number");
  assertEquals(s.calls.filter((c) => c.path === "/api/v1/order").length, 0);
});

Deno.test("the API key never appears in errors, even when fetch's error text holds the URL", async () => {
  const leaky = ((input: string | URL | Request) =>
    Promise.reject(new TypeError(`error sending request for url (${String(input)})`))) as typeof fetch;
  const a = adapter(leaky);
  for (const f of [() => a.quote(req()), () => a.status("900000001"), () => a.listCharges("2026-10-01T00:00:00Z")]) {
    const e = await assertRejects(f);
    const text = `${(e as Error).message}\n${(e as Error).stack}\n${JSON.stringify(e)}`;
    assert(!text.includes(SEARCH_KEY) && !text.includes(ORDER_KEY), text);
  }
  // The submit call itself (after a successful dry run).
  let n = 0;
  const lateLeak = ((input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body?.Order?.SubmitOrder === true) {
      n++;
      return Promise.reject(new TypeError(`error sending request for url (${String(input)})`));
    }
    return happy().fetchImpl(input, init);
  }) as typeof fetch;
  const e = await assertRejects(() => adapter(lateLeak).place(req(), quoteOf(3749), 4000, "k"), MouserError, "mouser_network_error");
  assertEquals(n, 1);
  assert(!`${e.message}${e.stack}`.includes(ORDER_KEY));
});

Deno.test("status / cancel / listCharges", async () => {
  const s = stub([
    [(c) => c.path === "/api/v1/orderhistory/webOrderNumber" && c.qs.get("webOrderNumber") === "900000001", { status: 200, body: DETAIL.shipped }],
    [(c) => c.path === "/api/v1/orderhistory/webOrderNumber" && c.qs.get("webOrderNumber") === "900000002", { status: 200, body: DETAIL.cancelled }],
    [at("/orderhistory/ByDateRange"), { status: 200, body: fx("order_history.json") }],
  ]);
  const a = adapter(s.fetchImpl);
  const st = await a.status("900000001");
  assertEquals(st.state, "shipped");
  assertEquals(st.tracking, "test-1Z000");
  await assertRejects(() => a.status("../x"), MouserError, "mouser_bad_order_id");
  assertEquals(await a.cancel("900000001"), false);
  const ch = await a.listCharges("2026-10-01T00:00:00Z");
  assertEquals(ch, [{ vendorChargeId: "mouser:900000001", amountCents: 3525, at: new Date("2026-10-11T12:00:00").toISOString(), vendorOrderId: "900000001" }]);
  const hist = s.calls.find((c) => c.path.endsWith("ByDateRange"))!;
  assertEquals(hist.qs.get("startDate"), "10/1/2026");
  assertEquals(hist.key, ORDER_KEY);
});

Deno.test("env: both keys, card last 4, and numeric options", () => {
  const a = mouserFromEnv((k) => ({
    MOUSER_SEARCH_API_KEY: SEARCH_KEY,
    MOUSER_ORDER_API_KEY: ORDER_KEY,
    MOUSER_CARD_LAST4: "0000",
    MOUSER_SHIPPING_CODE: "101",
  } as Record<string, string>)[k]);
  assertEquals(a.shippingCode, 101);
  assertThrows(() => mouserFromEnv((k) => k === "MOUSER_SHIPPING_CODE" ? "abc" : undefined));
  assertThrows(() => new MouserAdapter({ baseUrl: "http://mouser.example" }));
});

const LIVE = Deno.env.get("MOUSER_LIVE") === "1";
Deno.test({
  name: "LIVE: search/quote only (never orders)",
  ignore: !LIVE,
  async fn() {
    // Only the search key is handed over: this adapter cannot reach the cart or order endpoints.
    const a = new MouserAdapter({ searchApiKey: Deno.env.get("MOUSER_SEARCH_API_KEY") });
    const sku = Deno.env.get("MOUSER_LIVE_PART") ?? "485-4116";
    const q = await a.quote(req({ items: [{ sku, qty: 1 }] }));
    console.log(`live mouser quote ${sku}: total=${q.totalCents} (subtotal ${q.subtotalCents})`);
    assert(q.totalCents > 0);
  },
});
