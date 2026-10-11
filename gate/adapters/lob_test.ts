// Lob adapter tests: doc-derived fixtures and a stubbed fetch. No network.
// The one live test is opt-in (LOB_LIVE=1 + a test_ key) and makes ONE free test-mode postcard.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { buildRegistry, GuardRefused } from "./registry.ts";
import {
  escapeLobText,
  LobAdapter,
  type LobAdapterOptions,
  LobError,
  lobFromEnv,
  mapLobStatus,
  postcardBackHtml,
  postcardSize,
  readLobError,
} from "./lob.ts";

const FX = new URL("./lob_fixtures/", import.meta.url);
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
const FRONT = "https://example.com/art/fake-front.png";
const FAKE_KEY = "test_fakekey";

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  auth?: string;
  idem?: string;
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
      auth: h.get("authorization") ?? undefined,
      idem: h.get("idempotency-key") ?? undefined,
    };
    calls.push(c);
    const hit = routes.find(([p]) => p(c));
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ error: { code: "not_found", status_code: 404, message: "x" } }), { status: 404 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    const body = r.body === undefined ? null : JSON.stringify(r.body);
    return Promise.resolve(new Response(body, { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function adapter(fetchImpl: typeof fetch, extra: Partial<LobAdapterOptions> = {}) {
  return new LobAdapter({ apiKey: FAKE_KEY, baseUrl: "https://lob.example/v1", ownerShipTo: OWNER, fetchImpl, ...extra });
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "example-idem-1",
    requester: "test-agent",
    taskId: "example-task",
    vendor: "lob",
    items: [{ sku: "postcard:4x6", qty: 1, title: "Hello from the robot", url: FRONT }],
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

const isGet = (frag: string) => (c: Call) => c.method === "GET" && c.url.includes(frag);
const isPost = (frag: string) => (c: Call) => c.method === "POST" && c.url.includes(frag);

// ── quote ──────────────────────────────────────────────────────────────────
Deno.test("quote: published per-piece table (postage included) + 3% card fee, no network", async () => {
  const { calls, fetchImpl } = stub([]);
  const a = adapter(fetchImpl);
  const q4 = await a.quote(req());
  assertEquals([q4.subtotalCents, q4.taxCents, q4.shippingCents, q4.feeCents, q4.totalCents], [91, 0, 0, 3, 94]);
  const q6 = await a.quote(req({ items: [{ sku: "postcard:6x9", qty: 1, title: "hi", url: FRONT }] }));
  assertEquals([q6.subtotalCents, q6.feeCents, q6.totalCents], [103, 4, 107]);
  for (const q of [q4, q6]) assertEquals(q.subtotalCents + q.taxCents + q.shippingCents + (q.feeCents ?? 0), q.totalCents);
  assertEquals(calls.length, 0);
});

Deno.test("quote: env overrides the price table and fee rate (ACH = 0)", async () => {
  const a = lobFromEnv((k) => ({ LOB_POSTCARD_CENTS: "120", LOB_POSTCARD_6X9_CENTS: "150", LOB_CARD_FEE_RATE: "0" } as Record<string, string>)[k]);
  assertEquals((await a.quote(req())).totalCents, 120);
  assertEquals((await a.quote(req({ items: [{ sku: "postcard:6x9", qty: 1, title: "hi", url: FRONT }] }))).totalCents, 150);
});

Deno.test("quote: refuses what Lob would refuse (shape, sku, front URL, message)", async () => {
  const a = adapter(stub([]).fetchImpl);
  const item = req().items[0];
  const cases: [Partial<PurchaseRequest>, string][] = [
    [{ items: [item, item] }, "lob_one_postcard_per_request"],
    [{ items: [{ ...item, qty: 2 }] }, "lob_one_postcard_per_request"],
    [{ items: [{ ...item, sku: "postcard:6x11" }] }, "lob_unknown_sku"],
    [{ items: [{ ...item, sku: "letter" }] }, "lob_unknown_sku"],
    [{ items: [{ ...item, url: undefined }] }, "lob_front_url_invalid"],
    [{ items: [{ ...item, url: "http://example.com/a.png" }] }, "lob_front_url_invalid"],
    [{ items: [{ ...item, url: "https://example.com/a.png?x=1" }] }, "lob_front_url_invalid"],
    [{ items: [{ ...item, url: "https://example.com/a.jpeg" }] }, "lob_front_url_invalid"],
    [{ items: [{ ...item, url: "https://example.com/front.html" }] }, "lob_front_url_invalid"],
    [{ items: [{ ...item, title: "  " }] }, "lob_message_missing"],
    [{ items: [{ ...item, title: "y".repeat(351) }] }, "lob_message_too_long"],
  ];
  for (const [over, code] of cases) {
    const e = await assertRejects(() => a.quote(req(over)), GuardRefused);
    assertEquals(e.code, code, JSON.stringify(over));
  }
  assertEquals((await a.quote(req({ items: [{ ...item, sku: "postcard", url: "https://example.com/a.pdf" }] }))).totalCents, 94);
  assertEquals(postcardSize("postcard:6x9"), "6x9");
});

// ── back HTML ──────────────────────────────────────────────────────────────
Deno.test("back: message is HTML-escaped, braces neutralised (no merge variables), newlines kept", () => {
  assertEquals(escapeLobText(`<b>&"'{{name}}`), "&#60;b&#62;&#38;&#34;&#39;&#123;&#123;name&#125;&#125;");
  const html = postcardBackHtml("hi <script>\nbye {{x}}", "4x6");
  assert(!html.includes("<script>"));
  assert(!html.includes("{{"));
  assert(html.includes("hi &#60;script&#62;<br>bye"));
  assert(html.includes("width:6.25in"));
  assert(postcardBackHtml("x", "6x9").includes("width:9.25in"));
  assert(html.length < 10_000);
});

Deno.test("back: Item.message wins over Item.title when present", async () => {
  const { calls, fetchImpl } = stub([[isPost("/postcards"), { status: 200, body: fx("postcard_created.json") }]]);
  const items = [{ sku: "postcard:4x6", qty: 1, title: "the title", url: FRONT, message: "the message" }];
  await adapter(fetchImpl).place(req({ items }), quoteOf(94), 500, "k");
  const back = String(calls[0].body!.back);
  assert(back.includes("the message") && !back.includes("the title"));
});

// ── place ──────────────────────────────────────────────────────────────────
Deno.test("place: basic auth (key as username), Idempotency-Key header, owner address, metadata cents", async () => {
  const { calls, fetchImpl } = stub([[isPost("/postcards"), { status: 200, body: fx("postcard_created.json") }]]);
  const o = await adapter(fetchImpl).place(req(), quoteOf(94), 500, "example-idem-1");
  const c = calls[0];
  assertEquals(c.url, "https://lob.example/v1/postcards");
  assertEquals(c.auth, `Basic ${btoa(`${FAKE_KEY}:`)}`);
  assertEquals(c.idem, "example-idem-1");
  const b = c.body!;
  assertEquals(b.size, "4x6");
  assertEquals(b.front, FRONT);
  assertEquals(b.use_type, "operational");
  assertEquals(b.mail_type, "usps_first_class");
  assertEquals(b.to, {
    name: "Example Owner",
    address_line1: "101 Example St",
    address_line2: null,
    address_city: "Exampleville",
    address_state: "NY",
    address_zip: "10001",
    address_country: "US",
  });
  assertEquals(b.from, b.to);
  assertEquals(b.metadata, { ejb_idempotency_key: "example-idem-1", ejb_cents: "94", task_id: "example-task" });
  assertEquals(o, { vendorOrderId: "psc_fake0000000001", chargedCents: 94, raw: { size: "4x6", status: "processed", send_date: "2026-10-11T15:05:00.000Z", test: true } });
});

Deno.test("place: third-party recipient is supported (Lob needs no phone); owner is the return address", async () => {
  const { calls, fetchImpl } = stub([[isPost("/postcards"), { status: 200, body: fx("postcard_created.json") }]]);
  const a = adapter(fetchImpl);
  const friend = { name: "A Friend", line1: "1 Elsewhere Rd", city: "Town", state: "ca", zip: "94105" };
  assertEquals(a.reachFor(req({ shipTo: friend })), "others");
  await a.place(req({ shipTo: friend }), quoteOf(94), 500, "k");
  assertEquals((calls[0].body!.to as Record<string, string>).address_state, "CA");
  assertEquals((calls[0].body!.from as Record<string, string>).name, "Example Owner");
  // Without an owner address there is simply no return address.
  const s2 = stub([[isPost("/postcards"), { status: 200, body: fx("postcard_created.json") }]]);
  await adapter(s2.fetchImpl, { ownerShipTo: undefined }).place(req({ shipTo: friend }), quoteOf(94), 500, "k");
  assertEquals(s2.calls[0].body!.from, undefined);
});

Deno.test("place: offline refusals (key, pause, cap, owner address, bad recipient) never call Lob", async () => {
  const { calls, fetchImpl } = stub([]);
  const bad = (o: Record<string, string>) => ({ name: "N", line1: "1 Main St", city: "C", state: "NY", zip: "10001", ...o });
  const cases: [LobAdapter, PurchaseRequest, number, string][] = [
    [adapter(fetchImpl, { apiKey: "" }), req(), 500, "lob_api_key_missing"],
    [adapter(fetchImpl), req(), 93, "max_price_exceeded"],
    [adapter(fetchImpl, { ownerShipTo: undefined }), req(), 500, "zinc_owner_address_missing"],
    [adapter(fetchImpl), req({ shipTo: bad({ zip: "1234" }) }), 500, "lob_address_bad_zip"],
    [adapter(fetchImpl), req({ shipTo: bad({ state: "New York" }) }), 500, "lob_address_bad_state"],
    [adapter(fetchImpl), req({ shipTo: bad({ name: "n".repeat(41) }) }), 500, "lob_address_name_too_long"],
    [adapter(fetchImpl), req({ shipTo: bad({ line1: "l".repeat(51) }) }), 500, "address_length_exceeds_limit"],
    [adapter(fetchImpl), req({ items: [{ sku: "postcard", qty: 1, title: "hi", url: "https://x.example/a.gif" }] }), 500, "lob_front_url_invalid"],
  ];
  for (const [a, r, cap, code] of cases) {
    const e = await assertRejects(() => a.place(r, quoteOf(94), cap, "k"), GuardRefused);
    assertEquals(e.code, code);
  }
  const p = adapter(fetchImpl);
  await p.pause();
  assertEquals((await assertRejects(() => p.place(req(), quoteOf(94), 500, "k"), GuardRefused)).code, "vendor_paused");
  assertEquals(calls.length, 0);
});

Deno.test("place: Lob 4xx validation errors are GuardRefused; 5xx and network stay LobError", async () => {
  for (const r of [ERR.invalid_file_url, ERR.payment_method_unverified, ERR.rate_limited]) {
    const { fetchImpl } = stub([[isPost("/postcards"), r]]);
    const e = await assertRejects(() => adapter(fetchImpl).place(req(), quoteOf(94), 500, "k"), GuardRefused);
    assertEquals(e.code, r.body.error.code);
  }
  const { fetchImpl } = stub([[isPost("/postcards"), ERR.server_error]]);
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), quoteOf(94), 500, "k"), LobError);
  assertEquals(e.code, "internal_server_error");
  const boom = (() => Promise.reject(new TypeError("connection reset"))) as typeof fetch;
  assertEquals((await assertRejects(() => adapter(boom).place(req(), quoteOf(94), 500, "k"), LobError)).code, "lob_network_error");
  assertEquals(readLobError(503, undefined), "lob_server_error");
});

Deno.test("place: an idempotent retry returns the same postcard id", async () => {
  const { calls, fetchImpl } = stub([[isPost("/postcards"), { status: 200, body: fx("postcard_created.json") }]]);
  const a = adapter(fetchImpl);
  const o1 = await a.place(req(), quoteOf(94), 500, "example-idem-1");
  const o2 = await a.place(req(), quoteOf(94), 500, "example-idem-1");
  assertEquals(o1.vendorOrderId, o2.vendorOrderId);
  assertEquals(calls.map((c) => c.idem), ["example-idem-1", "example-idem-1"]);
});

Deno.test("guarded: DRY_RUN refuses the live adapter before Lob is called; registry knows lob", async () => {
  const { calls, fetchImpl } = stub([]);
  const reg = buildRegistry(["lob"], { isStopped: () => false, dryRun: true }, { lob: adapter(fetchImpl) });
  const e = await assertRejects(() => reg.lob.place(req(), quoteOf(94), 500, "k"), GuardRefused);
  assertEquals(e.code, "dry_run");
  assertEquals(calls.length, 0);
});

// ── credit check + send_date (live keys) ───────────────────────────────────
const NOW = new Date("2026-10-11T18:00:00.000Z");
const listRoutes = (): [(c: Call) => boolean, Reply][] => [
  [(c) => c.method === "GET" && c.url.includes("after=fakecursor1"), { status: 200, body: fx("postcards_list_page2.json") }],
  [isGet("/postcards?"), { status: 200, body: fx("postcards_list.json") }],
];
const live = (fetchImpl: typeof fetch, extra: Partial<LobAdapterOptions> = {}) => adapter(fetchImpl, { apiKey: "live_fakekey", now: () => NOW, ...extra });

Deno.test("place (live key): balance must cover this piece + our unsent pieces; send_date 60 min out", async () => {
  // Our unsent pieces in the fixtures: 94 + 107 = 201 (deleted and non-ejb postcards don't count).
  const ok = stub([[isGet("/accounts/credits_balance"), { status: 200, body: { balance: 2.95 } }], ...listRoutes(), [isPost("/postcards"), { status: 200, body: fx("postcard_created.json") }]]);
  const a = live(ok.fetchImpl);
  assertEquals(await a.pendingCents(), 201);
  await a.place(req(), quoteOf(94), 500, "k"); // 295 ≤ 295
  const post = ok.calls.find((c) => c.method === "POST")!;
  assertEquals(post.body!.send_date, "2026-10-11T19:00:00.000Z");
  assert(ok.calls.findIndex((c) => c.method === "POST") > ok.calls.findIndex((c) => c.url.includes("credits_balance")));
  assert(ok.calls.some((c) => c.url.includes("date_created%5Bgte%5D=2026-09-27T18%3A00%3A00.000Z")));

  const short = stub([[isGet("/accounts/credits_balance"), { status: 200, body: { balance: 2.94 } }], ...listRoutes()]);
  const e = await assertRejects(() => live(short.fetchImpl).place(req(), quoteOf(94), 500, "k"), GuardRefused);
  assertEquals(e.code, "lob_insufficient_credit");
  assert(!short.calls.some((c) => c.method === "POST"));
  const neg = stub([[isGet("/accounts/credits_balance"), { status: 200, body: { balance: -1234.56 } }], ...listRoutes()]);
  assertEquals((await assertRejects(() => live(neg.fetchImpl).place(req(), quoteOf(94), 500, "k"), GuardRefused)).code, "lob_insufficient_credit");
});

Deno.test("place (live key): balance from the fixture; /accounts fallback when the sample path 404s", async () => {
  const s = stub([[(c) => c.method === "GET" && c.url.endsWith("/v1/accounts"), { status: 200, body: fx("credits_balance.json") }]]);
  assertEquals(await live(s.fetchImpl).creditsBalanceCents(), 300);
  assertEquals(s.calls.map((c) => c.url), ["https://lob.example/v1/accounts/credits_balance", "https://lob.example/v1/accounts"]);
});

Deno.test("place (live key): unreadable balance refuses unless LOB_ALLOW_UNCHECKED_BALANCE=1", async () => {
  const down = () => stub([[isGet("/accounts"), ERR.server_error], [isPost("/postcards"), { status: 200, body: fx("postcard_created.json") }]]);
  const d1 = down();
  const e = await assertRejects(() => live(d1.fetchImpl).place(req(), quoteOf(94), 500, "k"), GuardRefused);
  assertEquals(e.code, "lob_balance_unavailable");
  assert(!d1.calls.some((c) => c.method === "POST"));
  const d2 = down();
  const env = (k: string) => ({ LOB_API_KEY: "live_fakekey", LOB_ALLOW_UNCHECKED_BALANCE: "1" } as Record<string, string>)[k];
  assert(lobFromEnv(env).allowUncheckedBalance);
  const o = await live(d2.fetchImpl, { allowUncheckedBalance: true }).place(req(), quoteOf(94), 500, "k");
  assertEquals(o.vendorOrderId, "psc_fake0000000001");
});

Deno.test("place: test keys skip the credit check (free); LOB_SEND_DELAY_MINUTES=0 omits send_date", async () => {
  const { calls, fetchImpl } = stub([[isPost("/postcards"), { status: 200, body: fx("postcard_created.json") }]]);
  await adapter(fetchImpl, { sendDelayMinutes: 0 }).place(req(), quoteOf(94), 500, "k");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].body!.send_date, undefined);
  assertThrows(() => lobFromEnv((k) => ({ LOB_SEND_DELAY_MINUTES: "-5" } as Record<string, string>)[k]));
});

