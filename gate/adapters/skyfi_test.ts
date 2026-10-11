// SkyFi adapter tests: doc-derived fixtures and a stubbed fetch. No network.
// The one live test is opt-in (SKYFI_LIVE=1 + SKYFI_API_KEY) and QUOTES ONLY (validate is free).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { buildRegistry, GuardRefused } from "./registry.ts";
import {
  mapSkyFiStatus,
  parseSkyFiItems,
  parseWktPolygon,
  pointToWkt,
  SKYFI_DEFAULT_BASE_URL,
  SkyFiAdapter,
  SkyFiError,
  skyFiFromEnv,
  skyFiLabel,
} from "./skyfi.ts";

const R = JSON.parse(Deno.readTextFileSync(new URL("./skyfi_fixtures/responses.json", import.meta.url)));

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  apiKey?: string;
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
      apiKey: h.get("x-skyfi-api-key") ?? undefined,
    };
    calls.push(c);
    const hit = routes.find(([p]) => p(c));
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ detail: "test: not found" }), { status: 404 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    if (r === "network_error") return Promise.reject(new TypeError("fake network error"));
    const body = r.body === undefined ? null : JSON.stringify(r.body);
    return Promise.resolve(new Response(body, { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const adapter = (fetchImpl: typeof fetch, apiKey = "fake_skyfi_key") =>
  new SkyFiAdapter({ apiKey, baseUrl: "https://skyfi.example/platform-api", fetchImpl });

const POINT = "point:41.29,-73.92,1";

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "example-idem-1",
    requester: "test-agent",
    taskId: "example-task",
    vendor: "skyfi",
    items: [{ sku: "archive:fake-archive-0001", qty: 1 }, { sku: POINT, qty: 1 }],
    reason: "x".repeat(60),
    reach: "world",
    maxTotalCents: 5_000,
    category: "satellite",
    ...over,
  };
}

const path = (c: Call) => new URL(c.url).pathname.replace("/platform-api", "");
const is = (method: string, p: string) => (c: Call) => c.method === method && path(c) === p;
const isOrderPost = is("POST", "/order-archive");
const validateOk = [is("POST", "/order-archive/validate"), { status: 200, body: R.validate_ok }] as const;
const whoamiOk = [is("GET", "/auth/whoami"), { status: 200, body: R.whoami }] as const;
const archiveOk = [is("GET", "/archives/fake-archive-0001"), { status: 200, body: R.archive }] as const;
const noEarlier = [is("GET", "/orders"), { status: 200, body: { request: {}, total: 0, orders: [] } }] as const;
const created = [isOrderPost, { status: 201, body: R.order_created }] as const;

async function quoted(r = req()): Promise<Quote> {
  const { fetchImpl } = stub([validateOk, archiveOk]);
  return await adapter(fetchImpl).quote(r);
}

// ── items and geometry ─────────────────────────────────────────────────────
Deno.test("parseSkyFiItems: one archive + at most one AOI; tasking and anything else refused", () => {
  assertEquals(parseSkyFiItems(req({ items: [{ sku: "archive:fake-archive-0001", qty: 1 }] })), {
    archiveId: "fake-archive-0001",
    aoi: undefined,
  });
  const bbox = parseSkyFiItems(req({ items: [{ sku: "archive:a1", qty: 1 }, { sku: "bbox:-73.93,41.28,-73.91,41.3", qty: 1 }] }));
  assertEquals(bbox.aoi, "POLYGON ((-73.93 41.28, -73.91 41.28, -73.91 41.3, -73.93 41.3, -73.93 41.28))");
  const wkt = "aoi:POLYGON((-73.93 41.28,-73.91 41.28,-73.91 41.3,-73.93 41.28))";
  assert(parseSkyFiItems(req({ items: [{ sku: "archive:a1", qty: 1 }, { sku: wkt, qty: 1 }] })).aoi!.startsWith("POLYGON (("));
  const code = (items: PurchaseRequest["items"]) => {
    try {
      parseSkyFiItems(req({ items }));
    } catch (e) {
      return (e as SkyFiError).code;
    }
    return "no_error";
  };
  assertEquals(code([{ sku: "tasking:anything", qty: 1 }]), "skyfi_tasking_refused");
  assertEquals(code([{ sku: "archive:a1", qty: 1 }, { sku: "tasking:x", qty: 1 }]), "skyfi_tasking_refused");
  assertEquals(code([{ sku: "B00EXAMPLE", qty: 1 }]), "skyfi_bad_sku");
  assertEquals(code([{ sku: POINT, qty: 1 }]), "skyfi_archive_required");
  assertEquals(code([{ sku: "archive:a1", qty: 2 }]), "skyfi_qty_must_be_1");
  assertEquals(code([{ sku: "archive:a1", qty: 1 }, { sku: "archive:a2", qty: 1 }]), "skyfi_one_archive_only");
  assertEquals(code([{ sku: "archive:a1", qty: 1 }, { sku: POINT, qty: 1 }, { sku: POINT, qty: 1 }]), "skyfi_bad_items");
  assertEquals(code([{ sku: "archive:../etc", qty: 1 }]), "skyfi_bad_archive_id");
  assertEquals(code([{ sku: "archive:a1", qty: 1 }, { sku: "point:41.29,-73.92,500", qty: 1 }]), "skyfi_bad_radius");
  assertEquals(code([{ sku: "archive:a1", qty: 1 }, { sku: "bbox:-73,41,-60,42", qty: 1 }]), "skyfi_bad_bbox");
  assertEquals(
    code([{ sku: "archive:a1", qty: 1 }, { sku: "aoi:POLYGON((0 0,1 0,1 1,0 1))", qty: 1 }]),
    "skyfi_aoi_not_closed",
  );
  assertEquals(code([{ sku: "archive:a1", qty: 1 }, { sku: "aoi:MULTIPOLYGON(((0 0,1 0,1 1,0 0)))", qty: 1 }]), "skyfi_bad_aoi");
});

Deno.test("pointToWkt: a closed square of side 2r around the point; WKT is validated", () => {
  const w = pointToWkt(41.29, -73.92, 1);
  const ring = /\(\((.*)\)\)/.exec(w)![1].split(", ").map((p) => p.split(" ").map(Number));
  assertEquals(ring.length, 5);
  assertEquals(ring[0], ring[4]);
  const dLat = ring[2][1] - ring[0][1];
  assert(Math.abs(dLat * 110.574 - 2) < 0.001, String(dLat)); // 2 km tall
  assertEquals(parseWktPolygon(w), w);
  for (const bad of ["POLYGON((200 0,1 0,1 1,200 0))", "POLYGON((0 0,1 0,0 0))", "POINT(0 0)", "POLYGON((0 0 0,1 0 0,1 1 0,0 0 0))"]) {
    let threw = false;
    try {
      parseWktPolygon(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

// ── quote ──────────────────────────────────────────────────────────────────
Deno.test("quote: the free validate call prices the exact AOI; header auth; no order created", async () => {
  const { calls, fetchImpl } = stub([validateOk]);
  const q = await adapter(fetchImpl).quote(req());
  assertEquals(q.totalCents, 1_500);
  assertEquals(q.subtotalCents, 1_500);
  assertEquals(q.taxCents + q.shippingCents, 0);
  assertEquals(q.vendorRef, "skyfi:archive:fake-archive-0001");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].apiKey, "fake_skyfi_key");
  assertEquals(calls[0].body!.archiveId, "fake-archive-0001");
  assertEquals(calls[0].body!.deliveryDriver, "NONE");
  assertEquals(calls[0].body!.aoi, pointToWkt(41.29, -73.92, 1));
  assert(!calls.some(isOrderPost));
});

Deno.test("quote: no AOI item → the archive's own footprint is validated", async () => {
  const { calls, fetchImpl } = stub([archiveOk, validateOk]);
  const q = await adapter(fetchImpl).quote(req({ items: [{ sku: "archive:fake-archive-0001", qty: 1 }] }));
  assertEquals(q.totalCents, 1_500);
  assertEquals(calls[1].body!.aoi, parseWktPolygon(R.archive.footprint));
});

Deno.test("quote: 402 / Vantor EULA 403 / 422 / maxUnitCents map to clear codes", async () => {
  for (const [reply, code] of [
    [R.errors.budget_402, "skyfi_budget_exceeded"],
    [R.errors.eula_403, "skyfi_vantor_eula_required"],
    [R.errors.rejected_422, "skyfi_order_rejected"],
  ]) {
    const { fetchImpl } = stub([[is("POST", "/order-archive/validate"), reply]]);
    assertEquals((await assertRejects(() => adapter(fetchImpl).quote(req()), SkyFiError)).code, code);
  }
  const { fetchImpl } = stub([validateOk]);
  const r = req({ items: [{ sku: "archive:fake-archive-0001", qty: 1, maxUnitCents: 1_000 }, { sku: POINT, qty: 1 }] });
  assertEquals((await assertRejects(() => adapter(fetchImpl).quote(r), SkyFiError)).code, "skyfi_over_max_unit");
  const tasking = req({ items: [{ sku: "tasking:fake", qty: 1 }] });
  assertEquals((await assertRejects(() => adapter(stub([]).fetchImpl).quote(tasking), SkyFiError)).code, "skyfi_tasking_refused");
});

// ── reach ──────────────────────────────────────────────────────────────────
Deno.test("reach: world; others for a third-party shipTo", () => {
  const a = adapter(stub([]).fetchImpl);
  assertEquals(a.maxReach, "world");
  assertEquals(a.reachFor(req()), "world");
  assertEquals(a.reachFor(req({ shipTo: OWNER_HOME })), "world");
  assertEquals(
    a.reachFor(req({ shipTo: { name: "Example", line1: "1 Example St", city: "Testville", state: "NY", zip: "10001" } })),
    "others",
  );
});

// ── place ──────────────────────────────────────────────────────────────────
Deno.test("place: re-validates, checks budget, labels the order with the key; charged = orderCost", async () => {
  const q = await quoted();
  const { calls, fetchImpl } = stub([validateOk, whoamiOk, noEarlier, created]);
  const o = await adapter(fetchImpl).place(req(), q, 5_000, "example-idem-1");
  assertEquals(o.vendorOrderId, "fake-order-0001"); // orderId, not the item id
  assertEquals(o.chargedCents, 1_500);
  const post = calls.find(isOrderPost)!;
  assertEquals(post.body!.orderLabel, "ejb-example-idem-1");
  assertEquals(post.body!.deliveryDriver, "NONE");
  assertEquals((post.body!.metadata as Record<string, string>).ejb_idempotency_key, "ejb-example-idem-1");
  assertEquals(post.body!.aoi, pointToWkt(41.29, -73.92, 1));
  // order: lookup → validate → whoami → POST; never a tasking endpoint
  assertEquals(calls.map(path), ["/orders", "/order-archive/validate", "/auth/whoami", "/order-archive"]);
  assert(!calls.some((c) => c.url.includes("tasking")));
});

Deno.test("place: an earlier order with the same label is returned, not re-ordered", async () => {
  const q = await quoted();
  const listed = { request: {}, total: 1, orders: [R.orders_list.orders[2]] };
  // The earlier order already used the budget: validate would now 402. The lookup comes first.
  const { calls, fetchImpl } = stub([
    [is("POST", "/order-archive/validate"), R.errors.budget_402],
    whoamiOk,
    [is("GET", "/orders"), { status: 200, body: listed }],
    created,
  ]);
  const o = await adapter(fetchImpl).place(req(), q, 5_000, "example-idem-1");
  assertEquals(o.vendorOrderId, "fake-order-0001");
  assert(!calls.some(isOrderPost));
  assertEquals(new URL(calls.find(is("GET", "/orders"))!.url).searchParams.get("search"), "ejb-example-idem-1");
});

Deno.test("place: refusals before POST /order-archive (key, pause, shipTo, tasking, pin, price, cap, budget)", async () => {
  const q = await quoted();
  const all: Call[] = [];
  const run = async (code: string, routes: Parameters<typeof stub>[0], r = req(), cap = 5_000, qq = q, key = "fake_skyfi_key") => {
    const s = stub(routes);
    const a = adapter(s.fetchImpl, key);
    const e = await assertRejects(() => a.place(r, qq, cap, "example-idem-1"), GuardRefused);
    assertEquals(e.code, code);
    all.push(...s.calls);
  };
  const happy = [validateOk, whoamiOk, noEarlier, created] as Parameters<typeof stub>[0];
  await run("skyfi_api_key_missing", happy, req(), 5_000, q, "");
  await run("skyfi_third_party_unsupported", happy, req({ shipTo: { name: "E", line1: "1 E St", city: "T", state: "NY", zip: "10001" } }));
  await run("skyfi_tasking_refused", happy, req({ items: [{ sku: "tasking:fake", qty: 1 }] }));
  await run("skyfi_quote_mismatch", happy, req(), 5_000, { ...q, vendorRef: "skyfi:archive:other" });
  await run("max_price_exceeded", happy, req(), 1_499);
  await run("skyfi_price_changed", [[is("POST", "/order-archive/validate"), { status: 200, body: { ...R.validate_ok, estimatedCostCents: 1_400 } }], whoamiOk, noEarlier, created]);
  await run("skyfi_budget_insufficient", [validateOk, [is("GET", "/auth/whoami"), { status: 200, body: { ...R.whoami, currentBudgetUsage: 9_000 } }], noEarlier, created]);
  await run("skyfi_budget_exceeded", [[is("POST", "/order-archive/validate"), R.errors.budget_402], whoamiOk, noEarlier, created]);
  await run("skyfi_server_error", [validateOk, [is("GET", "/auth/whoami"), R.errors.server_500], noEarlier, created]);
  await run("skyfi_lookup_failed", [validateOk, whoamiOk, [is("GET", "/orders"), "network_error"], created]);
  const paused = adapter(stub(happy).fetchImpl);
  await paused.pause();
  assertEquals((await assertRejects(() => paused.place(req(), q, 5_000, "k"), GuardRefused)).code, "vendor_paused");
  assert(!all.some(isOrderPost));
});

Deno.test("place: POST rejections are GuardRefused; 5xx, network and malformed stay SkyFiError", async () => {
  const q = await quoted();
  const pre = [validateOk, whoamiOk, noEarlier] as Parameters<typeof stub>[0];
  for (const [reply, code] of [
    [R.errors.rejected_422, "skyfi_order_rejected"],
    [R.errors.eula_403, "skyfi_vantor_eula_required"],
    [R.errors.limit_429, "skyfi_order_limit"],
    [{ status: 503, body: { detail: "test: ordering disabled" } }, "skyfi_ordering_disabled"],
  ]) {
    const { fetchImpl } = stub([...pre, [isOrderPost, reply]]);
    assertEquals((await assertRejects(() => adapter(fetchImpl).place(req(), q, 5_000, "k"), GuardRefused)).code, code);
  }
  for (const [reply, code] of [
    [R.errors.server_500, "skyfi_server_error"],
    ["network_error", "skyfi_network_error"],
    [{ status: 201, body: { status: "CREATED" } }, "skyfi_malformed_order"],
  ] as [Reply, string][]) {
    const { fetchImpl } = stub([...pre, [isOrderPost, reply]]);
    assertEquals((await assertRejects(() => adapter(fetchImpl).place(req(), q, 5_000, "k"), SkyFiError)).code, code);
  }
});

Deno.test("skyFiLabel: plain keys pass through; long keys become a stable hash", async () => {
  assertEquals(await skyFiLabel("example-idem-1"), "ejb-example-idem-1");
  const long = "example:" + "k".repeat(100);
  assertEquals(await skyFiLabel(long), await skyFiLabel(long));
  assert(/^ejb-[0-9a-f]{40}$/.test(await skyFiLabel(long)));
});

// ── status / listCharges / budget ──────────────────────────────────────────
Deno.test("status: created → open, processing → shipped, delivered → links in raw, *_FAILED → failed", async () => {
  const { fetchImpl } = stub([
    [is("GET", "/orders/fake-order-0001"), { status: 200, body: R.order_delivered }],
    [is("GET", "/orders/fake-order-0002"), { status: 200, body: R.order_failed }],
  ]);
  const a = adapter(fetchImpl);
  const d = await a.status("fake-order-0001");
  assertEquals(d.state, "delivered");
  const raw = d.raw as { links: string[]; lastEvent: string };
  assertEquals(raw.links[0], "https://example.com/fake-order-0001/view-ready.tif");
  assertEquals(raw.links.length, 4);
  assertEquals((await a.status("fake-order-0002")).state, "failed");
  assertEquals(mapSkyFiStatus(R.order_created), "open");
  assertEquals(mapSkyFiStatus(R.order_processing), "shipped");
  assertEquals(mapSkyFiStatus({ ...R.order_delivered, downloadImageUrl: null, downloadPayloadUrl: null, downloadCogUrl: null, downloadViewReadyCogUrl: null }), "shipped");
  assertEquals(mapSkyFiStatus({ status: "PAYMENT_FAILED" }), "failed");
  assertEquals(await a.cancel("fake-order-0001"), false);
});

Deno.test("listCharges: orders since the cutoff, orderCost each, PAYMENT_FAILED skipped, stops at older", async () => {
  const { calls, fetchImpl } = stub([[is("GET", "/orders"), { status: 200, body: R.orders_list }]]);
  const charges = await adapter(fetchImpl).listCharges("2026-10-01T00:00:00Z");
  assertEquals(charges.map((c) => [c.vendorOrderId, c.amountCents]), [["fake-order-0003", 3_500], ["fake-order-0001", 1_500]]);
  assertEquals(calls.length, 1); // the page reached orders older than the cutoff
  const qs = new URL(calls[0].url).searchParams;
  assertEquals(qs.get("pageSize"), "100");
  assertEquals(qs.get("sortDirections"), "desc");
  // the amount for the order place() made equals its chargedCents, so reconcile matches
  const q = await quoted();
  const p = stub([validateOk, whoamiOk, noEarlier, created]);
  const o = await adapter(p.fetchImpl).place(req(), q, 5_000, "example-idem-1");
  assertEquals(charges.find((c) => c.vendorOrderId === o.vendorOrderId)!.amountCents, o.chargedCents);
});

Deno.test("budget: remaining = budgetAmount − currentBudgetUsage (whoami)", async () => {
  const { fetchImpl } = stub([whoamiOk]);
  const b = await adapter(fetchImpl).budget();
  assertEquals(b, { budgetCents: 10_000, usedCents: 2_500, remainingCents: 7_500, hasValidSharedCard: true, isDemoAccount: false });
});

Deno.test("skyFiFromEnv: default base URL, https only", () => {
  const env = (m: Record<string, string | undefined>) => (k: string) => m[k];
  assertEquals(skyFiFromEnv(env({})).baseUrl, SKYFI_DEFAULT_BASE_URL);
  let threw = false;
  try {
    skyFiFromEnv(env({ SKYFI_BASE_URL: "http://skyfi.example" }));
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("registry: skyfi is guarded (DRY_RUN refuses place, reach floor world)", async () => {
  const { calls, fetchImpl } = stub([validateOk, whoamiOk, noEarlier, created]);
  const reg = buildRegistry(["skyfi"], { isStopped: () => false, dryRun: true }, { skyfi: adapter(fetchImpl) });
  const g = reg.skyfi;
  assertEquals(g.reachFor(req({ category: undefined })), "world");
  const q = await g.quote(req());
  assertEquals((await assertRejects(() => g.place(req(), q, 5_000, "k"), GuardRefused)).code, "dry_run");
  assert(!calls.some(isOrderPost));
});

// ── opt-in live quote (validate is free; nothing is ordered) ──────────────
const LIVE = Deno.env.get("SKYFI_LIVE") === "1";
Deno.test({
  name: "LIVE skyfi: budget + archive search + validate (quote only)",
  ignore: !LIVE,
  async fn() {
    const a = skyFiFromEnv();
    const b = await a.budget();
    console.log(`live skyfi budget remaining=${b.remainingCents}c demo=${b.isDemoAccount} card=${b.hasValidSharedCard}`);
    const aoi = pointToWkt(41.29, -73.92, 2.5); // Peekskill waterfront, ~25 km²
    const key = Deno.env.get("SKYFI_API_KEY") ?? "";
    const res = await fetch(`${a.baseUrl}/archives`, {
      method: "POST",
      headers: { "X-Skyfi-Api-Key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ aoi, productTypes: ["DAY"], maxCloudCoveragePercent: 30, pageSize: 10 }),
    });
    const found = (await res.json()).archives as { archiveId: string }[];
    assert(found?.length, "no archive scenes over the test AOI");
    const q = await a.quote(req({ items: [{ sku: `archive:${found[0].archiveId}`, qty: 1 }, { sku: "point:41.29,-73.92,2.5", qty: 1 }] }));
    console.log(`live skyfi quote ${q.vendorRef} total=${q.totalCents}c provider=${(q.raw as { provider: string }).provider}`);
  },
});
