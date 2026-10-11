import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  approvalDm,
  clean,
  deliveredWhyNoteDm,
  extractMessageId,
  FakeHealthAlerter,
  FakeNotifier,
  fundVetoDm,
  HEALTH_ALERT_TEXT,
  HttpDmNotifier,
  inQuietHours,
  isSafeEndpoint,
  makeHealthAlerter,
  makeNotifier,
  NoopHealthAlerter,
  NtfyNotifier,
  needsActionDm,
  quietHoursConfig,
  safeLink,
  stopDm,
  VENDOR_ACTION_HINTS,
  VENDOR_LABELS,
  vendorLabel,
  vetoDm,
} from "./notify.ts";
import { knownVendors } from "./adapters/registry.ts";

Deno.test("every registered vendor has a sealed-DM label (a category, not a product)", () => {
  for (const v of knownVendors()) assert(Object.hasOwn(VENDOR_LABELS, v), `no label for ${v}`);
  assertEquals(vendorLabel("prodigi"), "art print (Prodigi)");
  assertEquals(vendorLabel("skyfi"), "satellite image (SkyFi)");
  assertEquals(vendorLabel("zinc"), "Amazon via Zinc");
  assertEquals(vendorLabel("not-a-vendor<script>"), "not-a-vendorscript");
});

Deno.test("needsActionDm: '<label> order needs you: <hint>', static hint, no URL from the vendor", () => {
  const dm = needsActionDm({ vendor: "prodigi", needsAction: "RequiresPaymentAuthorisation" });
  assertEquals(dm, `art print (Prodigi) order needs you: ${VENDOR_ACTION_HINTS.prodigi}`);
  const other = needsActionDm({ vendor: "fakeshop", needsAction: "https://evil.example/x" });
  assert(other.startsWith("fakeshop order needs you: ") && !other.includes("://"), other);
});

Deno.test("safeLink: https only; links carrying apiKey/key/token are dropped, never DMed", () => {
  assertEquals(safeLink("https://certs.example/tree/1"), "https://certs.example/tree/1");
  assertEquals(safeLink("https://dl.example/f?id=3&format=tif"), "https://dl.example/f?id=3&format=tif");
  for (
    const bad of [
      "http://certs.example/x",
      "https://user:pw@certs.example/x",
      "https://api.mouser.example/order?apiKey=abc",
      "https://x.example/d?KEY=abc",
      "https://x.example/d?token=abc",
      "https://x.example/d?access_token=abc",
      "https://x.example/d?api_key=abc",
      "https://x.example/d#token=abc",
      "https://x.example/a b",
      "https://x.example/<x>",
      "javascript:alert(1)",
      "https://x.example/" + "a".repeat(2000),
      42,
      undefined,
    ]
  ) assertEquals(safeLink(bad), undefined, String(bad).slice(0, 60));
});

Deno.test("why-note DM: delivery links wrapped in <>, max 3, https only", () => {
  const dm = deliveredWhyNoteDm({
    items: [{ sku: "T1", qty: 5, title: "trees" }],
    reason: "a forest for the hudson valley because the robot likes moss",
    links: ["https://c.example/1", "https://c.example/2", "https://c.example/3", "https://c.example/4", "http://c.example/5"],
  });
  assertEquals(dm.split("\n").filter((l) => l.startsWith("delivery: ")), [
    "delivery: <https://c.example/1>",
    "delivery: <https://c.example/2>",
    "delivery: <https://c.example/3>",
  ]);
});

const NY = { start: 22 * 60, end: 7 * 60 + 30, tz: "America/New_York" };
const row = {
  requester: "scout", vendor: "fakeshop", reason: "needed", items: [{ sku: "S1", qty: 2, title: "Brass Telescope" }],
};
const URL_ = "https://approve.example.test/a/AAAA";

