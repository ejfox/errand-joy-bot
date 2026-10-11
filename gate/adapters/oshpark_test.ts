// OSH Park adapter + Gerber bbox tests. Fixture Gerber zips are generated here (stored and deflate
// entries); fetch is stubbed. No network. The one live test is opt-in (OSHPARK_LIVE=1): it uploads
// a tiny 20×20mm outline to OSH Park's documented anonymous import endpoint and orders nothing.
import { assert, assertAlmostEquals, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OWNER_HOME, type PurchaseRequest } from "../types.ts";
import { safeLink } from "../notify.ts";
import { buildRegistry, GuardRefused, knownVendors } from "./registry.ts";
import {
  OshParkAdapter,
  type OshParkAdapterOptions,
  OshParkError,
  oshParkFromEnv,
  oshParkPriceCents,
  OSHPARK_SERVICES,
} from "./oshpark.ts";
import { boardSizeFromZip, findOutline, GerberError, gerberBboxMm, readZip } from "./oshpark_gerber.ts";

// ── fixture builders ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** A minimal valid zip. `deflate` picks method 8 for every entry, else method 0 (stored). */
async function makeZip(files: Record<string, string>, deflate = false): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = deflate ? await deflateRaw(raw) : raw;
    const nm = enc.encode(name);
    const crc = crc32(raw);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, deflate ? 8 : 0, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nm.length, true);
    const local = new Uint8Array([...new Uint8Array(lh.buffer), ...nm, ...data]);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(10, deflate ? 8 : 0, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, nm.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array([...new Uint8Array(ch.buffer), ...nm]));
    locals.push(local);
    offset += local.length;
  }
  const cd = centrals.flatMap((c) => [...c]);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, centrals.length, true);
  eocd.setUint16(10, centrals.length, true);
  eocd.setUint32(12, cd.length, true);
  eocd.setUint32(16, offset, true);
  return new Uint8Array([...locals.flatMap((l) => [...l]), ...cd, ...new Uint8Array(eocd.buffer)]);
}

/** A KiCad-style Edge.Cuts rectangle (mm, 4.6 format) with an X2 Profile attribute. */
function kicadRect(wMm: number, hMm: number, x0 = 100, y0 = -80): string {
  const c = (v: number) => String(Math.round(v * 1e6));
  return [
    "%TF.GenerationSoftware,KiCad,Pcbnew,8.0.0*%",
    "%TF.FileFunction,Profile,NP*%",
    "%FSLAX46Y46*%",
    "G04 Gerber Fmt 4.6, Leading zero omitted, Abs format (unit mm)*",
    "%MOMM*%",
    "%LPD*%",
    "G01*",
    "%ADD10C,0.100000*%",
    "D10*",
    `X${c(x0)}Y${c(y0)}D02*`,
    `X${c(x0 + wMm)}D01*`, // modal Y
    `Y${c(y0 + hMm)}D01*`, // modal X
    `X${c(x0)}D01*`,
    `Y${c(y0)}D01*`,
    "M02*",
  ].join("\n");
}

const COPPER = "%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.2*%\nD10*\nX0Y0D02*\nX900000000Y900000000D01*\nM02*\n";

function kicadZip(wMm: number, hMm: number, deflate = false) {
  return makeZip({
    "board-F_Cu.gbr": COPPER, // a huge copper trace that must NOT be mistaken for the outline
    "board-Edge_Cuts.gbr": kicadRect(wMm, hMm),
    "board.drl": "M48\nMETRIC\nT1C0.3\n%\nT1\nX1.0Y1.0\nM30\n",
  }, deflate);
}

// ── zip + outline detection ───────────────────────────────────────────────
Deno.test("readZip: stored and deflate entries round-trip", async () => {
  for (const deflate of [false, true]) {
    const z = await makeZip({ "a.txt": "hello", "dir/b.gbr": "x".repeat(5000) }, deflate);
    const e = await readZip(z);
    assertEquals(e.map((x) => x.name), ["a.txt", "dir/b.gbr"]);
    assertEquals(new TextDecoder().decode(e[1].bytes), "x".repeat(5000));
  }
  await assertRejects(() => readZip(new Uint8Array([1, 2, 3])), GerberError, "zip_invalid");
});