// ── status / cancel ────────────────────────────────────────────────────────
Deno.test("status: tracking events map to open / shipped / delivered; returned stays billed (shipped)", async () => {
  const ev = (...names: string[]) => names.map((name) => ({ name }));
  assertEquals(mapLobStatus({ tracking_events: [] }), "open");
  assertEquals(mapLobStatus({ tracking_events: null, status: "processed" }), "open");
  assertEquals(mapLobStatus({ tracking_events: ev("Mailed") }), "shipped");
  assertEquals(mapLobStatus({ tracking_events: ev("In Transit", "Processed for Delivery") }), "shipped");
  assertEquals(mapLobStatus({ tracking_events: ev("In Transit", "Delivered") }), "delivered");
  assertEquals(mapLobStatus({ tracking_events: ev("Returned to Sender") }), "shipped");
  assertEquals(mapLobStatus({ deleted: true }), "cancelled");
  assertEquals(mapLobStatus({ status: "failed" }), "failed");

  const t = stub([[isGet("/postcards/psc_fake0000000001"), { status: 200, body: fx("postcard_in_transit.json") }]]);
  const s = await adapter(t.fetchImpl).status("psc_fake0000000001");
  assertEquals(s.state, "shipped");
  assertEquals((s.raw as { last_event: string }).last_event, "In Local Area");
  const r = stub([[isGet("/postcards/psc_fake0000000003"), { status: 200, body: fx("postcard_returned.json") }]]);
  const sr = await adapter(r.fetchImpl).status("psc_fake0000000003");
  assertEquals(sr.state, "shipped");
  assertEquals((sr.raw as { returned: boolean }).returned, true);
  const c = stub([[isGet("/postcards/"), { status: 200, body: fx("postcard_created.json") }]]);
  assertEquals((await adapter(c.fetchImpl).status("psc_fake0000000001")).state, "open"); // test mode: never any events
});

