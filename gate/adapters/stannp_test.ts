// Stannp adapter tests: doc-derived fixtures and a stubbed fetch. No network.
// The one live test is opt-in (STANNP_LIVE=1 + STANNP_API_KEY) and only ever sends test=true.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { buildRegistry, GuardRefused, knownVendors } from "./registry.ts";
import { dollarsToCents } from "./money.ts";
import {
  mapStannpStatus,
  parseStannpTime,
  StannpAdapter,
  type StannpAdapterOptions,
  StannpError,
  stannpFromEnv,
} from "./stannp.ts";

const FX = new URL("./stannp_fixtures/", import.meta.url);
const fx = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, FX)));
const ERR = fx("errors.json");
const TEST_CREATE = { status: 200, body: fx("postcard_create_test.json") };
const LIVE_CREATE = { status: 200, body: fx("postcard_create_live.json") };

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
const FRIEND = { name: "Example Friend Person", line1: "1 Test Rd", city: "Testtown", state: "ca", zip: "94105" };

interface Call {
  method: string;
  url: string;
  form?: Record<string, string>;
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
      form: init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : undefined,
      auth: h.get("authorization") ?? undefined,
    };
    calls.push(c);
    const hit = routes.find(([p]) => p(c));
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ success: false, error: "not found" }), { status: 404 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    const body = r.body === undefined ? null : JSON.stringify(r.body);
    return Promise.resolve(new Response(body, { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function adapter(fetchImpl: typeof fetch, extra: Partial<StannpAdapterOptions> = {}) {
  return new StannpAdapter({ apiKey: "fake-stannp-key", baseUrl: "https://stannp.example", ownerShipTo: OWNER, fetchImpl, ...extra });
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "example-idem-1",
    requester: "test-agent",
    taskId: "example-task",
    vendor: "stannp",
    items: [{
      sku: "postcard-4x6",
      qty: 1,
      url: "https://files.example/test-render.png",
      title: "Example postcard",
      message: "Example message from the robot",
    }],
    reason: "x".repeat(60),
    reach: "self",
    maxTotalCents: 500,
    shipTo: OWNER_HOME,
    ...over,
  };
}

function quoteOf(totalCents: number): Quote {
  return { subtotalCents: totalCents, taxCents: 0, shippingCents: 0, totalCents, currency: "USD", quotedAt: new Date().toISOString() };
}

const isTestCreate = (c: Call) => c.method === "POST" && c.url.includes("/create") && c.form?.test === "true";
const isLiveCreate = (c: Call) => c.method === "POST" && c.url.includes("/create") && c.form?.test === undefined;
const isGet = (frag: string) => (c: Call) => c.method === "GET" && c.url.includes(frag);
const isPost = (frag: string) => (c: Call) => c.method === "POST" && c.url.includes(frag);

// ── money ──────────────────────────────────────────────────────────────────
Deno.test("dollarsToCents: decimal strings without floats; junk is undefined", () => {
  assertEquals(dollarsToCents("0.80"), 80);
  assertEquals(dollarsToCents("214.4200"), 21_442);
  assertEquals(dollarsToCents("2257.37"), 225_737);
  assertEquals(dollarsToCents("12"), 1_200);
  assertEquals(dollarsToCents("1.5"), 150);
  assertEquals(dollarsToCents(0.8), 80);
  for (const bad of ["-1.00", "1,00", "", "abc", null, undefined, "1e3"]) assertEquals(dollarsToCents(bad), undefined);
});

// ── quote ──────────────────────────────────────────────────────────────────
Deno.test("quote: postcards/create with test=true; cost is the total; Basic auth with an empty password", async () => {
  const { calls, fetchImpl } = stub([[isTestCreate, TEST_CREATE]]);
  const q = await adapter(fetchImpl).quote(req());
  assertEquals([q.subtotalCents, q.taxCents, q.shippingCents, q.totalCents], [80, 0, 0, 80]);
  assertEquals(calls.length, 1);
  const c = calls[0];
  assertEquals(c.url, "https://stannp.example/v1/postcards/create");
  assertEquals(c.auth, `Basic ${btoa("fake-stannp-key:")}`);
  assertEquals(c.form!.size, "4x6");
  assertEquals(c.form!.front, "https://files.example/test-render.png");
  assertEquals(c.form!.message, "Example message from the robot");
  assertEquals(c.form!.post_unverified, "false");
  assertEquals(c.form!["recipient[zipcode]"], "10001");
  assertEquals(c.form!["recipient[state]"], "NY");
  assertEquals(c.form!["recipient[country]"], "US");
  assertEquals(c.form!.idempotency_key, undefined);
});

Deno.test("quote: the title is a label, never printed; no message → no message field", async () => {
  const { calls, fetchImpl } = stub([[isTestCreate, TEST_CREATE]]);
  await adapter(fetchImpl).quote(req({
    items: [{ sku: "postcard-4x6", qty: 1, url: "https://files.example/test-render.png", title: "Example postcard" }],
  }));
  assertEquals(calls[0].form!.message, undefined);
});

Deno.test("a letter with a message is refused before the network (it would be silently dropped)", async () => {
  const { calls, fetchImpl } = stub([[isTestCreate, TEST_CREATE]]);
  await assertRejects(
    () => adapter(fetchImpl).quote(req({ items: [{ sku: "letter", qty: 1, url: "https://files.example/l.pdf", message: "hi" }] })),
    GuardRefused,
    "stannp_letter_has_no_message",
  );
  assertEquals(calls.length, 0);
});

Deno.test("quote: a letter uses letters/create with the PDF as `file`", async () => {
  const { calls, fetchImpl } = stub([[isTestCreate, TEST_CREATE]]);
  await adapter(fetchImpl).quote(req({ items: [{ sku: "letter", qty: 1, url: "https://files.example/test-letter.pdf" }] }));
  assertEquals(calls[0].url, "https://stannp.example/v1/letters/create");
  assertEquals(calls[0].form!.file, "https://files.example/test-letter.pdf");
  assertEquals(calls[0].form!.front, undefined);
});

Deno.test("quote: malformed items refuse before any network call", async () => {
  const { calls, fetchImpl } = stub([]);
  const a = adapter(fetchImpl);
  const it = req().items[0];
  for (
    const [items, code] of [
      [[it, it], "stannp_one_item_only"],
      [[{ ...it, qty: 2 }], "stannp_qty_must_be_1"],
      [[{ ...it, sku: "postcard-a6" }], "stannp_unknown_sku"],
      [[{ ...it, url: undefined }], "stannp_front_image_url_missing"],
      [[{ ...it, url: "http://files.example/x.png" }], "stannp_front_image_url_missing"],
      [[{ sku: "letter", qty: 1 }], "stannp_letter_pdf_url_missing"],
    ] as const
  ) {
    const e = await assertRejects(() => a.quote(req({ items: [...items] })), GuardRefused);
    assertEquals(e.code, code);
  }
  assertEquals(calls.length, 0);
});

Deno.test("quote: a non-test answer to a test=true call fails loudly", async () => {
  const { fetchImpl } = stub([[isTestCreate, LIVE_CREATE]]);
  const e = await assertRejects(() => adapter(fetchImpl).quote(req()), StannpError);
  assertEquals(e.code, "stannp_quote_not_test");
});

Deno.test("quote: a third-party recipient is mapped from ShipTo; reach is others", async () => {
  const { calls, fetchImpl } = stub([[isTestCreate, TEST_CREATE]]);
  const a = adapter(fetchImpl);
  await a.quote(req({ shipTo: FRIEND }));
  const f = calls[0].form!;
  assertEquals(f["recipient[firstname]"], "Example Friend");
  assertEquals(f["recipient[lastname]"], "Person");
  assertEquals(f["recipient[state]"], "CA");
  assertEquals(f["recipient[zipcode]"], "94105");
  assertEquals(f["recipient[address1]"], "1 Test Rd");
  assertEquals(a.maxReach, "others");
  assertEquals(a.reachFor(req({ shipTo: FRIEND })), "others");
  assertEquals(a.reachFor(req()), "self");
  assertEquals(a.reachFor(req({ shipTo: undefined })), "self");
  const bad = await assertRejects(() => a.quote(req({ shipTo: { ...FRIEND, zip: "9410" } })), GuardRefused);
  assertEquals(bad.code, "stannp_recipient_bad_zip");
});

Deno.test("quote: a missing owner address refuses with a stannp_ code", async () => {
  const { calls, fetchImpl } = stub([]);
  const e = await assertRejects(() => adapter(fetchImpl, { ownerShipTo: undefined }).quote(req()), GuardRefused);
  assertEquals(e.code, "stannp_owner_address_missing");
  assertEquals(calls.length, 0);
});

// ── place ──────────────────────────────────────────────────────────────────
Deno.test("place: re-quote, balance check, live create with idempotency key and tag; charged = live cost", async () => {
  const { calls, fetchImpl } = stub([
    [isTestCreate, TEST_CREATE],
    [isGet("/v1/accounts/balance"), ERR.balance],
    [isLiveCreate, LIVE_CREATE],
  ]);
  const o = await adapter(fetchImpl).place(req(), quoteOf(80), 500, "example-idem-1");
  assertEquals(o, { vendorOrderId: "postcard:50000001", chargedCents: 80, raw: { status: "received" } });
  assertEquals(calls.map((c) => c.method + " " + new URL(c.url).pathname), [
    "POST /v1/postcards/create",
    "GET /v1/accounts/balance",
    "POST /v1/postcards/create",
  ]);
  const live = calls[2].form!;
  assertEquals(live.idempotency_key, "example-idem-1");
  assertEquals(live.tags, "ejb-example-idem-1");
  assertEquals(live.test, undefined);
  assertEquals(live.front, "https://files.example/test-render.png");
});

Deno.test("place: a re-quote above the hard cap refuses before the live call", async () => {
  const pricey = structuredClone(TEST_CREATE);
  pricey.body.data.cost = "6.00";
  const { calls, fetchImpl } = stub([[isTestCreate, pricey]]);
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), quoteOf(80), 500, "k"), GuardRefused);
  assertEquals(e.code, "max_price_exceeded");
  assertEquals(calls.filter(isLiveCreate).length, 0);
});