Deno.test("findOutline: X2 Profile wins; then Edge_Cuts / .gko / .gm1 by name", async () => {
  const x2 = await readZip(await makeZip({ "weird-name.gbr": kicadRect(10, 10), "Edge_Cuts.gbr": COPPER }));
  assertEquals(findOutline(x2).name, "weird-name.gbr");
  const plain = (s: string) => s.replace(/%TF[^%]*%\n/g, "");
  for (const name of ["proj-Edge_Cuts.gbr", "proj.GKO", "proj.gm1", "proj.gml"]) {
    const e = await readZip(await makeZip({ "proj.gtl": COPPER, [name]: plain(kicadRect(10, 10)) }));
    assertEquals(findOutline(e).name, name);
  }
  const none = await readZip(await makeZip({ "proj.gtl": COPPER }));
  assertThrows(() => findOutline(none), GerberError, "gerber_outline_not_found");
});

// ── bbox math ─────────────────────────────────────────────────────────────
Deno.test("bbox: 50×50mm KiCad outline (offset origin, modal coordinates), stored and deflated", async () => {
  for (const deflate of [false, true]) {
    const s = await boardSizeFromZip(await kicadZip(50, 50, deflate));
    assertEquals(s.outlineFile, "board-Edge_Cuts.gbr");
    assertEquals([s.widthMm, s.heightMm], [50, 50]);
    assertAlmostEquals(s.widthIn, 1.9685, 1e-4);
    assertAlmostEquals(s.areaSqIn, 3.875, 1e-4);
  }
});

Deno.test("bbox: inch units, 2.4 format", () => {
  // 2.5" × 1.25" board at (0.5, 0.5): X/Y in 2.4 format = ten-thousandths of an inch.
  const g = "%FSLAX24Y24*%\n%MOIN*%\n%ADD10C,0.0100*%\nD10*\nX5000Y5000D02*\nX30000Y5000D01*\nX30000Y17500D01*\nX5000Y17500D01*\nX5000Y5000D01*\nM02*\n";
  const b = gerberBboxMm(g);
  assertAlmostEquals(b.maxX - b.minX, 63.5, 1e-9);
  assertAlmostEquals(b.maxY - b.minY, 31.75, 1e-9);
});

Deno.test("bbox: arcs count their extremes (a round board, rounded corners, a bulging edge)", () => {
  const head = "%FSLAX46Y46*%\n%MOMM*%\nG75*\n";
  // A full 20mm circle: start == end, so the endpoints alone would be a zero-width box.
  const circle = gerberBboxMm(`${head}X10000000Y0D02*\nG02X10000000Y0I-10000000J0D01*\nM02*\n`);
  assertAlmostEquals(circle.maxX - circle.minX, 20, 1e-9);
  assertAlmostEquals(circle.maxY - circle.minY, 20, 1e-9);
  // A 30×20 slot whose short sides are 180° arcs bulging 10mm left and right: 50×20 overall.
  const slot = gerberBboxMm(
    `${head}X0Y0D02*\nG01X30000000Y0D01*\nG03X30000000Y20000000I0J10000000D01*\n` +
      `G01X0Y20000000D01*\nG03X0Y0I0J-10000000D01*\nM02*\n`,
  );
  assertAlmostEquals(slot.maxX - slot.minX, 50, 1e-9);
  assertAlmostEquals(slot.maxY - slot.minY, 20, 1e-9);
  // Same arcs drawn clockwise the other way round would bulge INWARD: box stays 30×20.
  const inward = gerberBboxMm(
    `${head}X0Y0D02*\nG01X30000000Y0D01*\nG02X30000000Y20000000I0J10000000D01*\n` +
      `G01X0Y20000000D01*\nG02X0Y0I0J-10000000D01*\nM02*\n`,
  );
  assertAlmostEquals(inward.maxX - inward.minX, 30, 1e-9);
});

