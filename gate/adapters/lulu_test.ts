// Lulu adapter tests: OpenAPI-derived fixtures and a stubbed fetch. No network.
// The one live test is opt-in (LULU_LIVE=1 + sandbox client credentials) and refuses production.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { GuardRefused } from "./registry.ts";
import {
  LULU_SANDBOX_BASE_URL,
  LuluAdapter,
  type LuluAdapterOptions,
  luluCostParts,
  LuluError,
  luluFromEnv,
  luluLine,
  mapLuluStatus,
} from "./lulu.ts";

const FX = new URL("./lulu_fixtures/", import.meta.url);
const fx = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, FX)));
const ERR = fx("errors.json");
const TOKEN = { status: 200, body: fx("token.json") };
const COST = { status: 201, body: fx("cost_calculation.json") };
const CREATED = { status: 201, body: fx("print_job_created.json") };
const LIST = { status: 200, body: fx("print_jobs_list.json") };
const EMPTY = { status: 200, body: { count: 0, next: null, previous: null, results: [] } };

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
const POD = "0550X0850.FC.STD.SS.080CW444.GXX";
const INTERIOR = "https://files.example/test-zine/interior.pdf";
const COVER = "https://files.example/test-zine/cover.pdf";
const FRIEND = { name: "Example Friend", line1: "1 Test Rd", city: "Testtown", state: "CA", zip: "94105", phone: "5555550199" };

interface Call {
  method: string;
  url: string;
  body?: unknown;
  rawBody?: string;
  auth?: string;
}
type Reply = { status: number; body?: unknown };