Deno.test("place: a short balance or a failed re-quote refuses (GuardRefused: nothing was sent)", async () => {
  const low = stub([[isTestCreate, TEST_CREATE], [isGet("/balance"), ERR.balance_low]]);
  const e = await assertRejects(() => adapter(low.fetchImpl).place(req(), quoteOf(80), 500, "k"), GuardRefused);
  assertEquals(e.code, "stannp_insufficient_balance");
  assertEquals(low.calls.filter(isLiveCreate).length, 0);

  const bad = stub([[isTestCreate, ERR.bad_request]]);
  const e2 = await assertRejects(() => adapter(bad.fetchImpl).place(req(), quoteOf(80), 500, "k"), GuardRefused);
  assertEquals(e2.code, "stannp_requote_failed:stannp_http_400");
});

Deno.test("place: 409 (identical body already accepted) returns the original piece", async () => {
  const { fetchImpl } = stub([
    [isTestCreate, TEST_CREATE],
    [isGet("/balance"), ERR.balance],
    [isLiveCreate, { status: 409, body: LIVE_CREATE.body }],
  ]);
  const o = await adapter(fetchImpl).place(req(), quoteOf(80), 500, "example-idem-1");
  assertEquals(o.vendorOrderId, "postcard:50000001");
});

Deno.test("place: one network error is retried with the identical body; two stay StannpError", async () => {
  let n = 0;
  const bodies: string[] = [];
  const flaky = ((input: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (String(input).endsWith("/balance")) return Promise.resolve(Response.json(ERR.balance.body));
    if (form.get("test") === "true") return Promise.resolve(Response.json(TEST_CREATE.body));
    bodies.push(String(init?.body));
    if (n++ === 0) return Promise.reject(new TypeError("connection reset"));
    return Promise.resolve(Response.json(LIVE_CREATE.body, { status: 409 }));
  }) as typeof fetch;
  const o = await adapter(flaky).place(req(), quoteOf(80), 500, "example-idem-1");
  assertEquals(o.vendorOrderId, "postcard:50000001");
  assertEquals(bodies.length, 2);
  assertEquals(bodies[0], bodies[1]);

  const dead = ((input: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (String(input).endsWith("/balance")) return Promise.resolve(Response.json(ERR.balance.body));
    if (form.get("test") === "true") return Promise.resolve(Response.json(TEST_CREATE.body));
    return Promise.reject(new TypeError("connection reset"));
  }) as typeof fetch;
  const e = await assertRejects(() => adapter(dead).place(req(), quoteOf(80), 500, "k"), StannpError);
  assertEquals(e.code, "stannp_network_error");
});