Deno.test("bbox: refuses files it can't measure", () => {
  assertThrows(() => gerberBboxMm("%FSLAX46Y46*%\n%MOMM*%\nM02*\n"), GerberError, "gerber_outline_empty");
  assertThrows(() => gerberBboxMm("%FSLAX46Y46*%\nX0Y0D02*\nX1Y1D01*\nM02*\n"), GerberError, "gerber_no_units");
  assertThrows(() => gerberBboxMm("%MOMM*%\nX0Y0D02*\nX1Y1D01*\n"), GerberError, "gerber_no_format");
  assertThrows(() => gerberBboxMm("%FSLIX46Y46*%\n%MOMM*%\n"), GerberError, "gerber_incremental_unsupported");
});

// ── price formula ─────────────────────────────────────────────────────────
Deno.test("price: $/sq in × bounding box × sets of 3, rounded once to the cent", () => {
  const sq50 = (50 / 25.4) ** 2; // 3.8750 sq in
  assertEquals(oshParkPriceCents(sq50, "2layer", 3), { cents: 1938, sets: 1 }); // $19.375 → $19.38
  assertEquals(oshParkPriceCents(sq50, "2layer", 6), { cents: 3875, sets: 2 }); // $38.75
  assertEquals(oshParkPriceCents(sq50, "2layer", 4), { cents: 3875, sets: 2 }); // 4 boards → 2 sets
  assertEquals(oshParkPriceCents(1, "2layer", 1), { cents: 500, sets: 1 }); // 1 sq in: $5 per 3
  assertEquals(oshParkPriceCents(1, "2layer-swift", 3).cents, 1000);
  assertEquals(oshParkPriceCents(1, "2layer-afterdark", 3).cents, 500);
  assertEquals(oshParkPriceCents(1, "2layer-2oz", 3).cents, 500);
  assertEquals(oshParkPriceCents(1, "4layer", 3).cents, 1000);
  assertEquals(oshParkPriceCents(1, "4layer-swift", 3).cents, 2000);
  assertEquals(oshParkPriceCents(1, "6layer", 3).cents, 1500);
  assertThrows(() => oshParkPriceCents(1, "flex", 3), GuardRefused, "oshpark_unknown_service");
  assertThrows(() => oshParkPriceCents(1, "2layer", 0), GuardRefused, "oshpark_bad_qty");
  assertThrows(() => oshParkPriceCents(1, "2layer", 31), GuardRefused, "oshpark_bad_qty");
  assert(!Object.hasOwn(OSHPARK_SERVICES, "medium-run"));
});

// ── adapter ───────────────────────────────────────────────────────────────
const TOKEN = "fake-upload-token-0001";

async function setup(opts: Partial<OshParkAdapterOptions> = {}, reply?: (body: FormData) => Response) {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "ejb-oshpark-" });
  await Deno.mkdir(`${dir}/designs`);
  await Deno.mkdir(`${dir}/oshpark`);
  await Deno.writeFile(`${dir}/designs/board.zip`, await kicadZip(50, 50, true));
  const calls: { url: string; method: string; form?: FormData }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const form = init?.body instanceof FormData ? init.body : undefined;
    calls.push({ url: String(input), method: init?.method ?? "GET", form });
    const res = reply ? reply(form!) : Response.json({ token: TOKEN, url: `https://oshpark.com/uploads/${TOKEN}` });
    return Promise.resolve(res);
  }) as typeof fetch;
  const a = new OshParkAdapter({ designsDir: `${dir}/designs`, stateDir: `${dir}/oshpark`, fetchImpl, ...opts });
  return { a, dir, calls };
}

function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: "osh-1",
    requester: "bench-bot",
    taskId: "t-1",
    vendor: "oshpark",
    items: [{ sku: "2layer", qty: 3, title: "sensor breakout", url: "board.zip" }],
    reason: "three copies of the sensor breakout board so the bench prototype stops living on a breadboard",
    reach: "self",
    maxTotalCents: 5_000,
    ...over,
  };
}