/** One-shot local DM endpoint on 127.0.0.1 (never leaves the box). */
async function withDmServer(
  respond: (req: Request) => Response | Promise<Response>,
  fn: (url: string, seen: { headers: Headers; body: unknown }[]) => Promise<void>,
) {
  const seen: { headers: Headers; body: unknown }[] = [];
  const ac = new AbortController();
  const srv = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} }, async (req) => {
    seen.push({ headers: req.headers, body: await req.json() });
    return respond(req);
  });
  try {
    await fn(`http://127.0.0.1:${srv.addr.port}/api/dm`, seen);
  } finally {
    ac.abort();
    await srv.finished;
  }
}

Deno.test("HttpDmNotifier: exact request shape, ok only with a message id", async () => {
  await withDmServer(() => Response.json({ messageId: "m-1" }), async (url, seen) => {
    const n = new HttpDmNotifier(url, "test-token-xyz", "user-42");
    assertEquals(await n.send("hello"), { ok: true, messageId: "m-1" });
    assertEquals(seen[0].headers.get("content-type"), "application/json");
    assertEquals(seen[0].headers.get("authorization"), "Bearer test-token-xyz");
    assertEquals(seen[0].body, { userId: "user-42", message: "hello" });
  });
  for (const body of [{ message_id: "m2" }, { id: 77 }]) {
    await withDmServer(() => Response.json(body), async (url) => {
      assert((await new HttpDmNotifier(url, "t", "u").send("x")).ok);
    });
  }
  await withDmServer(() => Response.json({ ok: true }), async (url) => {
    assertEquals(await new HttpDmNotifier(url, "t", "u").send("x"), { ok: false, error: "no_message_id" });
  });
});

Deno.test("HttpDmNotifier: failures never echo the message text", async () => {
  const secretText = "approve: <https://approve.example.test/a/SECRETTOKENSECRETTOKEN>";
  await withDmServer(() => new Response(secretText, { status: 500 }), async (url) => {
    const r = await new HttpDmNotifier(url, "t", "u").send(secretText);
    assertEquals(r.ok, false);
    assertEquals(r.error, "http_500");
  });
  await withDmServer(() => new Response("not json " + secretText), async (url) => {
    const r = await new HttpDmNotifier(url, "t", "u").send(secretText);
    assertEquals(r, { ok: false, error: "bad_json" });
  });
  assertEquals((await new HttpDmNotifier("", "t", "u").send("x")).error, "notifier_unconfigured");
  assertEquals((await new HttpDmNotifier("http://10.0.0.5/api/dm", "t", "u").send("x")).error, "notifier_unsafe_url");
});

Deno.test("isSafeEndpoint: https or loopback http only", () => {
  assert(isSafeEndpoint("https://dm.example.test/x"));
  assert(isSafeEndpoint("http://127.0.0.1:47321/api/dm"));
  assert(!isSafeEndpoint("http://example.test/api/dm"));
  assert(!isSafeEndpoint("https://u:p@example.test/"));
  assert(!isSafeEndpoint("ftp://127.0.0.1/"));
});

Deno.test("extractMessageId", () => {
  assertEquals(extractMessageId({ messageId: "a" }), "a");
  assertEquals(extractMessageId({ message_id: "b" }), "b");
  assertEquals(extractMessageId({ id: 5 }), "5");
  assertEquals(extractMessageId({ messageId: "" }), undefined);
  assertEquals(extractMessageId(null), undefined);
});