Deno.test("place: 5xx is StannpError (outcome_unknown); 401 is GuardRefused", async () => {
  const five = stub([[isTestCreate, TEST_CREATE], [isGet("/balance"), ERR.balance], [isLiveCreate, ERR.server_error]]);
  const e = await assertRejects(() => adapter(five.fetchImpl).place(req(), quoteOf(80), 500, "k"), StannpError);
  assertEquals(e.code, "stannp_server_error");
  const four = stub([[isTestCreate, TEST_CREATE], [isGet("/balance"), ERR.balance], [isLiveCreate, ERR.unauthorized]]);
  const e2 = await assertRejects(() => adapter(four.fetchImpl).place(req(), quoteOf(80), 500, "k"), GuardRefused);
  assertEquals(e2.code, "stannp_unauthorized");
});

Deno.test("place: a live cost above the hard cap is cancelled and thrown", async () => {
  const pricey = structuredClone(LIVE_CREATE);
  pricey.body.data.cost = "9.99";
  const { calls, fetchImpl } = stub([
    [isTestCreate, TEST_CREATE],
    [isGet("/balance"), ERR.balance],
    [isLiveCreate, pricey],
    [isPost("/v1/postcards/cancel"), ERR.cancel_ok],
  ]);
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), quoteOf(80), 500, "k"), StannpError);
  assertEquals(e.code, "stannp_cost_over_cap_cancelled");
  assertEquals(calls.at(-1)!.form, { id: "50000001" });
});

