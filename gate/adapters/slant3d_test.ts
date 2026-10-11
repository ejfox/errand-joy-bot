// Slant 3D adapter tests: fixtures shaped from the v2 OpenAPI spec and docs, and a stubbed fetch.
// No network. The one live test is opt-in (SLANT3D_LIVE=1) and only quotes: it never processes.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest, type Quote } from "../types.ts";
import { buildRegistry, GuardRefused, knownVendors } from "./registry.ts";
import {
  mapSlantStatus,
  parseSlantSku,
  pickFilament,
  Slant3dAdapter,
  type Slant3dAdapterOptions,
  Slant3dError,
  slant3dFromEnv,
  sniffDesign,
  usdToCents,
} from "./slant3d.ts";

const FX = new URL("./slant3d_fixtures/", import.meta.url);
const fx = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, FX)));
const FIL = fx("filaments.json");
const UP = fx("upload.json");
const ORD = fx("orders.json");
const BASE = "https://slant3dapi.com/v2/api";

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

/** A closed unit cube as a binary STL (12 triangles). */
function cubeStl(size = 10): Uint8Array {
  const v = (x: number, y: number, z: number) => [x * size, y * size, z * size];
  const quads = [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
    [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
    [v(1, 1, 0), v(0, 1, 0), v(0, 1, 1), v(1, 1, 1)],
    [v(0, 1, 0), v(0, 0, 0), v(0, 0, 1), v(0, 1, 1)],
  ];
  const tris = quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]);
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => t.flat().forEach((n, j) => dv.setFloat32(84 + 50 * i + 12 + 4 * j, n, true)));
  return new Uint8Array(buf);
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  raw?: unknown;
  auth?: string;
}
type Reply = { status: number; body?: unknown; bytes?: Uint8Array };

function stub(routes: [(c: Call) => boolean, Reply | ((c: Call) => Reply)][]) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const c: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      raw: init?.body,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: h.get("authorization") ?? undefined,
    };
    calls.push(c);
    const hit = routes.find(([p]) => p(c));
    if (!hit) return Promise.resolve(new Response(JSON.stringify(ORD.errors.not_found), { status: 404 }));
    const r = typeof hit[1] === "function" ? hit[1](c) : hit[1];
    if (r.bytes) return Promise.resolve(new Response(r.bytes as BodyInit, { status: r.status }));
    const body = r.body === undefined ? null : JSON.stringify(r.body);
    return Promise.resolve(new Response(body, { status: r.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const is = (method: string, path: string) => (c: Call) => c.method === method && c.url === `${BASE}${path}`;
const QUOTE_ROUTES: [(c: Call) => boolean, Reply][] = [
  [is("GET", "/filaments"), { status: 200, body: FIL }],
  [is("POST", "/files/direct-upload"), { status: 200, body: UP.direct_upload }],
  [(c) => c.method === "PUT" && c.url.startsWith("https://example-bucket."), { status: 200 }],
  [is("POST", "/files/confirm-upload"), { status: 200, body: UP.confirm_upload }],
  [is("POST", "/orders"), { status: 201, body: ORD.draft }],
];

const TEMP_DIRS: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const d of TEMP_DIRS) {
    try {
      Deno.removeSync(d, { recursive: true });
    } catch { /* already gone */ }
  }
});

async function designsDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "ejb-slant-" });
  TEMP_DIRS.push(dir);
  await Deno.mkdir(`${dir}/designs`);
  await Deno.writeFile(`${dir}/designs/example-box-base.stl`, cubeStl());
  await Deno.writeTextFile(`${dir}/outside.stl`, "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\n");
  return dir;
}