function stub(routes: [(c: Call) => boolean, Reply | ((c: Call) => Reply)][]) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const raw = init?.body ? String(init.body) : undefined;
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    const c: Call = { method: init?.method ?? "GET", url: String(input), body, rawBody: raw, auth: h.get("authorization") ?? undefined };
    calls.push(c);
    const hit = routes.find(([p]) => p(c));
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ detail: "Not found." }), { status: 404 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    const b = r.body === undefined ? null : JSON.stringify(r.body);
    return Promise.resolve(new Response(b, { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const isToken = (c: Call) => c.method === "POST" && c.url.includes("/openid-connect/token");
const isCost = (c: Call) => c.method === "POST" && c.url.endsWith("/print-job-cost-calculations/");
const isCreate = (c: Call) => c.method === "POST" && c.url.endsWith("/print-jobs/");
const isSearch = (c: Call) => c.method === "GET" && c.url.includes("/print-jobs/?") && c.url.includes("search=");
const isList = (c: Call) => c.method === "GET" && c.url.includes("/print-jobs/?") && c.url.includes("created_after=");
const isStatusPut = (c: Call) => c.method === "PUT" && c.url.includes("/status/");
const base: [(c: Call) => boolean, Reply][] = [[isToken, TOKEN], [isCost, COST]];

function adapter(fetchImpl: typeof fetch, extra: Partial<LuluAdapterOptions> = {}) {
  return new LuluAdapter({
    clientKey: "fake-lulu-client-key",
    clientSecret: "fake-lulu-client-secret",
    baseUrl: "https://lulu.example",
    contactEmail: "test-owner@example.com",
    ownerShipTo: OWNER,
    fetchImpl,
    ...extra,
  });
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "example-idem-1",
    requester: "test-agent",
    taskId: "example-task",
    vendor: "lulu",
    items: [{ sku: POD, qty: 1, pageCount: 16, files: { interior: INTERIOR, cover: COVER }, title: "Example Zine" }],
    reason: "x".repeat(60),
    reach: "self",
    maxTotalCents: 4_000,
    shipTo: OWNER_HOME,
    ...over,
  };
}

function quoteOf(totalCents: number): Quote {
  return { subtotalCents: totalCents, taxCents: 0, shippingCents: 0, totalCents, currency: "USD", quotedAt: new Date().toISOString() };
}

// ── item encoding ──────────────────────────────────────────────────────────
Deno.test("luluLine: sku = pod package id, pageCount, files.interior + files.cover", () => {
  const l = luluLine(req().items[0]);
  assertEquals(l, { podPackageId: POD, pageCount: 16, quantity: 1, interiorUrl: INTERIOR, coverUrl: COVER, title: "Example Zine" });
  const files = { interior: INTERIOR, cover: COVER };
  const other = luluLine({ sku: "0600X0900BWSTDPB060UW444MXX", qty: 2, pageCount: 32, files });
  assertEquals([other.podPackageId, other.pageCount, other.title], ["0600X0900BWSTDPB060UW444MXX", 32, "Untitled"]);
  for (
    const [it, code] of [
      [{ sku: `${POD}/16`, qty: 1, pageCount: 16, files }, "lulu_bad_sku"], // the old sku/pages encoding is gone
      [{ sku: "not-a-pod-package-id-at-all", qty: 1, pageCount: 16, files }, "lulu_bad_sku"],
      [{ sku: POD, qty: 1, files }, "lulu_page_count_missing"],
      [{ sku: POD, qty: 1, pageCount: 1, files }, "lulu_bad_page_count"],
      [{ sku: POD, qty: 1, pageCount: 1201, files }, "lulu_bad_page_count"],
      [{ sku: POD, qty: 101, pageCount: 16, files }, "lulu_bad_qty"],
      [{ sku: POD, qty: 1, pageCount: 16 }, "lulu_interior_url_missing"],
      [{ sku: POD, qty: 1, pageCount: 16, url: `${INTERIOR}#cover=${COVER}` }, "lulu_interior_url_missing"],
      [{ sku: POD, qty: 1, pageCount: 16, files: { interior: INTERIOR } }, "lulu_cover_url_missing"],
      [{ sku: POD, qty: 1, pageCount: 16, files: { interior: INTERIOR, cover: "http://files.example/c.pdf" } }, "lulu_cover_url_invalid"],
      [{ sku: POD, qty: 1, pageCount: 16, files: { interior: "http://files.example/i.pdf", cover: COVER } }, "lulu_interior_url_invalid"],
    ] as const
  ) {
    const e = assertThrows(() => luluLine(it), GuardRefused);
    assertEquals(e.code, code);
  }
});

// ── quote ──────────────────────────────────────────────────────────────────
Deno.test("quote: client-credentials token, cost calculation; parts sum to the total (fee = residual)", async () => {
  const { calls, fetchImpl } = stub(base);
  const q = await adapter(fetchImpl).quote(req());
  assertEquals([q.subtotalCents, q.shippingCents, q.taxCents, q.feeCents, q.totalCents], [430, 499, 80, 75, 1_084]);
  assertEquals(q.subtotalCents + q.shippingCents + q.taxCents + q.feeCents!, q.totalCents);
  const [tok, cost] = calls;
  assertEquals(tok.url, "https://lulu.example/auth/realms/glasstree/protocol/openid-connect/token");
  assertEquals(tok.auth, `Basic ${btoa("fake-lulu-client-key:fake-lulu-client-secret")}`);
  assertEquals(tok.rawBody, "grant_type=client_credentials");
  assertEquals(cost.auth, "Bearer fake-lulu-access-token");
  assertEquals(cost.body, {
    line_items: [{ page_count: 16, pod_package_id: POD, quantity: 1 }],
    shipping_address: {
      name: "Example Owner", street1: "101 Example St", city: "Exampleville", state_code: "NY",
      postcode: "10001", country_code: "US", phone_number: "5555550100",
    },
    shipping_option: "MAIL",
  });
});

Deno.test("quote: the token is cached across calls", async () => {
  const { calls, fetchImpl } = stub(base);
  const a = adapter(fetchImpl);
  await a.quote(req());
  await a.quote(req());
  assertEquals(calls.filter(isToken).length, 1);
});

Deno.test("luluCostParts: a breakdown that doesn't add up, or non-USD, is refused", () => {
  const c = structuredClone(COST.body);
  c.total_cost_incl_tax = "9.00";
  assertThrows(() => luluCostParts(c), LuluError);
  const eur = structuredClone(COST.body);
  eur.currency = "EUR";
  assertThrows(() => luluCostParts(eur), LuluError);
  assertEquals(luluCostParts({}), undefined);
});

// ── addresses / reach ──────────────────────────────────────────────────────
Deno.test("address: third party needs a phone; Lulu field limits are validated, never truncated; reach others", async () => {
  const { calls, fetchImpl } = stub(base);
  const a = adapter(fetchImpl);
  await a.quote(req({ shipTo: FRIEND }));
  assertEquals((calls[1].body as { shipping_address: unknown }).shipping_address, {
    name: "Example Friend", street1: "1 Test Rd", city: "Testtown", state_code: "CA", postcode: "94105", country_code: "US",
    phone_number: "5555550199",
  });
  const noPhone = { ...FRIEND, phone: undefined };
  assertEquals((await assertRejects(() => a.quote(req({ shipTo: noPhone })), GuardRefused)).code, "lulu_shipto_phone_required");
  const longStreet = { ...FRIEND, line1: "1 Extremely Long Example Street Name Rd" };
  assertEquals((await assertRejects(() => a.quote(req({ shipTo: longStreet })), GuardRefused)).code, "lulu_street1_too_long");
  assertEquals(a.maxReach, "others");
  assertEquals(a.reachFor(req({ shipTo: FRIEND })), "others");
  assertEquals(a.reachFor(req()), "self");
});

// ── place ──────────────────────────────────────────────────────────────────
Deno.test("place: re-quote, lookup by external_id, create; charged = the job's own cost", async () => {
  const { calls, fetchImpl } = stub([...base, [isSearch, EMPTY], [isCreate, CREATED]]);
  const o = await adapter(fetchImpl).place(req(), quoteOf(1_084), 4_000, "example-idem-1");
  assertEquals(o, { vendorOrderId: "90001", chargedCents: 1_084, raw: { status: "CREATED" } });
  assert(calls.find(isSearch)!.url.includes("search=example-idem-1"));
  const body = calls.find(isCreate)!.body as Record<string, unknown>;
  assertEquals(body.external_id, "example-idem-1");
  assertEquals(body.contact_email, "test-owner@example.com");
  assertEquals(body.production_delay, 60);
  assertEquals(body.shipping_level, "MAIL");
  assertEquals(body.line_items, [{
    external_id: "example-idem-1-1",
    printable_normalization: { cover: { source_url: COVER }, interior: { source_url: INTERIOR }, pod_package_id: POD },
    quantity: 1,
    title: "Example Zine",
  }]);
});

Deno.test("place: a re-quote above the hard cap refuses before anything is created", async () => {
  const { calls, fetchImpl } = stub([...base, [isSearch, EMPTY], [isCreate, CREATED]]);
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), quoteOf(1_000), 1_000, "k"), GuardRefused);
  assertEquals(e.code, "max_price_exceeded");
  assertEquals(calls.filter(isCreate).length, 0);
});