Deno.test("place: missing key and pause refuse offline", async () => {
  const { calls, fetchImpl } = stub([]);
  const e = await assertRejects(() => adapter(fetchImpl, { apiKey: "" }).place(req(), quoteOf(80), 500, "k"), GuardRefused);
  assertEquals(e.code, "stannp_api_key_missing");
  const p = adapter(fetchImpl);
  await p.pause();
  assertEquals((await assertRejects(() => p.place(req(), quoteOf(80), 500, "k"), GuardRefused)).code, "vendor_paused");
  assertEquals(calls.length, 0);
});

// ── status / cancel ────────────────────────────────────────────────────────
Deno.test("status: mailpiece statuses map; returned counts as delivered (money spent)", async () => {
  assertEquals(mapStannpStatus("received"), "open");
  assertEquals(mapStannpStatus("producing"), "open");
  assertEquals(mapStannpStatus("printing"), "open");
  assertEquals(mapStannpStatus("handed_over"), "shipped");
  assertEquals(mapStannpStatus("dispatched"), "shipped");
  assertEquals(mapStannpStatus("local_delivery"), "shipped");
  assertEquals(mapStannpStatus("delivered"), "delivered");
  assertEquals(mapStannpStatus("returned"), "delivered");
  assertEquals(mapStannpStatus("cancelled"), "cancelled");
  assertEquals(mapStannpStatus(undefined), "open");

  const { calls, fetchImpl } = stub([[isGet("/v1/postcards/get/"), { status: 200, body: fx("postcard_get_local_delivery.json") }]]);
  const s = await adapter(fetchImpl).status("postcard:50000001");
  assertEquals(s.state, "shipped");
  assertEquals(s.tracking, "TEST-TRACK-0001");
  assertEquals(calls[0].url, "https://stannp.example/v1/postcards/get/50000001");
  await assertRejects(() => adapter(fetchImpl).status("50000001"), StannpError);
});

Deno.test("cancel: data 1 → true; success:false (already processing) → false", async () => {
  const ok = stub([[isPost("/v1/letters/cancel"), ERR.cancel_ok]]);
  assertEquals(await adapter(ok.fetchImpl).cancel("letter:50000002"), true);
  assertEquals(ok.calls[0].form, { id: "50000002" });
  const late = stub([[isPost("/cancel"), ERR.cancel_too_late]]);
  assertEquals(await adapter(late.fetchImpl).cancel("postcard:50000001"), false);
});

// ── listCharges ────────────────────────────────────────────────────────────
Deno.test("listCharges: reporting list since the cutoff, cancelled skipped, unknown types still count", async () => {
  const { calls, fetchImpl } = stub([[isGet("/v1/reporting/list/"), { status: 200, body: fx("reporting_list.json") }]]);
  const charges = await adapter(fetchImpl).listCharges("2026-10-11T00:00:00Z");
  assertEquals(charges, [
    { vendorChargeId: "postcard:50000001", amountCents: 80, at: "2026-10-11T15:00:00.000Z", vendorOrderId: "postcard:50000001" },
    { vendorChargeId: "letter:50000002", amountCents: 94, at: "2026-10-11T16:00:00.000Z", vendorOrderId: "letter:50000002" },
    { vendorChargeId: "greetingcard:50000005", amountCents: 150, at: "2026-10-11T18:00:00.000Z", vendorOrderId: "greetingcard:50000005" },
  ]);
  // The start date is a day early (Stannp dates may be US-local); 50000004 (before the cutoff) is still dropped.
  assert(calls[0].url.startsWith("https://stannp.example/v1/reporting/list/2026-10-10/"));
});