Deno.test("cancel: DELETE → deleted:true is true; not_deletable (window passed) is false; 5xx throws", async () => {
  const ok = stub([[(c) => c.method === "DELETE", ERR.deleted]]);
  assertEquals(await adapter(ok.fetchImpl).cancel("psc_fake0000000001"), true);
  assertEquals(ok.calls[0].url, "https://lob.example/v1/postcards/psc_fake0000000001");
  const no = stub([[(c) => c.method === "DELETE", ERR.not_deletable]]);
  assertEquals(await adapter(no.fetchImpl).cancel("psc_fake0000000001"), false);
  const boom = stub([[(c) => c.method === "DELETE", ERR.server_error]]);
  await assertRejects(() => adapter(boom.fetchImpl).cancel("psc_fake0000000001"), LobError);
});

// ── listCharges ────────────────────────────────────────────────────────────
Deno.test("listCharges: pages via next_url, skips deleted, amount = metadata ejb_cents else the table", async () => {
  const { calls, fetchImpl } = stub([
    [(c) => c.method === "GET" && c.url.includes("after=fakecursor1"), { status: 200, body: fx("postcards_list_page2.json") }],
    [isGet("/postcards?"), { status: 200, body: fx("postcards_list.json") }],
  ]);
  const charges = await adapter(fetchImpl).listCharges("2026-10-11T00:00:00Z");
  assertEquals(charges, [
    { vendorChargeId: "psc_fake0000000001", amountCents: 94, at: "2026-10-11T15:00:00.000Z", vendorOrderId: "psc_fake0000000001" },
    { vendorChargeId: "psc_fake0000000003", amountCents: 107, at: "2026-10-11T16:00:00.000Z", vendorOrderId: "psc_fake0000000003" },
    { vendorChargeId: "psc_fake0000000004", amountCents: 107, at: "2026-10-11T17:00:00.000Z", vendorOrderId: "psc_fake0000000004" },
  ]);
  assert(calls[0].url.startsWith("https://lob.example/v1/postcards?limit=100&date_created%5Bgte%5D=2026-10-11T00%3A00%3A00.000Z"));
  assertEquals(calls.length, 2);
});

