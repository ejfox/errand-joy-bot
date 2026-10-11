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
  quietHoursConfig,
  stopDm,
  vetoDm,
} from "./notify.ts";

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