Deno.test("listCharges: amounts and ids equal what place() recorded, so reconcile matches", async () => {
  const placed = stub([[isTestCreate, TEST_CREATE], [isGet("/balance"), ERR.balance], [isLiveCreate, LIVE_CREATE]]);
  const o = await adapter(placed.fetchImpl).place(req(), quoteOf(80), 500, "example-idem-1");
  const listed = stub([[isGet("/v1/reporting/list/"), { status: 200, body: fx("reporting_list.json") }]]);
  const c = (await adapter(listed.fetchImpl).listCharges("2026-10-11T00:00:00Z")).find((x) => x.vendorOrderId === o.vendorOrderId);
  assertEquals(c?.amountCents, o.chargedCents);
});

Deno.test("parseStannpTime: zone-less timestamps read as UTC; ISO passes through", () => {
  assertEquals(parseStannpTime("2026-10-11 15:00:00"), Date.parse("2026-10-11T15:00:00Z"));
  assertEquals(parseStannpTime("2026-10-11T15:00:00+00:00"), Date.parse("2026-10-11T15:00:00Z"));
  assertEquals(parseStannpTime(""), undefined);
});

Deno.test("balance: decimal string with 4 places → cents", async () => {
  const { fetchImpl } = stub([[isGet("/v1/accounts/balance"), ERR.balance]]);
  assertEquals(await adapter(fetchImpl).balance(), 2_500);
});

// ── config / registry ──────────────────────────────────────────────────────
Deno.test("stannpFromEnv: US base URL by default; https only", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assertEquals(stannpFromEnv(env({})).baseUrl, "https://api-us1.stannp.com");
  let threw = false;
  try {
    stannpFromEnv(env({ STANNP_BASE_URL: "http://api-us1.stannp.example" }));
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("registry: stannp and lulu are known vendors and come out guarded (DRY_RUN refuses place)", async () => {
  assert(knownVendors().includes("stannp"));
  assert(knownVendors().includes("lulu"));
  const { calls, fetchImpl } = stub([]);
  const reg = buildRegistry(["stannp"], { isStopped: () => false, dryRun: true }, { stannp: adapter(fetchImpl) });
  const e = await assertRejects(() => reg.stannp.place(req(), quoteOf(80), 500, "k"), GuardRefused);
  assertEquals(e.code, "dry_run");
  assertEquals(reg.stannp.reachFor(req({ shipTo: FRIEND })), "others");
  assertEquals(calls.length, 0);
});

// ── opt-in live run (test mode only: nothing is mailed or charged) ─────────
const LIVE = Deno.env.get("STANNP_LIVE") === "1";
Deno.test({
  name: "LIVE stannp: test=true quote, balance, test-mode place, reporting list",
  ignore: !LIVE,
  async fn() {
    const apiKey = Deno.env.get("STANNP_API_KEY") ?? "";
    assert(apiKey, "STANNP_API_KEY is required for the live test");
    // test=true never dispatches, so a docs-style sample address is fine when no owner address is set.
    const ownerShipTo = Deno.env.get("OWNER_SHIP_TO_JSON") || JSON.stringify({
      first_name: "Test", last_name: "Recipient", address_line1: "123 Sample Street", city: "Sampletown",
      state: "NY", postal_code: "12345", phone_number: "5555550100", country: "US",
    });
    const a = new StannpAdapter({ apiKey, baseUrl: Deno.env.get("STANNP_BASE_URL"), ownerShipTo, testMode: true });
    const r = req({
      idempotencyKey: crypto.randomUUID(),
      items: [{ sku: "postcard-4x6", qty: 1, url: "https://www.stannp.com/assets/samples/a6-postcard-front.webp", message: "errand-joy-bot live test" }],
    });
    const q = await a.quote(r);
    console.log(`live quote total=${q.totalCents}`);
    console.log(`live balance=${await a.balance()}`);
    const o = await a.place(r, q, q.totalCents, r.idempotencyKey);
    assertEquals(o.chargedCents, 0);
    console.log(`live test-mode place ok id=${o.vendorOrderId}`);
    const charges = await a.listCharges(new Date(Date.now() - 7 * 86_400_000).toISOString());
    console.log(`live listCharges n=${charges.length}`);
  },
});