Deno.test("listCharges: the amount equals what place() recorded, so reconcile matches", async () => {
  const placed = stub([[isPost("/postcards"), { status: 200, body: fx("postcard_created.json") }]]);
  const o = await adapter(placed.fetchImpl).place(req(), quoteOf(94), 500, "example-idem-1");
  const listed = stub([[isGet("/postcards?"), { status: 200, body: { ...fx("postcards_list.json"), next_url: null } }]]);
  const c = (await adapter(listed.fetchImpl).listCharges("2026-10-11T00:00:00Z")).find((x) => x.vendorOrderId === o.vendorOrderId);
  assertEquals(c?.amountCents, o.chargedCents);
  assertEquals(placed.calls[0].body!.metadata, { ejb_idempotency_key: "example-idem-1", ejb_cents: String(o.chargedCents), task_id: "example-task" });
});

// ── config ─────────────────────────────────────────────────────────────────
Deno.test("lobFromEnv: defaults, https-only base URL, secret keys only", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  const a = lobFromEnv(env({}));
  assertEquals(a.priceCents, { "4x6": 91, "6x9": 103 });
  assertEquals(a.cardFeeRate, 0.03);
  assertEquals(a.maxReach, "others");
  assertThrows(() => lobFromEnv(env({ LOB_BASE_URL: "http://api.lob.example/v1" })));
  assertThrows(() => lobFromEnv(env({ LOB_API_KEY: "test_pub_fake" })));
  assertThrows(() => lobFromEnv(env({ LOB_API_KEY: "sk_fake" })));
  assertThrows(() => lobFromEnv(env({ LOB_POSTCARD_CENTS: "0" })));
  assert(lobFromEnv(env({ LOB_API_KEY: FAKE_KEY })).isTest);
  assert(!lobFromEnv(env({ LOB_API_KEY: "live_fakekey" })).isTest);
});