Deno.test("place: an existing job with the same external_id is returned, not re-created", async () => {
  const { calls, fetchImpl } = stub([...base, [isSearch, { status: 200, body: { count: 1, next: null, results: [LIST.body.results[0]] } }]]);
  const o = await adapter(fetchImpl).place(req(), quoteOf(1_084), 4_000, "example-idem-1");
  assertEquals(o.vendorOrderId, "90001");
  assertEquals(calls.filter(isCreate).length, 0);
});

Deno.test("place: 400 field errors are GuardRefused (no job created)", async () => {
  const { fetchImpl } = stub([...base, [isSearch, EMPTY], [isCreate, ERR.bad_request]]);
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), quoteOf(1_084), 4_000, "k"), GuardRefused);
  assertEquals(e.code, "lulu_rejected_400");
});

Deno.test("place: 5xx / network → look the job up; found is success, not found stays LuluError", async () => {
  let searches = 0;
  const found = stub([
    ...base,
    [isSearch, () => (searches++ === 0 ? EMPTY : { status: 200, body: { count: 1, next: null, results: [LIST.body.results[0]] } })],
    [isCreate, ERR.server_error],
  ]);
  assertEquals((await adapter(found.fetchImpl).place(req(), quoteOf(1_084), 4_000, "example-idem-1")).vendorOrderId, "90001");

  const lost = stub([...base, [isSearch, EMPTY], [isCreate, ERR.server_error]]);
  const e = await assertRejects(() => adapter(lost.fetchImpl).place(req(), quoteOf(1_084), 4_000, "k"), LuluError);
  assertEquals(e.code, "lulu_server_error");

  const s = stub([...base, [isSearch, EMPTY]]);
  const net = ((input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/print-jobs/") && init?.method === "POST"
      ? Promise.reject(new TypeError("connection reset"))
      : s.fetchImpl(input, init)) as typeof fetch;
  const e2 = await assertRejects(() => adapter(net).place(req(), quoteOf(1_084), 4_000, "k"), LuluError);
  assertEquals(e2.code, "lulu_network_error");
});

Deno.test("place: a returned cost above the hard cap is cancelled and thrown", async () => {
  const pricey = structuredClone(CREATED);
  pricey.body.costs.total_cost_incl_tax = "45.00";
  const { calls, fetchImpl } = stub([...base, [isSearch, EMPTY], [isCreate, pricey], [isStatusPut, ERR.status_canceled]]);
  const e = await assertRejects(() => adapter(fetchImpl).place(req(), quoteOf(1_084), 4_000, "k"), LuluError);
  assertEquals(e.code, "lulu_cost_over_cap_cancelled");
  const put = calls.find(isStatusPut)!;
  assertEquals(put.url, "https://lulu.example/print-jobs/90001/status/");
  assertEquals(put.body, { name: "CANCELED" });
});

Deno.test("place: no cost on the new job yet → charged = the re-quote", async () => {
  const bare = structuredClone(CREATED);
  bare.body.costs = null;
  const { fetchImpl } = stub([...base, [isSearch, EMPTY], [isCreate, bare]]);
  assertEquals((await adapter(fetchImpl).place(req(), quoteOf(1_084), 4_000, "k")).chargedCents, 1_084);
});

Deno.test("place: missing credentials, contact email, refused token and pause all refuse before a job exists", async () => {
  const { calls, fetchImpl } = stub([]);
  const cases: [LuluAdapter, string][] = [
    [adapter(fetchImpl, { clientSecret: "" }), "lulu_credentials_missing"],
    [adapter(fetchImpl, { contactEmail: "" }), "lulu_contact_email_missing"],
  ];
  for (const [a, code] of cases) {
    assertEquals((await assertRejects(() => a.place(req(), quoteOf(1_084), 4_000, "k"), GuardRefused)).code, code);
  }
  const p = adapter(fetchImpl);
  await p.pause();
  assertEquals((await assertRejects(() => p.place(req(), quoteOf(1_084), 4_000, "k"), GuardRefused)).code, "vendor_paused");
  assertEquals(calls.length, 0);

  const refused = stub([[isToken, ERR.token_refused]]);
  const e = await assertRejects(() => adapter(refused.fetchImpl).place(req(), quoteOf(1_084), 4_000, "k"), GuardRefused);
  assertEquals(e.code, "lulu_auth_failed");
});

// ── status / cancel ────────────────────────────────────────────────────────
Deno.test("status: Print-Job statuses map; tracking comes from the line item", async () => {
  for (const s of ["CREATED", "UNPAID", "PAYMENT_IN_PROGRESS", "PRODUCTION_DELAYED", "PRODUCTION_READY", "IN_PRODUCTION", "ERROR"]) {
    assertEquals(mapLuluStatus(s), "open");
  }
  assertEquals(mapLuluStatus("SHIPPED"), "shipped");
  assertEquals(mapLuluStatus("DELIVERED"), "delivered");
  assertEquals(mapLuluStatus("CANCELED"), "cancelled");
  assertEquals(mapLuluStatus("REJECTED"), "failed");

  const { calls, fetchImpl } = stub([[isToken, TOKEN], [(c) => c.url.endsWith("/print-jobs/90001/"), { status: 200, body: fx("print_job_shipped.json") }]]);
  const st = await adapter(fetchImpl).status("90001");
  assertEquals(st.state, "shipped");
  assertEquals(st.tracking, "TEST-LULU-TRACK-1");
  assertEquals(calls[1].url, "https://lulu.example/print-jobs/90001/");
  await assertRejects(() => adapter(fetchImpl).status("../90001"), LuluError);
});

Deno.test("cancel: CANCELED → true; invalid transition (already in production) → false", async () => {
  const ok = stub([[isToken, TOKEN], [isStatusPut, ERR.status_canceled]]);
  assertEquals(await adapter(ok.fetchImpl).cancel("90001"), true);
  const late = stub([[isToken, TOKEN], [isStatusPut, ERR.invalid_transition]]);
  assertEquals(await adapter(late.fetchImpl).cancel("90001"), false);
});

// ── listCharges ────────────────────────────────────────────────────────────
Deno.test("listCharges: costed jobs since the cutoff; canceled, rejected and uncosted skipped; pages followed", async () => {
  const page2 = { count: 6, next: null, previous: "x", results: [{ ...LIST.body.results[4], id: 90006, date_created: "2026-10-11T20:00:00Z" }] };
  const { calls, fetchImpl } = stub([
    [isToken, TOKEN],
    [(c) => isList(c) && c.url.includes("page=2"), { status: 200, body: page2 }],
    [isList, { status: 200, body: { ...LIST.body, next: "https://lulu.example/print-jobs/?page=2" } }],
  ]);
  const charges = await adapter(fetchImpl).listCharges("2026-10-11T00:00:00Z");
  assertEquals(charges, [
    { vendorChargeId: "90001", amountCents: 1_084, at: "2026-10-11T15:00:00.000Z", vendorOrderId: "90001" },
    { vendorChargeId: "90005", amountCents: 2_510, at: "2026-10-11T19:00:00.000Z", vendorOrderId: "90005" },
    { vendorChargeId: "90006", amountCents: 2_510, at: "2026-10-11T20:00:00.000Z", vendorOrderId: "90006" },
  ]);
  const first = calls.find(isList)!;
  assert(first.url.includes("created_after=2026-10-11T00%3A00%3A00Z"));
  assert(first.url.includes("exclude_line_items=true"));
});

Deno.test("listCharges: the amount equals what place() recorded, so reconcile matches", async () => {
  const placed = stub([...base, [isSearch, EMPTY], [isCreate, CREATED]]);
  const o = await adapter(placed.fetchImpl).place(req(), quoteOf(1_084), 4_000, "example-idem-1");
  const listed = stub([[isToken, TOKEN], [isList, LIST]]);
  const c = (await adapter(listed.fetchImpl).listCharges("2026-10-11T00:00:00Z")).find((x) => x.vendorOrderId === o.vendorOrderId);
  assertEquals(c?.amountCents, o.chargedCents);
});

// ── config ─────────────────────────────────────────────────────────────────
Deno.test("luluFromEnv: sandbox by default; production only with LULU_ENV=production; bad values throw", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  const a = luluFromEnv(env({}));
  assertEquals([a.baseUrl, a.isSandbox, a.shippingLevel, a.productionDelayMinutes], [LULU_SANDBOX_BASE_URL, true, "MAIL", 60]);
  const p = luluFromEnv(env({ LULU_ENV: "production" }));
  assertEquals([p.baseUrl, p.isSandbox], ["https://api.lulu.com", false]);
  assertThrows(() => luluFromEnv(env({ LULU_ENV: "prod" })));
  assertThrows(() => luluFromEnv(env({ LULU_SHIPPING_LEVEL: "TELEPORT" })));
  assertThrows(() => luluFromEnv(env({ LULU_PRODUCTION_DELAY_MINUTES: "30" })));
  assertEquals(luluFromEnv(env({ LULU_PRODUCTION_DELAY_MINUTES: "2880" })).productionDelayMinutes, 2_880);
});