function adapter(o: Partial<Slant3dAdapterOptions> & { fetchImpl: typeof fetch; dir: string }) {
  return new Slant3dAdapter({
    apiKey: "test-slant-key",
    platformId: "test-platform-0001",
    customerEmail: "test@example.com",
    ownerShipTo: OWNER,
    designsDir: `${o.dir}/designs`,
    ...o,
  });
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "test-idem-0001",
    requester: "test-agent",
    taskId: "test-task",
    vendor: "slant3d",
    items: [{ sku: "PLA:black", qty: 1, title: "example box base", url: "example-box-base.stl" }],
    reason: "a test enclosure for the example sensor board, generated by tools/design/box.ts",
    reach: "self",
    maxTotalCents: 3_000,
    shipTo: OWNER_HOME,
    ...over,
  };
}

Deno.test("sku parsing: PROFILE:color, profiles from the spec enum only", () => {
  assertEquals(parseSlantSku("PLA:black"), { profile: "PLA", color: "black" });
  assertEquals(parseSlantSku(" petg : Matte  Black "), { profile: "PETG", color: "matte black" });
  for (const bad of ["ABS:black", "PLA", "PLA:", ":black", "PLA:bl4ck", "PLA:black;DROP"]) {
    assertThrows(() => parseSlantSku(bad), Slant3dError);
  }
});

Deno.test("filament pick: exact color wins, a unique partial is ok, ambiguous and unavailable refuse", () => {
  const f = FIL.data;
  assertEquals(pickFilament(f, "PLA:black"), "test-filament-pla-black"); // not matte black
  assertEquals(pickFilament(f, "PLA:matte black"), "test-filament-pla-matte-black");
  assertEquals(pickFilament(f, "PLA:white"), "test-filament-pla-white"); // availability unknown → allowed
  assertEquals(pickFilament(f, "PETG:dark"), "test-filament-petg-dark-blue");
  assertThrows(() => pickFilament(f, "PETG:blue"), Slant3dError, "slant3d_filament_ambiguous");
  assertThrows(() => pickFilament(f, "PETG:red"), Slant3dError, "slant3d_filament_not_found"); // available:false
  assertThrows(() => pickFilament(f, "OPM:black"), Slant3dError, "slant3d_filament_not_found");
});

Deno.test("usdToCents: exact decimal strings, rounded numbers, junk refused", () => {
  assertEquals(usdToCents("35.53"), 3553);
  assertEquals(usdToCents("4.7"), 470);
  assertEquals(usdToCents("12"), 1200);
  assertEquals(usdToCents(0.29), 29);
  assertEquals(usdToCents(40.32), 4032);
  for (const bad of ["-1.00", "1.234", "abc", "", null, undefined, -3, NaN]) assertEquals(usdToCents(bad), undefined);
});

Deno.test("sniffDesign: binary and ASCII STL pass, junk and truncated files fail", () => {
  sniffDesign(cubeStl(), "stl");
  sniffDesign(new TextEncoder().encode("solid t\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n"), "stl");
  assertThrows(() => sniffDesign(cubeStl().subarray(0, 200), "stl"), Slant3dError, "slant3d_bad_stl");
  assertThrows(() => sniffDesign(new TextEncoder().encode("<html>not a model</html>"), "stl"), Slant3dError);
  assertThrows(() => sniffDesign(new Uint8Array(), "stl"), Slant3dError, "slant3d_empty_file");
  sniffDesign(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]), "3mf");
  assertThrows(() => sniffDesign(cubeStl(), "3mf"), Slant3dError, "slant3d_bad_3mf");
});

