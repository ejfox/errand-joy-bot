// relay/main_test.ts — calls the exported fetch directly. No network; data under /tmp.
// Every behavioural test runs once per storage backend ([sqlite] and [kv]).
// Run: deno test --allow-read --allow-write=/tmp --allow-env --unstable-kv relay/main_test.ts
import nodeAssert from "node:assert/strict"; // built in: no registry fetch needed

function assert(cond: unknown, msg?: string): asserts cond {
  nodeAssert.ok(cond, msg);
}
function assertEquals(a: unknown, b: unknown, msg?: string) {
  nodeAssert.deepStrictEqual(a, b, msg);
}
function assertNotEquals(a: unknown, b: unknown, msg?: string) {
  nodeAssert.notDeepStrictEqual(a, b, msg);
}

const DATA = Deno.makeTempDirSync({ dir: "/tmp", prefix: "relay-test-" });
const RELAY_TOKEN = "t".repeat(48);
Deno.env.set("RELAY_DATA_DIR", DATA);
Deno.env.set("RELAY_KV_PATH", `${DATA}/relay.kv`);
Deno.env.set("RELAY_TOKEN", RELAY_TOKEN);
Deno.env.set("RELAY_STORE", "sqlite");
for (const k of ["RELAY_IP_HEADER", "RELAY_MAX_CENTS", "RELAY_TIMEZONE"]) Deno.env.delete(k);

const { default: app, _resetRateLimit } = await import("./main.ts");
const { openStore, closeStore } = await import("./store.ts");
type RelayStore = import("./store.ts").RelayStore;

const BASE = "http://relay.test";
let ipSeq = 0;
/** Fresh IP per request so the rate-limit buckets never interfere. */
const freshIp = () => `10.${Math.floor(++ipSeq / 62500) % 250}.${Math.floor(ipSeq / 250) % 250}.${ipSeq % 250}`;

function mintToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
let idSeq = 0;
/** A record with its two plaintext tokens. Veto records get no approve hash. */
async function record(over: Record<string, unknown> = {}) {
  const approve = mintToken();
  const deny = mintToken();
  const rec: Record<string, unknown> = {
    approvalId: `ap_${++idSeq}_${crypto.randomUUID().slice(0, 8)}`,
    requestId: `req_${idSeq}`,
    denyTokenHash: await sha256Hex(deny),
    approveTokenHash: await sha256Hex(approve),
    vendor: "mouser",
    boundCents: 12_345,
    kind: "approve",
    summary: "3x ESP32-S3 dev boards for the pixel canvas",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...over,
  };
  if (rec.kind === "veto" && !("approveTokenHash" in over)) delete rec.approveTokenHash;
  return { rec, approve, deny };
}
function publish(rec: unknown, auth = `Bearer ${RELAY_TOKEN}`) {
  return app.fetch(
    new Request(`${BASE}/internal/pending`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(rec),
    }),
  );
}
async function published(over: Record<string, unknown> = {}) {
  const r = await record(over);
  const res = await publish(r.rec);
  assertEquals(res.status, 200, await res.clone().text());
  await res.body?.cancel();
  return r;
}
function view(token: string, ip = freshIp(), method = "GET") {
  return app.fetch(new Request(`${BASE}/a/${token}`, { method, headers: { "cf-connecting-ip": ip } }));
}
function tap(token: string, action: string, bodyToken = token, ip = freshIp()) {
  return app.fetch(
    new Request(`${BASE}/a/${token}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
      body: new URLSearchParams({ token: bodyToken }).toString(),
    }),
  );
}
type V = { approvalId: string; verdict: string; at: string; token?: string };
async function pull(since: string): Promise<V[]> {
  const res = await app.fetch(
    new Request(`${BASE}/internal/verdicts?since=${encodeURIComponent(since)}`, {
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    }),
  );
  assertEquals(res.status, 200);
  return await res.json();
}
/** The same store handle main.ts uses for the current RELAY_STORE. */
function store(): Promise<RelayStore> {
  const backend = Deno.env.get("RELAY_STORE") === "kv" ? "kv" : "sqlite";
  return openStore({ backend, dataDir: DATA, kvPath: `${DATA}/relay.kv` });
}
async function rows() {
  return await (await store()).dumpRows();
}
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

function assertSecurityHeaders(res: Response, label: string) {
  const h = res.headers;
  assertEquals(h.get("cache-control"), "no-store", label);
  assertEquals(h.get("x-robots-tag"), "noindex, nofollow", label);
  assertEquals(h.get("referrer-policy"), "no-referrer", label);
  assertEquals(h.get("x-frame-options"), "DENY", label);
  const csp = h.get("content-security-policy") ?? "";
  assert(csp.includes("default-src 'none'"), label);
  assert(csp.includes("style-src 'unsafe-inline'"), label);
  assert(csp.includes("form-action 'self'"), label);
}

const NEUTRAL_TEXT = "This link is no longer valid";

type T = (name: string, fn: () => Promise<void>) => void;

function suite(t: T) {
  t("GET approve link renders ONLY the approve form; deny link ONLY deny; zero writes", async () => {
    const { approve, deny, rec } = await published();
    const before = await rows();
    const res = await view(approve);
    assertEquals(res.status, 200);
    const html = await res.text();
    assert(html.includes("$123.45"));
    assert(html.includes("mouser"));
    assert(html.includes("ESP32-S3"));
    assert(html.includes(`action="/a/${approve}/approve"`));
    assert(!html.includes("/deny"), "approve page has no deny form");
    assert(!html.includes(deny), "approve page never shows the deny token");
    assert(html.includes("Deny link from your message"));
    assert(html.includes('name="robots" content="noindex,nofollow"'));
    const dres = await view(deny);
    assertEquals(dres.status, 200);
    const dhtml = await dres.text();
    assert(dhtml.includes(`action="/a/${deny}/deny"`));
    assert(!dhtml.includes("/approve"), "deny page has no approve form");
    assert(!dhtml.includes(approve));
    // HEAD and repeated GETs (prefetchers) too
    await (await view(approve, freshIp(), "HEAD")).body?.cancel();
    await (await view(deny, freshIp(), "HEAD")).body?.cancel();
    await (await view(approve)).body?.cancel();
    assertEquals(await rows(), before);
    assertEquals((await (await store()).findByHash(rec.approveTokenHash as string))?.approval.usedAt, null);
  });

  t("approve flow: first pull carries the approve token once; second pull does not", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const { approve, deny, rec } = await published();
    const res = await tap(approve, "approve");
    assertEquals(res.status, 200);
    assert((await res.text()).includes("Approved"));
    const first = (await pull(since)).find((v) => v.approvalId === rec.approvalId);
    assertEquals(first?.verdict, "approve");
    assertEquals(first?.token, approve, "proof token is the approve token");
    const second = (await pull(since)).find((v) => v.approvalId === rec.approvalId);
    assertEquals(second?.verdict, "approve");
    assert(second && !("token" in second), "token returned at most once");
    assert(!JSON.stringify(await rows()).includes(approve), "proof token deleted after pull");
    // the deny link is dead too (single use per record)
    const d = await tap(deny, "deny");
    assertEquals(d.status, 404);
    await d.body?.cancel();
    // a later since excludes it
    const later = await pull(first!.at);
    assert(!later.some((v) => v.approvalId === rec.approvalId));
  });

  t("deny flow records deny; deny verdict never carries a token", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const { approve, deny, rec } = await published();
    const res = await tap(deny, "deny");
    assertEquals(res.status, 200);
    assert((await res.text()).includes("Denied"));
    assertEquals((await (await store()).findByHash(rec.denyTokenHash as string))?.approval.verdict, "deny");
    const mine = (await pull(since)).find((v) => v.approvalId === rec.approvalId);
    assertEquals(mine?.verdict, "deny");
    assert(mine && !("token" in mine));
    const s = JSON.stringify(await rows());
    assert(!s.includes(deny) && !s.includes(approve), "no plaintext stored on deny");
    // the approve link is now dead
    const a = await tap(approve, "approve");
    assertEquals(a.status, 404);
    await a.body?.cancel();
  });

  t("proof token backstop: older than 24h after the tap is dropped, never returned", async () => {
    const { rec, approve } = await record();
    const s = await store();
    assertEquals(await s.upsert(rec as never, new Date()), "stored");
    const tapAt = new Date(Date.now() - 25 * 3600_000);
    assertEquals(await s.tap(rec.approveTokenHash as string, "approve", tapAt, approve), "ok");
    const mine = (await pull(new Date(0).toISOString())).find((v) => v.approvalId === rec.approvalId);
    assertEquals(mine?.verdict, "approve");
    assert(mine && !("token" in mine), "stale proof token not returned");
    assert(!JSON.stringify(await rows()).includes(approve), "stale proof token purged");
  });

  t("wrong link: deny token on /approve and approve token on /deny are refused, nothing consumed", async () => {
    const { approve, deny, rec } = await published();
    const before = await rows();
    const r1 = await tap(deny, "approve");
    assertEquals(r1.status, 403);
    await r1.body?.cancel();
    const r2 = await tap(approve, "deny");
    assertEquals(r2.status, 403);
    await r2.body?.cancel();
    assertEquals(await rows(), before);
    const ok = await tap(approve, "approve");
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
    assertEquals((await (await store()).findByHash(rec.denyTokenHash as string))?.approval.verdict, "approve");
  });

  t("concurrent taps on one record: exactly one wins", async () => {
    const { approve, deny, rec } = await published();
    const [a, b] = await Promise.all([tap(approve, "approve"), tap(deny, "deny")]);
    assertEquals([a.status, b.status].sort(), [200, 404]);
    await a.body?.cancel();
    await b.body?.cancel();
    // store API: same token twice at once
    const r2 = await record();
    const s = await store();
    await s.upsert(r2.rec as never, new Date());
    const now = new Date();
    const res = await Promise.all([
      s.tap(r2.rec.approveTokenHash as string, "approve", now, r2.approve),
      s.tap(r2.rec.approveTokenHash as string, "approve", now, r2.approve),
    ]);
    assertEquals(res.sort(), ["gone", "ok"]);
    assert((await s.findByHash(rec.denyTokenHash as string))?.approval.usedAt !== null);
  });

  t("reused token → neutral page, verdict unchanged", async () => {
    const { deny, rec } = await published();
    await (await tap(deny, "deny")).body?.cancel();
    const again = await tap(deny, "deny");
    assertEquals(again.status, 404);
    assert((await again.text()).includes(NEUTRAL_TEXT));
    const g = await view(deny);
    assertEquals(g.status, 404);
    assert((await g.text()).includes(NEUTRAL_TEXT));
    assertEquals((await (await store()).findByHash(rec.denyTokenHash as string))?.approval.verdict, "deny");
  });

  t("re-publishing a decided record does not clobber the tap", async () => {
    const { deny, rec } = await published();
    await (await tap(deny, "deny")).body?.cancel();
    const res = await publish({ ...rec, summary: "changed" });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).status, "already_decided");
    const row = (await (await store()).findByHash(rec.denyTokenHash as string))?.approval;
    assertEquals(row?.verdict, "deny");
    assertNotEquals(row?.summary, "changed");
  });

  t("re-publishing with new hashes replaces the old hash index", async () => {
    const old = await published();
    const fresh = await record();
    const res = await publish({
      ...old.rec,
      denyTokenHash: fresh.rec.denyTokenHash,
      approveTokenHash: fresh.rec.approveTokenHash,
    });
    assertEquals(res.status, 200);
    await res.body?.cancel();
    for (const tok of [old.approve, old.deny]) {
      const r = await view(tok);
      assertEquals(r.status, 404);
      await r.body?.cancel();
    }
    // the old hashes are free again: another record may use them
    const reuse = await publish({ ...(await record()).rec, denyTokenHash: old.rec.denyTokenHash });
    assertEquals(reuse.status, 200);
    await reuse.body?.cancel();
    const ok = await tap(fresh.approve, "approve");
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
  });

  t("token/body mismatch → 403, no write", async () => {
    const { approve } = await published();
    const before = await rows();
    const res = await tap(approve, "approve", mintToken());
    assertEquals(res.status, 403);
    await res.body?.cancel();
    const empty = await tap(approve, "approve", "");
    assertEquals(empty.status, 403);
    await empty.body?.cancel();
    assertEquals(await rows(), before);
  });

  t("veto: deny link shows Veto only; no approve link exists; approve refused; deny works", async () => {
    const { deny, rec } = await published({ kind: "veto", summary: "robot spent $23 on something" });
    assert(!("approveTokenHash" in rec));
    const page = await (await view(deny)).text();
    assert(!page.includes("/approve"));
    assert(page.includes(`/a/${deny}/deny`));
    assert(page.includes("Veto this purchase"));
    const before = await rows();
    const res = await tap(deny, "approve");
    assertEquals(res.status, 403);
    await res.body?.cancel();
    assertEquals(await rows(), before);
    const ok = await tap(deny, "deny");
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
    assertEquals((await (await store()).findByHash(rec.denyTokenHash as string))?.approval.verdict, "deny");
  });

  t("expired, unknown, used and malformed all render the identical neutral 404", async () => {
    const { deny: expired } = await published({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const { deny: used, approve: usedApprove } = await published();
    await (await tap(used, "deny")).body?.cancel();
    const bodies: string[] = [];
    for (const t of [expired, mintToken(), used, usedApprove, "short", "%3Cscript%3E", "a".repeat(400)]) {
      const res = await view(t);
      assertEquals(res.status, 404, t);
      assertSecurityHeaders(res, `neutral ${t}`);
      bodies.push(await res.text());
    }
    assert(bodies[0].includes(NEUTRAL_TEXT));
    for (const b of bodies) assertEquals(b, bodies[0]);
    // expired can't be tapped either
    const t = await tap(expired, "deny");
    assertEquals(t.status, 404);
    await t.body?.cancel();
  });

  t("security headers on every response, including 404/405/401/413/429", async () => {
    const { approve, deny } = await published();
    const cases: Array<[string, Promise<Response>]> = [
      ["view", view(approve)],
      ["root 404", app.fetch(new Request(`${BASE}/`))],
      ["random 404", app.fetch(new Request(`${BASE}/wp-admin.php`))],
      [
        "GET approve 405",
        app.fetch(new Request(`${BASE}/a/${approve}/approve`, { headers: { "cf-connecting-ip": freshIp() } })),
      ],
      [
        "HEAD deny 405",
        app.fetch(
          new Request(`${BASE}/a/${deny}/deny`, { method: "HEAD", headers: { "cf-connecting-ip": freshIp() } }),
        ),
      ],
      ["internal 401", app.fetch(new Request(`${BASE}/internal/verdicts`))],
      [
        "413",
        app.fetch(
          new Request(`${BASE}/a/${deny}/deny`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": freshIp() },
            body: "token=" + "x".repeat(5000),
          }),
        ),
      ],
    ];
    for (const [label, p] of cases) {
      const res = await p;
      assertSecurityHeaders(res, label);
      await res.body?.cancel();
    }
    const r405 = await app.fetch(
      new Request(`${BASE}/a/${approve}/approve`, { headers: { "cf-connecting-ip": freshIp() } }),
    );
    assertEquals(r405.status, 405);
    await r405.body?.cancel();
    const r413 = await app.fetch(
      new Request(`${BASE}/a/${deny}/deny`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": freshIp() },
        body: "token=" + "x".repeat(5000),
      }),
    );
    assertEquals(r413.status, 413);
    await r413.body?.cancel();
  });

  t("internal routes need the bearer; 503 when RELAY_TOKEN unset", async () => {
    const { rec } = await record();
    for (
      const auth of ["", "Bearer ", "Bearer wrong", `bearer ${RELAY_TOKEN}`, RELAY_TOKEN, `Bearer ${RELAY_TOKEN}x`]
    ) {
      const res = await publish(rec, auth);
      assertEquals(res.status, 401, `auth=${auth.length}`);
      await res.body?.cancel();
    }
    const v = await app.fetch(
      new Request(`${BASE}/internal/verdicts?since=`, { headers: { authorization: "Bearer nope" } }),
    );
    assertEquals(v.status, 401);
    await v.body?.cancel();
    assertEquals(await (await store()).findByHash(rec.denyTokenHash as string), null);

    Deno.env.delete("RELAY_TOKEN");
    try {
      const res = await publish(rec);
      assertEquals(res.status, 503);
      assertSecurityHeaders(res, "503");
      await res.body?.cancel();
    } finally {
      Deno.env.set("RELAY_TOKEN", RELAY_TOKEN);
    }
  });

  t("POST /internal/pending rejects bad shapes", async () => {
    const h = await sha256Hex(mintToken());
    const bad: Array<[string, Record<string, unknown>]> = [
      ["kind", { kind: "auto" }],
      ["negative cents", { boundCents: -1 }],
      ["float cents", { boundCents: 1.5 }],
      ["string cents", { boundCents: "100" }],
      ["over max cents", { boundCents: 100_001 }],
      ["too far expiry", { expiresAt: new Date(Date.now() + 26 * 3600_000).toISOString() }],
      ["junk expiry", { expiresAt: "tomorrow-ish" }],
      ["non-hex deny hash", { denyTokenHash: "z".repeat(64) }],
      ["short deny hash", { denyTokenHash: "ab" }],
      ["missing approve hash", { approveTokenHash: undefined }],
      ["bad approve hash", { approveTokenHash: "Z".repeat(64) }],
      ["equal hashes", { denyTokenHash: h, approveTokenHash: h }],
      ["veto with approve hash", { kind: "veto", approveTokenHash: h }],
      ["old single tokenHash", { tokenHash: h }],
      ["unknown key", { evil: 1 }],
      ["empty summary", { summary: "" }],
      ["huge summary", { summary: "x".repeat(1001) }],
      ["vendor charset", { vendor: "<b>mouser</b>" }],
    ];
    for (const [label, over] of bad) {
      const { rec } = await record(over);
      const res = await publish(rec);
      assertEquals(res.status, 400, label);
      await res.body?.cancel();
    }
    for (const body of ["[]", "null", "not json"]) {
      const res = await app.fetch(
        new Request(`${BASE}/internal/pending`, {
          method: "POST",
          headers: { authorization: `Bearer ${RELAY_TOKEN}`, "content-type": "application/json" },
          body,
        }),
      );
      assertEquals(res.status, 400, body);
      await res.body?.cancel();
    }
    // either hash already used by a different approvalId → 409 (deny, approve, and crossed)
    const { rec } = await published();
    const other = (await record()).rec;
    for (
      const [label, over] of [
        ["same deny", { denyTokenHash: rec.denyTokenHash }],
        ["same approve", { approveTokenHash: rec.approveTokenHash }],
        ["deny = their approve", { denyTokenHash: rec.approveTokenHash }],
        ["approve = their deny", { approveTokenHash: rec.denyTokenHash }],
      ] as const
    ) {
      const dup = await publish({ ...other, ...over });
      assertEquals(dup.status, 409, label);
      await dup.body?.cancel();
    }
    // bad since
    const bs = await app.fetch(
      new Request(`${BASE}/internal/verdicts?since=garbage`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } }),
    );
    assertEquals(bs.status, 400);
    await bs.body?.cancel();
  });

  t("RELAY_MAX_CENTS bounds boundCents; invalid values fall back to the default", async () => {
    await withEnv({ RELAY_MAX_CENTS: "500" }, async () => {
      const over = await publish((await record({ boundCents: 501 })).rec);
      assertEquals(over.status, 400);
      await over.body?.cancel();
      const at = await publish((await record({ boundCents: 500 })).rec);
      assertEquals(at.status, 200);
      await at.body?.cancel();
    });
    for (const junk of ["abc", "0", "-5", "1e9"]) {
      await withEnv({ RELAY_MAX_CENTS: junk }, async () => {
        const ok = await publish((await record({ boundCents: 100_000 })).rec);
        assertEquals(ok.status, 200, junk);
        await ok.body?.cancel();
        const no = await publish((await record({ boundCents: 100_001 })).rec);
        assertEquals(no.status, 400, junk);
        await no.body?.cancel();
      });
    }
  });

  t("RELAY_TIMEZONE sets the expiry zone; default and invalid → UTC", async () => {
    const { approve } = await published({ expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    assert((await (await view(approve)).text()).includes("UTC"));
    await withEnv({ RELAY_TIMEZONE: "America/Los_Angeles" }, async () => {
      const html = await (await view(approve)).text();
      assert(/P[DS]T/.test(html) && !html.includes("UTC"), "Los Angeles time");
    });
    await withEnv({ RELAY_TIMEZONE: "Mars/Olympus_Mons" }, async () => {
      assert((await (await view(approve)).text()).includes("UTC"));
    });
  });

  t("XSS in summary/vendor/expiry is escaped", async () => {
    const { approve } = await published({ summary: `<script>alert(1)</script>"><img src=x onerror=alert(2)>'` });
    const html = await (await view(approve)).text();
    assert(!html.includes("<script>alert"));
    assert(!html.includes("<img"));
    assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img"));
    assert(html.includes("&#39;"));
  });

  t("rate limit: 11th request in a minute from one IP → 429", async () => {
    _resetRateLimit();
    const ip = "203.0.113.7";
    for (let i = 0; i < 10; i++) {
      const res = await view(mintToken(), ip);
      assertEquals(res.status, 404);
      await res.body?.cancel();
    }
    const { approve, deny } = await published();
    const blocked = await view(approve, ip);
    assertEquals(blocked.status, 429);
    assertSecurityHeaders(blocked, "429");
    await blocked.body?.cancel();
    // POSTs from the same IP are blocked too, without writing
    const before = await rows();
    const t = await tap(approve, "approve", approve, ip);
    assertEquals(t.status, 429);
    await t.body?.cancel();
    assertEquals(await rows(), before);
    // ...but a deny is never blocked (fail-safe direction for veto links)
    const d = await tap(deny, "deny", deny, ip);
    assertEquals(d.status, 200);
    await d.body?.cancel();
    const { approve: token2 } = await published();
    // another IP is unaffected
    const other = await view(token2, "203.0.113.8");
    assertEquals(other.status, 200);
    await other.body?.cancel();
    // missing / spoofy header values share one bucket
    _resetRateLimit();
    for (let i = 0; i < 10; i++) {
      await (await app.fetch(
        new Request(`${BASE}/a/${mintToken()}`, { headers: i % 2 ? {} : { "cf-connecting-ip": "not an ip" } }),
      )).body?.cancel();
    }
    const shared = await app.fetch(new Request(`${BASE}/a/${token2}`));
    assertEquals(shared.status, 429);
    await shared.body?.cancel();
    _resetRateLimit();
  });

  t("RELAY_IP_HEADER=x-forwarded-for keys on the right-most (proxy-appended) hop", async () => {
    await withEnv({ RELAY_IP_HEADER: "x-forwarded-for" }, async () => {
      _resetRateLimit();
      const req = (xff: string) =>
        app.fetch(
          new Request(`${BASE}/a/${mintToken()}`, {
            // cf-connecting-ip varies and must be ignored
            headers: { "x-forwarded-for": xff, "cf-connecting-ip": freshIp() },
          }),
        );
      // a client spoofing a fresh first hop each time is still one bucket
      for (let i = 0; i < 10; i++) {
        const r = await req(`10.0.0.${i}, 198.51.100.9`);
        assertEquals(r.status, 404);
        await r.body?.cancel();
      }
      const blocked = await req("10.9.9.9 , 198.51.100.9 ");
      assertEquals(blocked.status, 429);
      await blocked.body?.cancel();
      const other = await req("10.0.0.1, 198.51.100.10");
      assertEquals(other.status, 404);
      await other.body?.cancel();
      _resetRateLimit();
    });
  });

  t("RELAY_IP_HEADER=none puts everyone in one bucket; deny still never 429", async () => {
    await withEnv({ RELAY_IP_HEADER: "none" }, async () => {
      _resetRateLimit();
      for (let i = 0; i < 10; i++) {
        const r = await view(mintToken(), freshIp());
        assertEquals(r.status, 404);
        await r.body?.cancel();
      }
      const { approve, deny } = await published();
      const blocked = await view(approve, freshIp());
      assertEquals(blocked.status, 429);
      await blocked.body?.cancel();
      const d = await tap(deny, "deny", deny, freshIp());
      assertEquals(d.status, 200);
      await d.body?.cancel();
      _resetRateLimit();
    });
  });

  t("verdict paging never splits a same-millisecond group", async () => {
    const s = await store();
    const at = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      const dh = (i + 1).toString(16).padStart(64, "0");
      const ah = (i + 101).toString(16).padStart(64, "0");
      assertEquals(
        await s.upsert({
          approvalId: `tie_${i}`,
          requestId: "r",
          denyTokenHash: dh,
          approveTokenHash: ah,
          vendor: "v",
          boundCents: 1,
          kind: "approve",
          summary: "s",
          expiresAt: new Date(at.getTime() + 3600_000).toISOString(),
        }, at),
        "stored",
      );
      assertEquals(await s.tap(dh, "deny", at), "ok");
    }
    const page = (await s.verdictsSince(new Date(0).toISOString(), { limit: 2, now: at }))
      .filter((v) => v.approvalId.startsWith("tie_"));
    assertEquals(page.length, 3);
  });
}