Deno.test("quote: price from the zip's outline, no network, free shipping, zip hash bound", async () => {
  const { a, calls } = await setup();
  const q = await a.quote(req());
  assertEquals(calls.length, 0);
  assertEquals([q.subtotalCents, q.taxCents, q.shippingCents, q.totalCents], [1938, 0, 0, 1938]);
  assert(/^oshpark:2layer:[0-9a-f]{64}$/.test(q.vendorRef ?? ""));
  const raw = q.raw as { widthMm: number; heightMm: number; boards: number; handoff: boolean };
  assertEquals([raw.widthMm, raw.heightMm, raw.boards, raw.handoff], [50, 50, 3, true]);
  assertEquals((await a.quote(req({ items: [{ sku: "4layer", qty: 5, url: "board.zip" }] }))).totalCents, 7750);
});

Deno.test("quote: refuses bad input before reading anything outside designs/", async () => {
  const { a, dir } = await setup();
  await Deno.writeTextFile(`${dir}/outside.zip`, "x");
  const q = (items: PurchaseRequest["items"]) => a.quote(req({ items }));
  await assertRejects(() => q([{ sku: "2layer", qty: 3, url: "../outside.zip" }]), OshParkError, "oshpark_zip_outside_designs_dir");
  await assertRejects(() => q([{ sku: "2layer", qty: 3, url: `${dir}/outside.zip` }]), OshParkError, "outside_designs_dir");
  await assertRejects(() => q([{ sku: "2layer", qty: 3, url: "https://example.com/b.zip" }]), OshParkError, "must_be_local_path");
  await assertRejects(() => q([{ sku: "2layer", qty: 3 }]), OshParkError, "oshpark_zip_missing");
  await assertRejects(() => q([{ sku: "flex", qty: 3, url: "board.zip" }]), OshParkError, "oshpark_unknown_service");
  await assertRejects(
    () => q([{ sku: "2layer", qty: 3, url: "board.zip" }, { sku: "2layer", qty: 3, url: "board.zip" }]),
    OshParkError,
    "one_board_per_request",
  );
  await Deno.writeFile(`${dir}/designs/empty.zip`, await makeZip({ "x.gtl": COPPER }));
  await assertRejects(() => q([{ sku: "2layer", qty: 3, url: "empty.zip" }]), OshParkError, "oshpark_gerber_outline_not_found");
});

Deno.test("place: uploads the quoted zip, charges 0, hands off with the uploads link", async () => {
  const { a, calls } = await setup();
  const r = req();
  const q = await a.quote(r);
  const o = await a.place(r, q, 1938, "osh-1");
  assertEquals(calls.length, 1);
  assertEquals([calls[0].method, calls[0].url], ["POST", "https://oshpark.com/import.json"]);
  const f = calls[0].form?.get("file");
  assert(f instanceof File);
  assertEquals(f.name, "board.zip");
  assertEquals(o.vendorOrderId, TOKEN);
  assertEquals(o.chargedCents, 0);
  const raw = o.raw as { links: string[]; handoff: boolean; blocked: string };
  assertEquals(raw.handoff, true);
  assertEquals(raw.blocked, "handoff");
  assertEquals(raw.links, [`https://oshpark.com/uploads/${TOKEN}`]);
  assertEquals(safeLink(raw.links[0]), raw.links[0]); // survives the gate's link sanitizer
});

Deno.test("place: refuses a swapped file, a third-party address, an over-cap quote, a bad reply", async () => {
  const { a, dir, calls } = await setup();
  const r = req();
  const q = await a.quote(r);
  await assertRejects(() => a.place(r, q, 1937, "k"), GuardRefused, "max_price_exceeded");
  const other = req({ shipTo: { name: "N", line1: "1 St", city: "C", state: "NY", zip: "10001" } });
  await assertRejects(() => a.place(other, q, 5000, "k"), GuardRefused, "oshpark_third_party_shipto_unsupported");
  await Deno.writeFile(`${dir}/designs/board.zip`, await kicadZip(10, 10));
  await assertRejects(() => a.place(r, q, 5000, "k"), GuardRefused, "oshpark_file_changed");
  assertEquals(calls.length, 0);

  const bad = await setup({}, () => Response.json({ token: "../../etc" }));
  const q2 = await bad.a.quote(r);
  await assertRejects(() => bad.a.place(r, q2, 5000, "k"), GuardRefused, "oshpark_upload_malformed");
  const down = await setup({}, () => new Response("oops", { status: 503 }));
  const q3 = await down.a.quote(r);
  await assertRejects(() => down.a.place(r, q3, 5000, "k"), GuardRefused, "oshpark_upload_http_503");
});