Deno.test("makeNotifier / makeHealthAlerter: fakes unless DRY_RUN=0", () => {
  const prev = Deno.env.get("DRY_RUN");
  const prevCmd = Deno.env.get("HEALTH_ALERT_CMD");
  try {
    Deno.env.delete("DRY_RUN");
    assert(makeNotifier() instanceof FakeNotifier);
    assert(makeHealthAlerter() instanceof FakeHealthAlerter);
    Deno.env.set("DRY_RUN", "1");
    assert(makeNotifier() instanceof FakeNotifier);
    Deno.env.set("DRY_RUN", "0");
    assert(makeNotifier() instanceof HttpDmNotifier);
    Deno.env.delete("HEALTH_ALERT_CMD");
    assert(makeHealthAlerter() instanceof NoopHealthAlerter);
  } finally {
    if (prev === undefined) Deno.env.delete("DRY_RUN");
    else Deno.env.set("DRY_RUN", prev);
    if (prevCmd !== undefined) Deno.env.set("HEALTH_ALERT_CMD", prevCmd);
  }
});

// ── ntfy ──────────────────────────────────────────────────────────────────
const NTFY_TOPIC = "test-topic-0123456789abcdef"; // 27 chars: long enough for public ntfy.sh

/** A fetch stub that records every call and answers with `respond`. Never touches the network. */
function fetchStub(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond());
  }) as typeof fetch;
  return { f, calls };
}