for (const backend of ["sqlite", "kv"] as const) {
  suite((name, fn) =>
    Deno.test(`[${backend}] ${name}`, async () => {
      Deno.env.set("RELAY_STORE", backend);
      _resetRateLimit();
      try {
        await fn();
      } finally {
        await closeStore();
        Deno.env.set("RELAY_STORE", "sqlite");
      }
    })
  );
}

Deno.test("bad RELAY_STORE fails closed: 503 on every route", async () => {
  Deno.env.set("RELAY_STORE", "redis");
  try {
    for (
      const req of [
        new Request(`${BASE}/a/${mintToken()}`, { headers: { "cf-connecting-ip": freshIp() } }),
        new Request(`${BASE}/`),
        new Request(`${BASE}/internal/verdicts`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } }),
      ]
    ) {
      const res = await app.fetch(req);
      assertEquals(res.status, 503);
      assertSecurityHeaders(res, "store 503");
      await res.body?.cancel();
    }
  } finally {
    Deno.env.set("RELAY_STORE", "sqlite");
    await closeStore();
  }
});

Deno.test("relay mirrors stay in sync with gate/types.ts; relay imports nothing from ../", async () => {
  const shared = await import("../gate/types.ts");
  const relay = await import("./main.ts");
  assertEquals(relay.FUND_MAX_CENTS, shared.FUND_MAX_CENTS);
  // compile-time: local mirrors are mutually assignable with the contract types
  type Shared = import("../gate/types.ts").ApprovalRecord;
  type Local = import("./store.ts").ApprovalRecord;
  const _a: Shared = {} as Local;
  const _b: Local = {} as Shared;
  const _v: import("../gate/types.ts").Verdict = {} as import("./store.ts").Verdict;
  const _w: import("./store.ts").Verdict = {} as import("../gate/types.ts").Verdict;
  void _a, _b, _v, _w;
  for (const f of ["main.ts", "store.ts", "page.ts"]) {
    const src = Deno.readTextFileSync(new URL(`./${f}`, import.meta.url));
    assert(!/(from\s+|import\()\s*["']\.\.\//.test(src), `${f} must not import from ../ (deploy is relay/ only)`);
  }
});

Deno.test("cleanup temp dir", async () => {
  await closeStore();
  Deno.removeSync(DATA, { recursive: true });
});