Deno.test("quote: upload via presigned URL, then a draft order; total = printing + delivery", async () => {
  const dir = await designsDir();
  const s = stub(QUOTE_ROUTES);
  const a = adapter({ fetchImpl: s.fetchImpl, dir });
  const q = await a.quote(req());
  assertEquals([q.subtotalCents, q.taxCents, q.shippingCents, q.totalCents], [406, 0, 479, 885]);
  assertEquals(q.vendorRef, "test-order-0001");
  assertEquals(q.feeCents, undefined);

  const put = s.calls.find((c) => c.method === "PUT")!;
  assertEquals(put.auth, undefined, "the API key never goes to the storage host");
  assert(put.raw instanceof Uint8Array && put.raw.length === cubeStl().length);
  const up = s.calls.find((c) => c.url.endsWith("/files/direct-upload"))!;
  assertEquals(up.auth, "Bearer test-slant-key");
  assertEquals(up.body, { name: "example-box-base.stl", platformId: "test-platform-0001", ownerId: "errand-joy-bot" });
  const conf = s.calls.find((c) => c.url.endsWith("/files/confirm-upload"))!;
  assertEquals(conf.body, { filePlaceholder: UP.direct_upload.data.filePlaceholder }, "placeholder passed verbatim");
  const draft = s.calls.find((c) => c.method === "POST" && c.url === `${BASE}/orders`)!;
  assertEquals(draft.body?.platformId, "test-platform-0001");
  assertEquals(draft.body?.items, [
    { type: "PRINT", publicFileServiceId: "test-file-0001", filamentId: "test-filament-pla-black", quantity: 1 },
  ]);
  assertEquals((draft.body?.customer as { details: unknown }).details, {
    email: "test@example.com",
    address: { name: "Example Owner", line1: "101 Example St", city: "Exampleville", state: "NY", zip: "10001", country: "US" },
  });
  assert(!s.calls.some((c) => /\/orders\/[^/]+$/.test(c.url) && c.method === "POST"), "quote never processes");

  // A re-quote reuses the uploaded file (500 uploads/day/platform cap) but drafts again.
  const before = s.calls.length;
  await a.quote(req());
  const again = s.calls.slice(before);
  assertEquals(again.filter((c) => c.url.includes("/files/")).length, 0);
  assertEquals(again.filter((c) => c.method === "POST" && c.url === `${BASE}/orders`).length, 1);
});

Deno.test("quote: local designs must resolve inside DATA_DIR/designs; type and shape checked", async () => {
  const dir = await designsDir();
  const s = stub(QUOTE_ROUTES);
  const a = adapter({ fetchImpl: s.fetchImpl, dir });
  const withUrl = (url?: string) => req({ items: [{ sku: "PLA:black", qty: 1, url }] });
  await assertRejects(() => a.quote(withUrl("../outside.stl")), Slant3dError, "slant3d_design_outside_designs_dir");
  await assertRejects(() => a.quote(withUrl(`${dir}/outside.stl`)), Slant3dError, "slant3d_design_outside_designs_dir");
  await assertRejects(() => a.quote(withUrl("missing.stl")), Slant3dError, "slant3d_design_not_found");
  await assertRejects(() => a.quote(withUrl(undefined)), Slant3dError, "slant3d_item_url_missing");
  await Deno.writeTextFile(`${dir}/designs/notes.txt`, "hi");
  await assertRejects(() => a.quote(withUrl("notes.txt")), Slant3dError, "slant3d_unsupported_file_type");
  await Deno.writeTextFile(`${dir}/designs/fake.stl`, "this is not an stl");
  await assertRejects(() => a.quote(withUrl("fake.stl")), Slant3dError, "slant3d_bad_stl");
  await assertRejects(() => a.quote(withUrl("http://example.com/x.stl")), Slant3dError, "slant3d_item_url_invalid");
  await assertRejects(() => a.quote(withUrl("file:///etc/passwd.stl")), Slant3dError, "slant3d_item_url_invalid");
  await assertRejects(() => a.quote(req({ items: [{ sku: "ABS:black", qty: 1, url: "example-box-base.stl" }] })), Slant3dError);
  await assertRejects(() => a.quote(req({ items: [{ sku: "PLA:black", qty: 0, url: "example-box-base.stl" }] })), Slant3dError);
  assert(!s.calls.some((c) => c.url.includes("/files/direct-upload")), "nothing uploaded for a refused design");
});