Deno.test("status: open (still blocked, with link) until the owner drops a marker", async () => {
  const { a, dir } = await setup();
  const open = await a.status(TOKEN);
  assertEquals(open.state, "open");
  assertEquals((open.raw as { blocked: string }).blocked, "handoff");
  await Deno.writeTextFile(`${dir}/oshpark/${TOKEN}.delivered`, "");
  const done = await a.status(TOKEN);
  assertEquals(done.state, "delivered");
  assertEquals((done.raw as { links: string[] }).links, [`https://oshpark.com/uploads/${TOKEN}`]);
  await Deno.writeTextFile(`${dir}/oshpark/${TOKEN}.cancelled`, "");
  assertEquals((await a.status(TOKEN)).state, "cancelled");
  await assertRejects(() => a.status("../x"), OshParkError, "oshpark_bad_order_id");
});

Deno.test("listCharges is always [] and cancel is a no-op true; reach self, others off-home", async () => {
  const { a } = await setup();
  assertEquals(await a.listCharges(new Date(0).toISOString()), []);
  assertEquals(await a.cancel(TOKEN), true);
  assertEquals(a.reachFor(req()), "self");
  assertEquals(a.reachFor(req({ shipTo: OWNER_HOME })), "self");
  assertEquals(a.reachFor(req({ shipTo: { name: "N", line1: "1", city: "C", state: "NY", zip: "10001" } })), "others");
  const q = await a.quote(req());
  await a.pause();
  await assertRejects(() => a.place(req(), q, 5000, "k"), GuardRefused, "vendor_paused");
});

Deno.test("registry: oshpark is known, guarded, and DRY_RUN refuses its upload", async () => {
  assert(knownVendors().includes("oshpark"));
  assertEquals(oshParkFromEnv((k) => ({ DATA_DIR: "/srv/data/" } as Record<string, string>)[k]).stateDir, "/srv/data/oshpark");
  const { a, calls } = await setup();
  const reg = buildRegistry(["oshpark"], { isStopped: () => false, dryRun: true }, { oshpark: a });
  const q = await reg.oshpark.quote(req());
  await assertRejects(() => reg.oshpark.place(req(), q, 5000, "k"), GuardRefused, "dry_run");
  assertEquals(calls.length, 0);
  const live = buildRegistry(["oshpark"], { isStopped: () => false, dryRun: false }, { oshpark: a });
  assertEquals((await live.oshpark.place(req(), q, 5000, "k")).chargedCents, 0);
});

// ── opt-in live upload ────────────────────────────────────────────────────
// OSHPARK_LIVE=1 deno test --allow-read --allow-write=/tmp --allow-env --allow-net=oshpark.com \
//   --filter LIVE gate/adapters/oshpark_test.ts
// The documented import endpoint is anonymous (no account, no key) and creates no order: it only
// stores the zip and returns an uploads link. Nothing is checked out, nothing is charged.
Deno.test({
  name: "LIVE oshpark: anonymous upload of a 20×20mm outline (never orders)",
  ignore: Deno.env.get("OSHPARK_LIVE") !== "1",
  async fn() {
    const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "ejb-oshpark-live-" });
    await Deno.mkdir(`${dir}/designs`);
    await Deno.writeFile(`${dir}/designs/live.zip`, await kicadZip(20, 20, true));
    const a = new OshParkAdapter({ designsDir: `${dir}/designs`, stateDir: `${dir}/oshpark` });
    const r = req({ items: [{ sku: "2layer", qty: 3, url: "live.zip" }] });
    const q = await a.quote(r);
    assertEquals(q.totalCents, 310); // 0.62 sq in × $5 = $3.10
    const o = await a.place(r, q, q.totalCents, "live");
    assertEquals(o.chargedCents, 0);
    console.log("uploaded:", (o.raw as { links: string[] }).links[0]);
  },
});