Deno.test("NtfyNotifier: exact request shape, plain-text body, no click/action headers", async () => {
  const { f, calls } = fetchStub(() => Response.json({ id: "hwQ2YpKdmg", event: "message" }));
  const n = new NtfyNotifier("https://ntfy.sh", NTFY_TOPIC, "", f);
  const text = "purchase-gate: ...\napprove (24h): <https://approve.example.test/a/AAAAAAAAAAAAAAAAAAAAAA#tok>";
  assertEquals(await n.send(text), { ok: true, messageId: "hwQ2YpKdmg" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `https://ntfy.sh/${NTFY_TOPIC}`);
  assertEquals(calls[0].init.method, "POST");
  assertEquals(calls[0].init.redirect, "error");
  const h = new Headers(calls[0].init.headers);
  assertEquals(h.get("title"), "errand-joy-bot");
  assertEquals(h.get("markdown"), "no");
  assert(h.get("content-type")?.startsWith("text/plain"));
  assertEquals(h.get("authorization"), null, "no token configured → no Authorization header");
  for (const k of ["click", "actions", "action", "attach", "icon", "x-click", "x-actions"]) {
    assertEquals(h.get(k), null, `${k} header would make ntfy pre-load a URL`);
  }
  // the link stays plain text in the body, without the Discord <...> wrapper
  assertEquals(
    calls[0].init.body,
    "purchase-gate: ...\napprove (24h): https://approve.example.test/a/AAAAAAAAAAAAAAAAAAAAAA#tok",
  );
});

Deno.test("NtfyNotifier: Bearer token when set; custom server; trailing slash", async () => {
  const { f, calls } = fetchStub(() => Response.json({ id: "abc123" }));
  const n = new NtfyNotifier("https://ntfy.example.test/", "short_topic", "test-ntfy-token", f);
  assertEquals(await n.send("x"), { ok: true, messageId: "abc123" });
  assertEquals(calls[0].url, "https://ntfy.example.test/short_topic");
  assertEquals(new Headers(calls[0].init.headers).get("authorization"), "Bearer test-ntfy-token");
});

Deno.test("NtfyNotifier: fails closed without a 2xx + JSON id; errors never carry the text", async () => {
  const secret = "approve: <https://approve.example.test/a/AAAAAAAAAAAAAAAAAAAAAA#SECRETTOKENSECRETTOKEN>";
  const cases: Array<[() => Response, string]> = [
    [() => Response.json({ event: "message" }), "no_message_id"],
    [() => Response.json({ id: "" }), "no_message_id"],
    [() => Response.json({ id: 42 }), "no_message_id"],
    [() => new Response("not json", { status: 200 }), "bad_json"],
    [() => new Response("forbidden", { status: 403 }), "http_403"],
    [() => Response.json({ id: "x" }, { status: 500 }), "http_500"],
  ];
  for (const [respond, error] of cases) {
    const { f } = fetchStub(respond);
    const r = await new NtfyNotifier("https://ntfy.sh", NTFY_TOPIC, "", f).send(secret);
    assertEquals(r, { ok: false, error });
  }
  const throwing = (() => Promise.reject(new TypeError("boom " + secret))) as typeof fetch;
  const r = await new NtfyNotifier("https://ntfy.sh", NTFY_TOPIC, "", throwing).send(secret);
  assertEquals(r, { ok: false, error: "fetch_TypeError" });
});

Deno.test("NtfyNotifier: config refusals never call fetch", async () => {
  const { f, calls } = fetchStub(() => Response.json({ id: "x" }));
  const bad: Array<[NtfyNotifier, string]> = [
    [new NtfyNotifier("https://ntfy.sh", "", "", f), "notifier_unconfigured"],
    [new NtfyNotifier("https://ntfy.sh", "has/slash", "", f), "ntfy_bad_topic"],
    [new NtfyNotifier("https://ntfy.sh", "a".repeat(65), "", f), "ntfy_bad_topic"],
    [new NtfyNotifier("https://ntfy.sh", "alerts", "", f), "ntfy_topic_guessable"],
    [new NtfyNotifier("http://ntfy.example.test", NTFY_TOPIC, "", f), "notifier_unsafe_url"],
    [new NtfyNotifier("https://u:p@ntfy.example.test", NTFY_TOPIC, "", f), "notifier_unsafe_url"],
    [new NtfyNotifier("https://ntfy.example.test/?x=1", NTFY_TOPIC, "", f), "notifier_unsafe_url"],
  ];
  for (const [n, error] of bad) assertEquals(await n.send("x"), { ok: false, error });
  assertEquals(calls.length, 0);
  // plain http is fine on loopback (a self-hosted ntfy on the same box)
  assert((await new NtfyNotifier("http://127.0.0.1:8090", "t", "", f).send("x")).ok);
});

Deno.test("makeNotifier: NOTIFIER=ntfy picks NtfyNotifier (DRY_RUN=0 only); unknown fails closed", async () => {
  const prev = { DRY_RUN: Deno.env.get("DRY_RUN"), NOTIFIER: Deno.env.get("NOTIFIER") };
  try {
    Deno.env.set("NOTIFIER", "ntfy");
    Deno.env.delete("DRY_RUN");
    assert(makeNotifier() instanceof FakeNotifier);
    Deno.env.set("DRY_RUN", "0");
    assert(makeNotifier() instanceof NtfyNotifier);
    Deno.env.set("NOTIFIER", "pigeon");
    assertEquals(await makeNotifier().send("x"), { ok: false, error: "unknown_transport" });
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
});

Deno.test("inQuietHours: 22:00–07:30 New York, wraps midnight, DST-aware", () => {
  assert(inQuietHours(new Date("2026-10-13T02:00:00Z"), NY)); // 22:00 EDT
  assert(!inQuietHours(new Date("2026-10-13T01:59:00Z"), NY)); // 21:59
  assert(inQuietHours(new Date("2026-10-13T11:29:00Z"), NY)); // 07:29
  assert(!inQuietHours(new Date("2026-10-13T11:30:00Z"), NY)); // 07:30
  assert(inQuietHours(new Date("2026-12-15T12:00:00Z"), NY)); // 07:00 EST
  assert(!inQuietHours(new Date("2026-12-15T17:00:00Z"), NY)); // noon EST
  assert(!inQuietHours(new Date("2026-10-13T03:00:00Z"), { ...NY, off: true }));
});

Deno.test("quietHoursConfig: explicit values (from config.toml), equal = off, bad values throw", () => {
  assertEquals(quietHoursConfig(), NY);
  assertEquals(quietHoursConfig("23:15", "06:00", "Europe/Berlin"), { start: 23 * 60 + 15, end: 6 * 60, tz: "Europe/Berlin" });
  assert(quietHoursConfig("00:00", "00:00").off);
  assertThrows(() => quietHoursConfig("nonsense", "06:00"));
  assertThrows(() => quietHoursConfig("22:00", "06:00", "Not/AZone"));
  // env no longer has any say
  Deno.env.set("QUIET_HOURS", "off");
  try {
    assertEquals(quietHoursConfig(), NY);
  } finally {
    Deno.env.delete("QUIET_HOURS");
  }
});

Deno.test("message builders wrap links in <> and neutralise agent text", () => {
  const evil = { ...row, reason: "click https://evil.test/a/x <@everyone> **now**\nnewline" };
  const DENY = URL_.replace(/\/a\/.*/, "/a/" + "d".repeat(43));
  const ask = approvalDm(evil, { totalCents: 8000 }, URL_, DENY);
  assert(ask.includes(`approve (24h): <${URL_}>`));
  assert(ask.includes(`deny: <${DENY}>`));
  assertEquals((ask.match(/https?:\/\//g) ?? []).length, 2);
  for (const m of [ask, vetoDm(evil, { totalCents: 2300 }, URL_), fundVetoDm(evil, { totalCents: 60000 }, URL_)]) {
    assert(m.includes(`<${URL_}>`));
    assert(!m.includes("https://evil"));
    assert(!m.includes("@everyone"));
    assert(!m.includes("**"));
  }
  for (const m of [vetoDm(evil, { totalCents: 2300 }, URL_), fundVetoDm(evil, { totalCents: 60000 }, URL_)]) {
    assertEquals((m.match(/https?:\/\//g) ?? []).length, 1, "veto DMs carry only the deny link");
  }
  assert(fundVetoDm(row, { totalCents: 60000 }, URL_).includes("in 2h unless"));
  assert(approvalDm(row, { totalCents: 8000 }, URL_, DENY).includes("$80.00"));
  const stranger = { ...row, shipTo: { name: "Jane Doe", line1: "1 Main St", city: "Springfield", state: "IL", zip: "62701" } };
  assert(approvalDm(stranger, { totalCents: 800 }, URL_, DENY).includes("ship to: Jane Doe, Springfield IL"));
  assert(!approvalDm({ ...row, shipTo: "owner-home" }, { totalCents: 800 }, URL_, DENY).includes("ship to"));
  assert(clean("x".repeat(500)).length <= 140);
});

Deno.test("joy veto DM never names the item", () => {
  const m = vetoDm(row, { totalCents: 2300 }, URL_, { joy: true });
  assertEquals(m, `robot spent $23.00 on something this week. tap to veto: <${URL_}>`);
  assert(!m.includes("Telescope"));
  assert(!m.includes("S1"));
  assert(deliveredWhyNoteDm({ ...row, whyNote: "you said you liked stars" }).includes("Brass Telescope"));
  assert(stopDm("velocity").startsWith("purchase-gate STOP: velocity"));
});

Deno.test("HealthAlerter: generic text, one per kind per 6h, never leaks details", async () => {
  let t = Date.parse("2026-10-12T16:00:00Z");
  const a = new FakeHealthAlerter(() => new Date(t));
  assertEquals((await a.alert("dm_down", HEALTH_ALERT_TEXT.dm_down)).sent, true);
  assertEquals((await a.alert("dm_down", HEALTH_ALERT_TEXT.dm_down)).skipped, "rate_limited");
  assertEquals((await a.alert("stop_tripped", "purchase-gate: STOP for $80.00 at <https://approve.example.test/a/x>")).sent, true);
  assertEquals(a.alerts.map((x) => x.text), [HEALTH_ALERT_TEXT.dm_down, HEALTH_ALERT_TEXT.stop_tripped]);
  t += 6 * 3600_000 - 1;
  assertEquals((await a.alert("dm_down")).skipped, "rate_limited");
  t += 1;
  assertEquals((await a.alert("dm_down")).sent, true);
  assertEquals(a.alerts.length, 3);
});