Deno.test("quote: an https design URL is fetched by the gate host, then uploaded", async () => {
  const dir = await designsDir();
  const s = stub([
    [(c) => c.method === "GET" && c.url === "https://example.com/designs/example-lid.stl", { status: 200, bytes: cubeStl(20) }],
    ...QUOTE_ROUTES,
  ]);
  const a = adapter({ fetchImpl: s.fetchImpl, dir });
  const q = await a.quote(req({ items: [{ sku: "PLA:black", qty: 1, url: "https://example.com/designs/example-lid.stl" }] }));
  assertEquals(q.totalCents, 885);
  const fetchCall = s.calls.find((c) => c.url.startsWith("https://example.com/"))!;
  assertEquals(fetchCall.auth, undefined, "the API key never goes to the design host");
  assertEquals(s.calls.find((c) => c.url.endsWith("/files/direct-upload"))!.body?.name, "example-lid.stl");
});

Deno.test("quote: refuses without key, platform or email; over maxUnitCents", async () => {
  const dir = await designsDir();
  const s = stub(QUOTE_ROUTES);
  await assertRejects(() => adapter({ fetchImpl: s.fetchImpl, dir, apiKey: "" }).quote(req()), Slant3dError, "slant3d_api_key_missing");
  await assertRejects(() => adapter({ fetchImpl: s.fetchImpl, dir, platformId: "" }).quote(req()), Slant3dError, "slant3d_platform_id_missing");
  await assertRejects(() => adapter({ fetchImpl: s.fetchImpl, dir, customerEmail: "" }).quote(req()), Slant3dError, "slant3d_customer_email_missing");
  await assertRejects(() => adapter({ fetchImpl: s.fetchImpl, dir, ownerShipTo: undefined }).quote(req()), Slant3dError, "slant3d_owner_address_missing");
  const a = adapter({ fetchImpl: s.fetchImpl, dir });
  await assertRejects(
    () => a.quote(req({ items: [{ sku: "PLA:black", qty: 1, url: "example-box-base.stl", maxUnitCents: 400 }] })),
    Slant3dError,
    "slant3d_over_max_unit",
  );
  assertEquals(s.calls.length, s.calls.filter((c) => !c.url.includes("/orders/")).length);
});

Deno.test("reach: self for owner-home, others for a third-party address (mapped onto Slant's Address)", async () => {
  const dir = await designsDir();
  const s = stub(QUOTE_ROUTES);
  const a = adapter({ fetchImpl: s.fetchImpl, dir });
  assertEquals(a.maxReach, "others");
  assertEquals(a.reachFor(req()), "self");
  assertEquals(a.reachFor(req({ shipTo: undefined })), "self");
  const shipTo = { name: "Example Friend", line1: "5 Example Ave", city: "Testville", state: "ca", zip: "90001" };
  assertEquals(a.reachFor(req({ shipTo })), "others");
  await a.quote(req({ shipTo }));
  const draft = s.calls.find((c) => c.method === "POST" && c.url === `${BASE}/orders`)!;
  assertEquals((draft.body?.customer as { details: { address: unknown } }).details.address, {
    name: "Example Friend",
    line1: "5 Example Ave",
    city: "Testville",
    state: "CA",
    zip: "90001",
    country: "US",
  });
  await assertRejects(() => a.quote(req({ shipTo: { ...shipTo, zip: "9" } })), Slant3dError, "slant3d_bad_shipto");
});

async function quoted(dir: string) {
  const s = stub(QUOTE_ROUTES);
  return await adapter({ fetchImpl: s.fetchImpl, dir }).quote(req());
}

