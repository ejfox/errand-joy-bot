// Tree-Nation adapter tests: doc-derived fixtures and a stubbed fetch. No network.
// The one live test is opt-in (TREENATION_LIVE=1) and QUOTES ONLY (public species endpoints).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { buildRegistry, GuardRefused } from "./registry.ts";
import {
  parseTreeSku,
  TREENATION_SANDBOX_BASE_URL,
  TreeNationAdapter,
  type TreeNationAdapterOptions,
  TreeNationError,
  treeNationFromEnv,
  treeNationOrderId,
} from "./treenation.ts";

const FX = new URL("./treenation_fixtures/", import.meta.url);
const fx = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, FX)));
const SPECIES = fx("species.json");
const PLANT = fx("plant.json");

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  auth?: string;
}
type Reply = { status: number; body?: unknown } | "network_error";

type Route = readonly [(c: Call) => boolean, Reply | ((c: Call) => Reply)];

function stub(routes: readonly Route[]) {
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
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ message: "not found" }), { status: 404 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    if (r === "network_error") return Promise.reject(new TypeError("fake network error"));
    const body = r.body === undefined ? null : JSON.stringify(r.body);
    return Promise.resolve(new Response(body, { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function adapter(fetchImpl: typeof fetch, extra: Partial<TreeNationAdapterOptions> = {}) {
  return new TreeNationAdapter({ apiKey: "fake_treenation_token", baseUrl: "https://treenation.example", fetchImpl, ...extra });
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "example-idem-1",
    requester: "test-agent",
    taskId: "example-task",
    vendor: "treenation",
    items: [{ sku: "species:101", qty: 4 }],
    reason: "x".repeat(60),
    reach: "world",
    maxTotalCents: 5_000,
    category: "tree",
    ...over,
  };
}

const isGet = (frag: string) => (c: Call) => c.method === "GET" && c.url.endsWith(frag);
const isPlant = (c: Call) => c.method === "POST" && c.url.endsWith("/api/plant");
const species101 = [isGet("/api/species/101"), { status: 200, body: SPECIES.species_101 }] as const;
const species102 = [isGet("/api/species/102"), { status: 200, body: SPECIES.species_102_low_stock }] as const;
const project7 = [isGet("/api/projects/7/species"), { status: 200, body: SPECIES.project_7_species }] as const;

async function quoted(sku = "species:101", qty = 4): Promise<Quote> {
  const { fetchImpl } = stub([species101, project7]);
  return await adapter(fetchImpl).quote(req({ items: [{ sku, qty }] }));
}

// ── quote ──────────────────────────────────────────────────────────────────
Deno.test("quote: species price (EUR) × qty, converted up to USD cents; public GET without the token", async () => {
  const { calls, fetchImpl } = stub([species101]);
  const q = await adapter(fetchImpl).quote(req());
  // €0.35 × 4 = 140 euro-cents × 1.25 = 175 US cents
  assertEquals(q.totalCents, 175);
  assertEquals(q.subtotalCents, 175);
  assertEquals(q.taxCents + q.shippingCents, 0);
  assertEquals(q.currency, "USD");
  assertEquals(q.vendorRef, "treenation:species:101");
  assertEquals((q.raw as { subtotalEurCents: number }).subtotalEurCents, 140);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].auth, undefined); // the token never goes to public catalog endpoints
});

Deno.test("quote: project:<id> pins the cheapest species with enough stock", async () => {
  const q1 = await quoted("project:7", 1);
  assertEquals(q1.vendorRef, "treenation:species:101"); // 100 is sold out
  const q2 = await quoted("project:7", 3);
  assertEquals(q2.vendorRef, "treenation:species:101");
  assertEquals(q2.totalCents, Math.ceil(35 * 3 * 1.25));
});

Deno.test("quote: a custom EUR→USD rate is applied and rounded up", async () => {
  const { fetchImpl } = stub([species101]);
  const q = await adapter(fetchImpl, { eurUsdRate: 1.1 }).quote(req({ items: [{ sku: "species:101", qty: 3 }] }));
  assertEquals(q.totalCents, Math.ceil(105 * 1.1)); // 116
});

Deno.test("quote: bad sku, several items, bad qty, low stock, maxUnitCents and 404 all refuse", async () => {
  const { fetchImpl } = stub([species101, species102]);
  const a = adapter(fetchImpl);
  const code = async (r: PurchaseRequest) => {
    try {
      await a.quote(r);
    } catch (e) {
      return (e as TreeNationError).code;
    }
    return "no_error";
  };
  assertEquals(await code(req({ items: [{ sku: "tree:101", qty: 1 }] })), "treenation_bad_sku");
  assertEquals(
    await code(req({ items: [{ sku: "species:101", qty: 1 }, { sku: "species:102", qty: 1 }] })),
    "treenation_one_item_only",
  );
  assertEquals(await code(req({ items: [{ sku: "species:101", qty: 0 }] })), "treenation_bad_qty");
  assertEquals(await code(req({ items: [{ sku: "species:101", qty: 1001 }] })), "treenation_bad_qty");
  assertEquals(await code(req({ items: [{ sku: "species:102", qty: 5 }] })), "treenation_out_of_stock");
  assertEquals(await code(req({ items: [{ sku: "species:101", qty: 1, maxUnitCents: 40 }] })), "treenation_over_max_unit");
  assertEquals(await code(req({ items: [{ sku: "species:999", qty: 1 }] })), "treenation_not_found");
});

Deno.test("parseTreeSku: species / project ids only", () => {
  assertEquals(parseTreeSku("species:42"), { kind: "species", id: 42 });
  assertEquals(parseTreeSku("project:7"), { kind: "project", id: 7 });
  for (const bad of ["species:0", "species:-1", "species:1.5", "project:", "species:42 ", "x:1"]) {
    let threw = false;
    try {
      parseTreeSku(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

// ── reach ──────────────────────────────────────────────────────────────────
Deno.test("reach: world for the owner's own planting; others when a person is named", () => {
  const a = adapter(stub([]).fetchImpl);
  assertEquals(a.maxReach, "world");
  assertEquals(a.reachFor(req()), "world");
  assertEquals(a.reachFor(req({ shipTo: OWNER_HOME })), "world");
  assertEquals(
    a.reachFor(req({ shipTo: { name: "Example Friend", line1: "1 Example St", city: "Testville", state: "NY", zip: "10001" } })),
    "others",
  );
});

// ── place ──────────────────────────────────────────────────────────────────
Deno.test("place: plants the pinned species, sends order_id, no recipients; links go in raw", async () => {
  const q = await quoted();
  const { calls, fetchImpl } = stub([species101, [isPlant, { status: 200, body: PLANT.ok_with_trees }]]);
  const a = adapter(fetchImpl);
  const o = await a.place(req(), q, 5_000, "example-idem-1");
  assertEquals(o.vendorOrderId, "63");
  assertEquals(o.chargedCents, q.totalCents);
  const post = calls.find(isPlant)!;
  assertEquals(post.auth, "Bearer fake_treenation_token");
  assertEquals(post.body, { species_id: 101, quantity: 4, order_id: "example-idem-1", language: "en" });
  assert(!("recipients" in post.body!) && !("message" in post.body!));
  const raw = o.raw as { links: string[]; certificateUrls: string[] };
  assertEquals(raw.certificateUrls, [
    "https://youcannevertestenough.tree-nation.com/certificate/fake-token-1",
    "https://youcannevertestenough.tree-nation.com/certificate/fake-token-2",
  ]);
  assertEquals(raw.links[0], raw.certificateUrls[0]); // certificates first, for the why-note
  assertEquals(raw.links.length, 4);
  const s = await a.status("63");
  assertEquals(s.state, "delivered");
  assertEquals((s.raw as { links: string[] }).links, raw.links);
});

Deno.test("place: the spec's response (no trees[]) and `processing` are still placed", async () => {
  const q = await quoted();
  for (const [body, id] of [[PLANT.ok_spec, "64"], [PLANT.processing, "65"]] as const) {
    const { fetchImpl } = stub([species101, [isPlant, { status: 200, body }]]);
    const o = await adapter(fetchImpl).place(req(), q, 5_000, "example-idem-1");
    assertEquals(o.vendorOrderId, id);
    assertEquals((o.raw as { links: string[] }).links, []);
  }
  // status() needs no network: planted = delivered.
  assertEquals((await adapter(stub([]).fetchImpl).status("64")).state, "delivered");
});

Deno.test("place: refusals before any POST (key, pause, recipient, pin, price, cap)", async () => {
  const q = await quoted();
  const pricier = { ...SPECIES.species_101, price: 0.5 };
  const cases: [string, () => Promise<unknown>][] = [];
  const { calls, fetchImpl } = stub([species101, project7]);
  const a = adapter(fetchImpl);
  cases.push(["treenation_api_key_missing", () => adapter(fetchImpl, { apiKey: "" }).place(req(), q, 5_000, "k")]);
  cases.push([
    "treenation_recipient_unsupported",
    () => a.place(req({ shipTo: { name: "Example", line1: "1 Example St", city: "T", state: "NY", zip: "10001" } }), q, 5_000, "k"),
  ]);
  cases.push(["treenation_quote_without_species", () => a.place(req(), { ...q, vendorRef: undefined }, 5_000, "k")]);
  cases.push(["treenation_species_mismatch", () => a.place(req({ items: [{ sku: "species:103", qty: 4 }] }), q, 5_000, "k")]);
  cases.push(["max_price_exceeded", () => a.place(req(), q, 174, "k")]);
  cases.push(["treenation_one_item_only", () => a.place(req({ items: [] }), q, 5_000, "k")]);
  for (const [code, fn] of cases) {
    const e = await assertRejects(fn, GuardRefused);
    assertEquals(e.code, code);
  }
  // price went up since the quote
  const up = stub([[isGet("/api/species/101"), { status: 200, body: pricier }]]);
  const e1 = await assertRejects(() => adapter(up.fetchImpl).place(req(), q, 5_000, "k"), GuardRefused);
  assertEquals(e1.code, "treenation_price_changed");
  // a project sku must still resolve to the pinned species' project
  const other = stub([[isGet("/api/species/101"), { status: 200, body: { ...SPECIES.species_101, project_id: 8 } }]]);
  const e2 = await assertRejects(
    () => adapter(other.fetchImpl).place(req({ items: [{ sku: "project:7", qty: 4 }] }), q, 5_000, "k"),
    GuardRefused,
  );
  assertEquals(e2.code, "treenation_species_mismatch");
  await a.pause();
  assertEquals((await assertRejects(() => a.place(req(), q, 5_000, "k"), GuardRefused)).code, "vendor_paused");
  assert(![...calls, ...up.calls, ...other.calls].some(isPlant));
});

Deno.test("place: documented validation errorCodes are GuardRefused (nothing planted)", async () => {
  const q = await quoted();
  for (const [body, code] of [[PLANT.error_species, "treenation_species"], [PLANT.error_quantity, "treenation_quantity"]]) {
    const { fetchImpl } = stub([species101, [isPlant, { status: 200, body }]]);
    const e = await assertRejects(() => adapter(fetchImpl).place(req(), q, 5_000, "k"), GuardRefused);
    assertEquals(e.code, code);
  }
  const { fetchImpl } = stub([species101, [isPlant, { status: 401, body: { message: "test unauthenticated" } }]]);
  assertEquals((await assertRejects(() => adapter(fetchImpl).place(req(), q, 5_000, "k"), GuardRefused)).code, "treenation_http_401");
});

Deno.test("place: already_processed, unknown codes, 5xx, network and malformed → TreeNationError (outcome_unknown)", async () => {
  const q = await quoted();
  const cases: [Reply, string][] = [
    [{ status: 200, body: PLANT.error_already_processed }, "treenation_already_processed"],
    [{ status: 200, body: PLANT.error_unknown }, "treenation_credit"],
    [{ status: 502, body: { message: "test bad gateway" } }, "treenation_server_error"],
    ["network_error", "treenation_network_error"],
    [{ status: 200, body: PLANT.ok_without_payment_id }, "treenation_malformed_order"],
    [{ status: 200, body: { status: "weird" } }, "treenation_malformed_response"],
  ];
  for (const [reply, code] of cases) {
    const { fetchImpl } = stub([species101, [isPlant, reply]]);
    const e = await assertRejects(() => adapter(fetchImpl).place(req(), q, 5_000, "k"), TreeNationError);
    assertEquals(e.code, code);
  }
});

Deno.test("place: long idempotency keys become a stable short order_id", async () => {
  const long = "example-" + "k".repeat(100);
  const a1 = await treeNationOrderId(long);
  assertEquals(a1, await treeNationOrderId(long));
  assert(/^ejb-[0-9a-f]{40}$/.test(a1));
  assertEquals(await treeNationOrderId("example-short_1"), "example-short_1");
  const q = await quoted();
  const { calls, fetchImpl } = stub([species101, [isPlant, { status: 200, body: PLANT.ok_spec }]]);
  await adapter(fetchImpl).place(req(), q, 5_000, long);
  assertEquals(calls.find(isPlant)!.body!.order_id, a1);
});

// ── the rest of the interface ──────────────────────────────────────────────
Deno.test("cancel is false, listCharges is empty (no endpoints), authCheck reads /api/authcheck", async () => {
  const { calls, fetchImpl } = stub([[isGet("/api/authcheck"), { status: 200, body: { status: "ok" } }]]);
  const a = adapter(fetchImpl);
  assertEquals(await a.cancel("63"), false);
  assertEquals(await a.listCharges(new Date(0).toISOString()), []);
  assertEquals(await a.authCheck(), true);
  assertEquals(calls[0].auth, "Bearer fake_treenation_token");
  assertEquals(await adapter(fetchImpl, { apiKey: "" }).authCheck(), false);
  await assertRejects(() => a.status("../x"), TreeNationError);
});

Deno.test("treeNationFromEnv: defaults to the sandbox host, https only, rate bounds", () => {
  const env = (m: Record<string, string | undefined>) => (k: string) => m[k];
  const a = treeNationFromEnv(env({ TREENATION_API_KEY: "fake_token" }));
  assertEquals(a.baseUrl, TREENATION_SANDBOX_BASE_URL);
  assert(a.isSandbox);
  const live = treeNationFromEnv(env({ TREENATION_BASE_URL: "https://tree-nation.com/" }));
  assertEquals(live.baseUrl, "https://tree-nation.com");
  assert(!live.isSandbox);
  for (const bad of [{ TREENATION_BASE_URL: "http://tree-nation.example" }, { TREENATION_EUR_USD_RATE: "9" }]) {
    let threw = false;
    try {
      treeNationFromEnv(env(bad));
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(bad));
  }
});

Deno.test("registry: treenation is guarded (DRY_RUN refuses place, reach floor world)", async () => {
  const { calls, fetchImpl } = stub([species101, [isPlant, { status: 200, body: PLANT.ok_spec }]]);
  const reg = buildRegistry(["treenation"], { isStopped: () => false, dryRun: true }, { treenation: adapter(fetchImpl) });
  const g = reg.treenation;
  assertEquals(g.reachFor(req({ category: undefined })), "world");
  const q = await g.quote(req());
  assertEquals((await assertRejects(() => g.place(req(), q, 5_000, "k"), GuardRefused)).code, "dry_run");
  assert(!calls.some(isPlant));
});

// ── opt-in live quote (no token needed: species endpoints are public) ─────
const LIVE = Deno.env.get("TREENATION_LIVE") === "1";
Deno.test({
  name: "LIVE treenation: quote only (cheapest in-stock species on the configured host)",
  ignore: !LIVE,
  async fn() {
    const a = treeNationFromEnv();
    const res = await fetch(`${a.baseUrl}/api/species?limit=5&order_by=price&order=asc`);
    const list = (await res.json()).result as { id: number; stock: number }[];
    const pick = list.find((s) => s.stock > 10);
    assert(pick, "no in-stock species listed");
    const q = await a.quote(req({ items: [{ sku: `species:${pick.id}`, qty: 3 }] }));
    console.log(`live treenation quote host=${new URL(a.baseUrl).hostname} ${q.vendorRef} total=${q.totalCents}c`);
    assert(q.totalCents > 0);
  },
});