// ── opt-in live sandbox run ────────────────────────────────────────────────
const LIVE = Deno.env.get("LULU_LIVE") === "1";
Deno.test({
  name: "LIVE lulu sandbox: quote → place → status → cancel → listCharges",
  ignore: !LIVE,
  async fn() {
    assert(Deno.env.get("LULU_ENV") !== "production", "the live test runs only against the sandbox");
    // The sandbox never prints; the docs' own example address is used when no owner address is set.
    const ownerShipTo = Deno.env.get("OWNER_SHIP_TO_JSON") || JSON.stringify({
      first_name: "Test", last_name: "Recipient", address_line1: "101 Independence Ave SE", city: "Washington",
      state: "DC", postal_code: "20540", phone_number: "+1 206 555 0100", country: "US",
    });
    const a = luluFromEnv((k) => (k === "OWNER_SHIP_TO_JSON" ? ownerShipTo : Deno.env.get(k)));
    assert(a.isSandbox && a.baseUrl === LULU_SANDBOX_BASE_URL);
    // Lulu's own template files from the API docs' "Example Book" (6x9 paperback, 32-page interior).
    const r = req({
      idempotencyKey: crypto.randomUUID(),
      items: [{
        sku: "0600X0900.BW.STD.PB.060UW444.MXX",
        qty: 1,
        pageCount: 32,
        title: "errand-joy-bot sandbox test",
        files: {
          interior: "https://www.dropbox.com/s/r20orb8umqjzav9/lulu_trade_interior_template-32.pdf?dl=1&raw=1",
          cover: "https://www.dropbox.com/s/7bv6mg2tj0h3l0r/lulu_trade_perfect_template.pdf?dl=1&raw=1",
        },
      }],
    });
    const q = await a.quote(r);
    console.log(`live quote total=${q.totalCents} fee=${q.feeCents}`);
    const o = await a.place(r, q, q.totalCents + 100, r.idempotencyKey);
    console.log(`live place ok id=${o.vendorOrderId} charged=${o.chargedCents}`);
    const again = await a.place(r, q, q.totalCents + 100, r.idempotencyKey);
    assertEquals(again.vendorOrderId, o.vendorOrderId); // external_id lookup: no duplicate job
    console.log(`live status=${(await a.status(o.vendorOrderId)).state}`);
    console.log(`live cancel=${await a.cancel(o.vendorOrderId)}`);
    const charges = await a.listCharges(new Date(Date.now() - 3600_000).toISOString());
    console.log(`live listCharges n=${charges.length}`);
  },
});