Deno.test("place: re-reads the draft, processes it, charged = printing + delivery", async () => {
  const dir = await designsDir();
  const q = await quoted(dir);
  const s = stub([
    [is("GET", "/orders/test-order-0001"), { status: 200, body: ORD.get_draft }],
    [is("POST", "/orders/test-order-0001"), { status: 200, body: ORD.process }],
  ]);
  const a = adapter({ fetchImpl: s.fetchImpl, dir });
  const o = await a.place(req(), q, 1_000, "test-idem-0001");
  assertEquals(o.vendorOrderId, "test-order-0001");
  assertEquals(o.chargedCents, 885);
  assertEquals(s.calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`), ["GET /orders/test-order-0001", "POST /orders/test-order-0001"]);
});

Deno.test("place: refuses BEFORE processing when the draft drifted, is over the cap or holds other files", async () => {
  const dir = await designsDir();
  const q = await quoted(dir);
  const draftWith = (patch: Record<string, unknown>) => {
    const d = structuredClone(ORD.get_draft);
    Object.assign(d.data.order, patch);
    return d;
  };
  const cases: [Record<string, unknown> | null, number, string][] = [
    [{ deliveryCost: "9.79" }, 5_000, "slant3d_draft_changed"],
    [null, 884, "max_price_exceeded"],
    [{ items: [{ type: "PRINT", quantity: 2, publicFileServiceId: "test-file-0001", filamentId: "test-filament-pla-black" }] }, 5_000, "slant3d_draft_items_mismatch"],
    [{ items: [{ type: "PRINT", quantity: 1, publicFileServiceId: "test-file-9999", filamentId: "test-filament-pla-black" }] }, 5_000, "slant3d_draft_items_mismatch"],
    [{ status: "CANCELED" }, 5_000, "slant3d_draft_canceled"],
    [{ printingCost: "n/a" }, 5_000, "slant3d_draft_without_costs"],
  ];
  for (const [patch, cap, code] of cases) {
    const s = stub([[is("GET", "/orders/test-order-0001"), { status: 200, body: patch ? draftWith(patch) : ORD.get_draft }]]);
    const a = adapter({ fetchImpl: s.fetchImpl, dir });
    const e = await assertRejects(() => a.place(req(), q, cap, "k"), GuardRefused);
    assertEquals(e.code, code);
    assert(!s.calls.some((c) => c.method === "POST"), `${code}: never processed`);
  }
  const s = stub([]);
  const a = adapter({ fetchImpl: s.fetchImpl, dir });
  assertEquals((await assertRejects(() => a.place(req(), { ...q, vendorRef: undefined }, 5_000, "k"), GuardRefused)).code, "slant3d_quote_without_draft");
  assertEquals((await assertRejects(() => a.place(req(), { ...q, vendorRef: "../x" }, 5_000, "k"), GuardRefused)).code, "slant3d_quote_without_draft");
  assertEquals((await assertRejects(() => a.place(req(), q, 5_000, "k"), GuardRefused)).code, "slant3d_draft_unreadable");
  await a.pause();
  assertEquals((await assertRejects(() => a.place(req(), q, 5_000, "k"), GuardRefused)).code, "vendor_paused");
  assertEquals(s.calls.filter((c) => c.method === "POST").length, 0);
});

Deno.test("place: an already-processed draft is returned, not processed twice", async () => {
  const dir = await designsDir();
  const q = await quoted(dir);
  const paid = structuredClone(ORD.get_draft);
  Object.assign(paid.data.order, { status: "PAID", paymentId: "test-payment-0001" });
  const s = stub([[is("GET", "/orders/test-order-0001"), { status: 200, body: paid }]]);
  const o = await adapter({ fetchImpl: s.fetchImpl, dir }).place(req(), q, 1_000, "k");
  assertEquals([o.vendorOrderId, o.chargedCents], ["test-order-0001", 885]);
  assertEquals(s.calls.filter((c) => c.method === "POST").length, 0);
});

Deno.test("place errors: 4xx with the order still a draft → GuardRefused; 5xx / network / over-cap charge → Slant3dError", async () => {
  const dir = await designsDir();
  const q = await quoted(dir);
  const get = [is("GET", "/orders/test-order-0001"), { status: 200, body: ORD.get_draft }] as [(c: Call) => boolean, Reply];

  let s = stub([[is("POST", "/orders/test-order-0001"), { status: 402, body: ORD.errors.server }], get]);
  assertEquals((await assertRejects(() => adapter({ fetchImpl: s.fetchImpl, dir }).place(req(), q, 1_000, "k"), GuardRefused)).code, "slant3d_process_http_402");

  s = stub([[is("POST", "/orders/test-order-0001"), { status: 500, body: ORD.errors.server }], get]);
  await assertRejects(() => adapter({ fetchImpl: s.fetchImpl, dir }).place(req(), q, 1_000, "k"), Slant3dError, "slant3d_process_http_500");

  const flaky = stub([get]);
  const net = ((input: string | URL | Request, init?: RequestInit) =>
    init?.method === "POST" ? Promise.reject(new TypeError("connection reset")) : flaky.fetchImpl(input, init)) as typeof fetch;
  await assertRejects(() => adapter({ fetchImpl: net, dir }).place(req(), q, 1_000, "k"), Slant3dError, "slant3d_network_error");

  const pricier = structuredClone(ORD.process);
  pricier.data.printingCost = "40.00";
  s = stub([[is("POST", "/orders/test-order-0001"), { status: 200, body: pricier }], get]);
  await assertRejects(() => adapter({ fetchImpl: s.fetchImpl, dir }).place(req(), q, 1_000, "k"), Slant3dError, "slant3d_charged_over_cap");
});

Deno.test("status: lifecycle mapping and tracking from fulfillment", async () => {
  for (const st of ["DRAFT", "PAID", "QUEUED", "PRINTING", "ITEMS_ON_SHELF", "POST_PROCESSING", "COMPLETED", "IN_REVIEW", "AWAITING_SHIPMENT"]) {
    assertEquals(mapSlantStatus(st), "open");
  }
  assertEquals(mapSlantStatus("SHIPPED"), "shipped");
  assertEquals(mapSlantStatus("DELIVERED"), "delivered");
  assertEquals(mapSlantStatus("CANCELED"), "cancelled");
  assertEquals(mapSlantStatus("PAYMENT_ERROR"), "failed");
  const dir = await designsDir();
  const s = stub([[is("GET", "/orders/test-order-0001"), { status: 200, body: ORD.get_shipped }]]);
  const r = await adapter({ fetchImpl: s.fetchImpl, dir }).status("test-order-0001");
  assertEquals([r.state, r.tracking], ["shipped", "test-tracking-0001"]);
});

Deno.test("cancel: DELETE → true; 404 / 401 → false; 5xx throws", async () => {
  const dir = await designsDir();
  let s = stub([[is("DELETE", "/orders/test-order-0001"), { status: 200, body: ORD.cancel }]]);
  assertEquals(await adapter({ fetchImpl: s.fetchImpl, dir }).cancel("test-order-0001"), true);
  s = stub([[is("DELETE", "/orders/test-order-0001"), { status: 401, body: ORD.errors.unauthorized }]]);
  assertEquals(await adapter({ fetchImpl: s.fetchImpl, dir }).cancel("test-order-0001"), false);
  s = stub([]);
  assertEquals(await adapter({ fetchImpl: s.fetchImpl, dir }).cancel("test-order-0404"), false);
  s = stub([[is("DELETE", "/orders/test-order-0001"), { status: 503, body: ORD.errors.server }]]);
  await assertRejects(() => adapter({ fetchImpl: s.fetchImpl, dir }).cancel("test-order-0001"), Slant3dError);
});

Deno.test("listCharges: processed orders only (no drafts, cancels, payment errors), filtered by processedAt", async () => {
  const dir = await designsDir();
  const s = stub([[(c) => c.method === "GET" && c.url.startsWith(`${BASE}/orders?`), { status: 200, body: ORD.list }]]);
  const a = adapter({ fetchImpl: s.fetchImpl, dir });
  const recent = await a.listCharges("2026-10-10T00:00:00.000Z");
  assertEquals(recent, [{ vendorChargeId: "test-payment-0001", amountCents: 885, at: "2026-10-11T12:05:00.000Z", vendorOrderId: "test-order-0001" }]);
  const qs = new URL(s.calls[0].url).searchParams;
  assertEquals([qs.get("startDate"), qs.get("page"), qs.get("limit")], ["2026-10-03", "1", "100"]);
  const all = await a.listCharges("2026-10-01T00:00:00.000Z");
  assertEquals(all.map((c) => [c.vendorChargeId, c.amountCents]), [["test-payment-0001", 885], ["test-order-0004", 4032]]);
  await assertRejects(() => a.listCharges("not a date"), Slant3dError);
});

Deno.test("env + registry: slant3d is a known vendor, guarded, and DRY_RUN refuses place()", async () => {
  assert(knownVendors().includes("slant3d"));
  const a = slant3dFromEnv((k) => ({ DATA_DIR: "/tmp/example-data/" } as Record<string, string>)[k]);
  assertEquals(a.designsDir, "/tmp/example-data/designs");
  await assertRejects(() => a.quote(req()), Slant3dError, "slant3d_api_key_missing");
  assertThrows(() => slant3dFromEnv((k) => (k === "SLANT3D_BASE_URL" ? "http://example.com" : undefined)));
  const dir = await designsDir();
  const s = stub([]);
  const reg = buildRegistry(["slant3d"], { isStopped: () => false, dryRun: true }, {
    slant3d: adapter({ fetchImpl: s.fetchImpl, dir }),
  });
  const q: Quote = { subtotalCents: 1, taxCents: 0, shippingCents: 0, totalCents: 1, currency: "USD", vendorRef: "test-order-0001", quotedAt: "" };
  assertEquals((await assertRejects(() => reg.slant3d.place(req(), q, 100, "k"), GuardRefused)).code, "dry_run");
  assertEquals(reg.slant3d.reachFor(req({ shipTo: { name: "Example", line1: "1 Example", city: "X", state: "NY", zip: "10001" } })), "others");
  assertEquals(s.calls.length, 0);
});

// ── Opt-in live test: quote ONLY. Never processes an order. ──────────────────
// SLANT3D_LIVE=1 SLANT3D_API_KEY=… SLANT3D_PLATFORM_ID=… [SLANT3D_CUSTOMER_EMAIL=… OWNER_SHIP_TO_JSON=…] \
//   deno test --allow-read --allow-write=/tmp --allow-env --allow-net=slant3dapi.com,<s3 upload host> \
//   --filter LIVE gate/adapters/slant3d_test.ts
const LIVE = Deno.env.get("SLANT3D_LIVE") === "1";
Deno.test({
  name: "LIVE slant3d: filaments → upload → estimate → draft quote (never processes)",
  ignore: !LIVE,
  async fn() {
    const real = (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST" && /\/orders\/[^/?]+$/.test(url)) {
        throw new Error("live test refuses to process an order");
      }
      return fetch(input, init);
    };
    const dir = await designsDir();
    const b = new Slant3dAdapter({
      apiKey: Deno.env.get("SLANT3D_API_KEY"),
      baseUrl: Deno.env.get("SLANT3D_BASE_URL"),
      platformId: Deno.env.get("SLANT3D_PLATFORM_ID"),
      customerEmail: Deno.env.get("SLANT3D_CUSTOMER_EMAIL"),
      ownerShipTo: Deno.env.get("OWNER_SHIP_TO_JSON"),
      designsDir: `${dir}/designs`,
      fetchImpl: real as typeof fetch,
    });
    const filaments = await b.filaments();
    console.log(`filaments: ${filaments.length} (${[...new Set(filaments.map((f) => f.profile))].join(", ")})`);
    const { fileId } = await b.ensureFile({ url: "example-box-base.stl" });
    const est = await b.estimate(fileId, pickFilament(filaments, "PLA:black"));
    console.log(`estimate (print only, 10mm cube, PLA black): $${(est.totalCents / 100).toFixed(2)}`);
    if (Deno.env.get("SLANT3D_CUSTOMER_EMAIL") && Deno.env.get("OWNER_SHIP_TO_JSON")) {
      const q = await b.quote(req());
      // The draft is left as a DRAFT: never charged, and listCharges skips it.
      console.log(`draft ${q.vendorRef}: print $${(q.subtotalCents / 100).toFixed(2)} + ship $${(q.shippingCents / 100).toFixed(2)}`);
    }
  },
});