// ── opt-in live test-mode run: ONE free postcard ───────────────────────────
const LIVE = Deno.env.get("LOB_LIVE") === "1";
Deno.test({
  name: "LIVE test mode: quote → place (+ idempotent retry) → status → cancel → listCharges (test_ key only)",
  ignore: !LIVE,
  async fn() {
    const key = Deno.env.get("LOB_API_KEY") ?? "";
    if (key.startsWith("live_")) throw new Error("refusing: LOB_LIVE runs only with a test_ key, never live_");
    assert(key.startsWith("test_"), "the live test runs only with a Lob test_ key");
    // The docs' own sample address and postcard artwork; test mode never prints or mails.
    const ownerShipTo = JSON.stringify({
      first_name: "Example", last_name: "Recipient", address_line1: "210 King St Ste 6100", city: "San Francisco",
      state: "CA", postal_code: "94107", phone_number: "5555555555", country: "US",
    });
    const a = new LobAdapter({ apiKey: key, baseUrl: Deno.env.get("LOB_BASE_URL"), ownerShipTo });
    assert(a.isTest);
    const r = req({
      idempotencyKey: crypto.randomUUID(),
      items: [{
        sku: "postcard:4x6",
        qty: 1,
        title: "errand-joy-bot test postcard <escaped> {{not a merge var}}",
        url: "https://s3-us-west-2.amazonaws.com/public.lob.com/assets/templates/4x6_pc_template.pdf",
      }],
    });
    const q = await a.quote(r);
    const o = await a.place(r, q, 500, r.idempotencyKey);
    console.log(`live place ok id=${o.vendorOrderId} charged=${o.chargedCents}`);
    const again = await a.place(r, q, 500, r.idempotencyKey);
    assertEquals(again.vendorOrderId, o.vendorOrderId); // same key → same postcard, still ONE
    const s = await a.status(o.vendorOrderId);
    console.log(`live status=${s.state} raw=${JSON.stringify(s.raw)}`);
    const cancelled = await a.cancel(o.vendorOrderId);
    console.log(`live cancel=${cancelled}`);
    const charges = await a.listCharges(new Date(Date.now() - 3600_000).toISOString());
    console.log(`live listCharges n=${charges.length}`);
  },
});
