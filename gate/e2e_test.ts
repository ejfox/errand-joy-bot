// End to end: real SQLite ledger, real policy/state, guarded MockAdapter, FakeNotifier, and the REAL
// relay handler in-process (HttpRelayClient with its fetch pointed at relay/main.ts). No network.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { validateConfig } from "./config.ts";
import { buildDeps } from "./wiring.ts";
import { createApp } from "./server.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { FakeHealthAlerter, FakeNotifier } from "./notify.ts";
import { HttpRelayClient } from "./relay_client.ts";
import { hashToken } from "./approval.ts";
import { type Charge, type RelayClient, StopActive, type Verdict } from "./types.ts";

// ── the real relay, in-process ────────────────────────────────────────────
const RELAY_DIR = Deno.makeTempDirSync({ dir: "/tmp", prefix: "ejb-e2e-relay-" });
const RELAY_TOKEN = "r".repeat(48);
Deno.env.set("RELAY_DATA_DIR", RELAY_DIR);
Deno.env.set("RELAY_TOKEN", RELAY_TOKEN);
Deno.env.set("RELAY_STORE", "sqlite");
const relayMod = await import("../relay/main.ts");
const relayFetch = (input: RequestInfo | URL, init?: RequestInit) => relayMod.default.fetch(new Request(input, init));
const RELAY_BASE = "https://relay.test";
const relayClient = new HttpRelayClient(RELAY_BASE, RELAY_TOKEN, relayFetch as typeof fetch);

let ip = 0;
/** A DM link `/a/<id>#<token>`, split the way a browser splits it. */
type Link = { id: string; token: string };

/** The owner's browser: POST the form on the page the DM link opened (the page's script put the
 * fragment's token into the form). */
function tap(link: Link, action: "approve" | "deny"): Promise<Response> {
  ip++;
  return relayMod.default.fetch(
    new Request(`${RELAY_BASE}/a/${link.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": `198.51.100.${ip % 250}` },
      body: new URLSearchParams({ token: link.token }).toString(),
    }),
  );
}
/** Opening the link: the browser requests the path only; the #fragment never leaves the device. */
function view(link: Link): Promise<Response> {
  ip++;
  return relayMod.default.fetch(new Request(`${RELAY_BASE}/a/${link.id}`, { headers: { "cf-connecting-ip": `198.51.100.${ip % 250}` } }));
}

const tokensIn = (dm: string): Link[] =>
  [...dm.matchAll(/<https:\/\/relay\.test\/a\/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})>/g)].map((m) => ({
    id: m[1],
    token: m[2],
  }));

// ── gate harness ──────────────────────────────────────────────────────────
const MIN = 60_000;
const REASON = "the bench power supply died mid-project and this replacement unblocks the build";
// Mock prices with tax 0: under $35 adds $5.99 shipping, so 1401 → $20.00 and 401 → $5.00.
const PRICES: Record<string, number> = { "S20": 1401, "S5": 401, "S80": 8000, "S90": 9000, "S600": 60000, "S1200": 120000 };
let seq = 0;

async function harness(over: Record<string, unknown> = {}, mockOpts: { phantomCharges?: Charge[] } = {}, relay: RelayClient = relayClient) {
  let t = Date.now();
  const clock = { now: () => new Date(t) };
  const dataDir = await Deno.makeTempDir({ dir: "/tmp", prefix: "ejb-e2e-gate-" });
  const { config } = validateConfig({ quiet_hours: { start: "00:00", end: "00:00" }, mock: { tax_rate: 0 }, ...over });
  const notifier = new FakeNotifier();
  const mock = new MockAdapter({ prices: PRICES, taxRate: 0, ...mockOpts });
  const env: Record<string, string> = { DRY_RUN: "1", RELAY_PUBLIC_URL: RELAY_BASE };
  const deps = buildDeps(config, {
    dataDir,
    env: (k) => env[k],
    clock,
    notifier,
    relay,
    alerter: new FakeHealthAlerter(() => clock.now()),
    adapterOverrides: { mock },
  });
  return { ...deps, notifier, mock, clock, advance: (ms: number) => (t += ms), dataDir };
}

function req(sku: string, over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: `e2e-${++seq}`, requester: "scout", taskId: "t1", vendor: "mock",
    items: [{ sku, qty: 1, title: `Item ${sku}` }], reason: REASON, reach: "self", maxTotalCents: 200_000, ...over,
  };
}

Deno.test("(a) $20 auto (silent tier off) → veto DM → cancel window elapses → placed", async () => {
  const h = await harness({ tiers: { auto_max_cents: 2500, ask_max_cents: 10_000, fund_enabled: false, fund_max_cents: 0 }, caps: { day_cents: 2500, month_cents: 7500, vendor_month_cents: 7500 }, joy: { week_cents: 1000 }, notify: { silent_below_cents: 0 } });
  const row = await h.orch.submit(req("S20"));
  assertEquals([row.state, row.tier, row.quote?.totalCents], ["dm_delivered", "auto", 2000]);
  assertEquals(tokensIn(h.notifier.messages[0]).length, 1, "veto DM carries only a deny link");
  h.advance(9 * MIN);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "dm_delivered");
  h.advance(2 * MIN);
  const rep = await h.orch.tick();
  assertEquals(rep.placed, 1);
  const done = h.ledger.getRequest(row.id)!;
  assertEquals([done.state, done.finalCents], ["placed", 2000]);
  assert(done.vendorOrderId?.startsWith("mock-"));
});

Deno.test("(b) $80 under default config → ask → owner taps the approve link → tick → re-decide → placed", async () => {
  const h = await harness();
  const row = await h.orch.submit(req("S80"));
  assertEquals([row.state, row.decision], ["pending_approval", "ask"]);
  const dm = h.notifier.messages[0];
  const [approveToken, denyToken] = tokensIn(dm);
  assert(approveToken && denyToken && approveToken.token !== denyToken.token);
  assert(dm.includes("if approved: $20.00 left today, $170.00 this month"), dm);
  // the approve page shows only the approve form, and never the token (it stays in the fragment)
  const page = await (await view(approveToken)).text();
  assert(page.includes(`/a/${approveToken.id}/approve`) && !page.includes("/deny\""));
  assert(!page.includes(approveToken.token) && !page.includes(denyToken.token));
  const res = await tap(approveToken, "approve");
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const rep = await h.orch.tick();
  assertEquals(rep.verdictsApplied, 1);
  // $80 is already counted in the day window ($100); re-decide excludes the row's own amount.
  const done = h.ledger.getRequest(row.id)!;
  assertEquals([done.state, done.approver, done.finalCents], ["placed", "owner", 8000]);
});

Deno.test("(c) $1200 → refused outright, no DM", async () => {
  const h = await harness();
  const row = await h.orch.submit(req("S1200"));
  assertEquals([row.state, row.tier, row.reasons], ["denied", "refuse", ["over_max"]]);
  assertEquals(h.notifier.messages.length, 0);
});

Deno.test("(d) joy (silent tier off): the veto DM and relay page never name the item; a veto tap → cancelled", async () => {
  const h = await harness({ notify: { silent_below_cents: 0 } });
  const row = await h.orch.submit(req("S20", {
    budget: "joy",
    items: [{ sku: "S20", qty: 1, title: "Secret Kite" }],
    whyNote: "you mentioned kites on the beach last week",
  }));
  assertEquals(row.state, "dm_delivered");
  const dm = h.notifier.messages[0];
  const text = dm.replace(/<https:\/\/[^>]+>/g, "<link>"); // random ids / tokens may contain "S20"
  assert(!text.includes("Kite") && !text.includes("S20") && !text.includes("beach"), dm);
  const [denyToken] = tokensIn(dm);
  const page = await (await view(denyToken)).text();
  assert(!page.includes("Kite") && !page.includes(">mock<"), "page is sealed too");
  const res = await tap(denyToken, "deny");
  assertEquals(res.status, 200);
  await res.body?.cancel();
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "cancelled");
  h.advance(11 * MIN);
  await h.orch.tick();
  assertEquals((await h.mock.listCharges("2000-01-01T00:00:00Z")).length, 0, "never placed");
});

Deno.test("(e) a $5 purchase shipped to someone else → ask, with the address in the DM", async () => {
  const h = await harness();
  const row = await h.orch.submit(req("S5", { shipTo: { name: "Jane Doe", line1: "1 Main St", city: "Springfield", state: "IL", zip: "62701" } }));
  assertEquals([row.state, row.tier, row.decision, row.reachEffective], ["pending_approval", "auto", "ask", "others"]);
  assert(row.reasons?.includes("reach_others"));
  assert(h.notifier.messages[0].includes("ship to: Jane Doe, Springfield IL"));
});

Deno.test("(f) a phantom vendor charge → reconcile → STOP → the next request is refused", async () => {
  const phantom = { vendorChargeId: "ph-1", amountCents: 4200, at: new Date().toISOString() };
  const h = await harness({}, { phantomCharges: [phantom] });
  const run = await h.reconcile();
  assertEquals([run.ok, run.unmatched], [0, 1]);
  assert(h.ledger.isStopped());
  assert(h.notifier.messages.at(-1)!.includes("ph-1"));
  await assertRejects(() => h.orch.submit(req("S5")), StopActive);
  assert(h.adapters.mock.isPaused(), "guard paused the vendor");
  const n = h.db.prepare("SELECT COUNT(*) AS n FROM charges WHERE vendor_charge_id = 'ph-1'").get() as { n: number };
  assertEquals(Number(n.n), 1);
});

Deno.test("(g) the relay approving without the approve token is ignored; the deny token can't approve", async () => {
  // A relay whose verdict feed drops the proof token (compromised, or a stale/old relay).
  const stripping: RelayClient = {
    publish: (a) => relayClient.publish(a),
    pullVerdicts: async (s) => (await relayClient.pullVerdicts(s)).map(({ token: _t, ...v }: Verdict) => v),
  };
  const h = await harness({}, {}, stripping);
  const row = await h.orch.submit(req("S80"));
  const [approveToken, denyToken] = tokensIn(h.notifier.messages[0]);
  // posting the deny token to the approve path is refused at the relay and consumes nothing
  const wrong = await tap(denyToken, "approve");
  assertEquals(wrong.status, 403);
  await wrong.body?.cancel();
  // a real approve tap, but the verdict reaches the gate without its token
  const ok = await tap(approveToken, "approve");
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
  const rep = await h.orch.tick();
  assertEquals(rep.verdictsApplied, 0);
  assertEquals(h.ledger.getRequest(row.id)!.state, "pending_approval");
  assertEquals(h.ledger.getApprovalForRequest(row.id)!.usedAt, undefined);
  assertEquals((await h.mock.listCharges("2000-01-01T00:00:00Z")).length, 0);
});

Deno.test("a veto tapped on a DM the transport reported as failed still cancels; no re-DM, no order", async () => {
  const h = await harness({ notify: { silent_below_cents: 0 } });
  // The DM arrives, but the transport times out and reports failure.
  const lying = { messages: [] as string[], send(t: string) {
    this.messages.push(t);
    return Promise.resolve({ ok: false, error: "fetch_TimeoutError" });
  } };
  h.orch["d"].notifier = lying;
  const row = await h.orch.submit(req("S20"));
  assertEquals(row.state, "dm_pending");
  const [denyToken] = tokensIn(lying.messages[0]);
  const res = await tap(denyToken, "deny");
  assertEquals(res.status, 200);
  await res.body?.cancel();
  h.orch["d"].notifier = h.notifier; // DM path recovers
  h.advance(11 * MIN);
  await h.orch.tick();
  h.advance(11 * MIN);
  await h.orch.tick();
  const done = h.ledger.getRequest(row.id)!;
  assertEquals(done.state, "cancelled");
  assert(done.reasons!.includes("vetoed"), "the owner's veto itself was applied");
  assertEquals(h.notifier.messages.length, 0, "no second DM with dead links");
  assertEquals((await h.mock.listCharges("2000-01-01T00:00:00Z")).length, 0);
});

Deno.test("joy $90 is denied as joy_over_auto (real policy, not a window)", async () => {
  const h = await harness();
  const row = await h.orch.submit(req("S90", { budget: "joy" }));
  assertEquals([row.state, row.reasons], ["denied", ["joy_over_auto"]]);
});

Deno.test("parallel in-flight asks reserve budget: 4 concurrent $20 asks vs a $75 month cap → 4th denied", async () => {
  const h = await harness({
    tiers: { auto_max_cents: 2000, ask_max_cents: 7500, fund_enabled: false, fund_max_cents: 0 },
    caps: { day_cents: 7500, month_cents: 7500, vendor_month_cents: 7500 },
    joy: { week_cents: 1000 },
  });
  // Widen the race window the way any real I/O would: reading the windows takes a few ms. Without
  // the orchestrator's money lock all four would read "$0 spent" and all four would pass.
  const orig = h.ledger.windowsFor.bind(h.ledger);
  h.ledger.windowsFor = ((...a: Parameters<typeof orig>) =>
    new Promise((r) => setTimeout(() => r(orig(...a)), 5))) as unknown as typeof orig;
  const rows = await Promise.all([1, 2, 3, 4].map(() => h.orch.submit(req("S20"))));
  const states = rows.map((r) => r.state);
  assertEquals(states.filter((s) => s === "pending_approval").length, 3, states.join(","));
  const denied = rows.filter((r) => r.state === "denied");
  assertEquals(denied.length, 1);
  assert(denied[0].reasons!.includes("window:global/month"), denied[0].reasons!.join(","));
  // ...while the first three are still only pending
  assertEquals((await h.ledger.windowsFor("mock", "general", h.clock.now()))["global/month"].spentCents, 6000);
});

Deno.test("fund tier: hold → veto window → placed; one sign convention; double release is a no-op", async () => {
  const h = await harness();
  h.ledger.addFundEntry({ kind: "topup", cents: 100_000 }, h.clock.now());
  const row = await h.orch.submit(req("S600"));
  assertEquals([row.state, row.tier], ["dm_delivered", "fund_auto"]);
  assertEquals(h.ledger.fundBalance(), 40_000, "hold is negative");
  assertEquals(h.ledger.fundBalance(row.id), 100_000, "excludeHoldFor adds the request's own hold back");
  h.advance(121 * MIN);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "placed");
  assertEquals(h.ledger.fundBalance(), 40_000, "release(+60000) then spend(-60000)");
  h.ledger.addFundEntry({ kind: "release", cents: 60_000, requestId: row.id }, h.clock.now());
  assertEquals(h.ledger.fundBalance(), 40_000, "nothing left to release");
  const kinds = h.db.prepare("SELECT kind, cents FROM fund_entries ORDER BY id").all() as { kind: string; cents: number }[];
  assertEquals(kinds.map((k) => `${k.kind}:${k.cents}`), ["topup:100000", "hold:-60000", "release:60000", "spend:-60000"]);
  let threw = false;
  try {
    h.ledger.addFundEntry({ kind: "hold", cents: 500, requestId: row.id }, h.clock.now());
  } catch {
    threw = true;
  }
  assert(threw, "a positive hold violates the convention");
});

Deno.test("tokens never land in the gate DB", async () => {
  const h = await harness();
  await h.orch.submit(req("S80"));
  const [a, d] = tokensIn(h.notifier.messages[0]);
  const dump = JSON.stringify([
    h.db.prepare("SELECT * FROM approvals").all(),
    h.db.prepare("SELECT * FROM requests").all(),
    h.db.prepare("SELECT * FROM events").all(),
    h.db.prepare("SELECT * FROM settings").all(),
  ]);
  assert(!dump.includes(a.token) && !dump.includes(d.token));
  assert(dump.includes(await hashToken(a.token)));
  assert(dump.includes(a.id) && dump.includes(d.id), "the public lookupIds are stored");
});

Deno.test("silent tier on the real ledger: $20 → placed with no DM; the flag persists; reveal before close", async () => {
  const h = await harness(); // default [notify]: silent below $40
  const row = await h.orch.submit(req("S20", { whyNote: "the old supply was buzzing", hint: "for the bench" }));
  assertEquals([row.state, row.silent, row.sealed, row.hint], ["approved", true, false, "for the bench"]);
  assertEquals(h.notifier.messages.length, 0);
  // the persisted flag is what the ledger's own transition check sees
  const flags = h.db.prepare("SELECT silent, sealed, hint FROM requests WHERE id = ?").get(row.id) as Record<string, unknown>;
  assertEquals([Number(flags.silent), Number(flags.sealed), flags.hint], [1, 0, "for the bench"]);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "placed");
  // mock orders advance one step per status poll: open → shipped → delivered
  await h.orch.tick();
  h.notifier.fail = true;
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "delivered", "no why-note yet → stays delivered");
  h.notifier.fail = false;
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "closed");
  assertEquals(h.notifier.messages.length, 1);
  assert(h.notifier.messages[0].includes("Item S20") && h.notifier.messages[0].includes("buzzing"));
});

Deno.test("sealed ask on the real relay: neither the DM nor the page names the item", async () => {
  const h = await harness();
  const row = await h.orch.submit(req("S80", { items: [{ sku: "S80", qty: 1, title: "Rigol Oscilloscope", url: "https://shop.example/rigol" }], hint: "for seeing signals" }));
  assertEquals([row.state, row.sealed], ["pending_approval", true]);
  const dm = h.notifier.messages[0];
  const masked = dm.replace(/<https:\/\/relay\.test\/[^>]+>/g, "<link>");
  assert(!/rigol|oscilloscope|shop\.example|S80/i.test(masked), dm);
  const [approve] = tokensIn(dm);
  const page = await (await view(approve)).text();
  assert(!/rigol|oscilloscope|shop\.example/i.test(page) && page.includes("for seeing signals"), "page is sealed too");
});

Deno.test("import-order: a hand-placed order counts in the windows and reconcile matches it", async () => {
  const charge = { vendorChargeId: "ch-hand-1", amountCents: 2600, at: new Date().toISOString(), vendorOrderId: "hand-1" };
  const h = await harness({}, { phantomCharges: [charge] });
  const app = createApp({ ...h.server, agentToken: "a".repeat(40), adminToken: "b".repeat(40) });
  const post = (body: unknown) =>
    app.request("/internal/import-order", {
      method: "POST",
      headers: { Authorization: `Bearer ${"b".repeat(40)}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const body = { vendor: "mock", vendorOrderId: "hand-1", cents: 2600, note: "bought by hand while the gate was down" };
  const res = await post(body);
  assertEquals(res.status, 201);
  const row = await res.json();
  assertEquals([row.state, row.requester, row.tier, row.reachEffective, row.budget, row.finalCents], ["placed", "manual-import", "auto", "self", "general", 2600]);
  // idempotent on vendor + order id; a different amount is a conflict
  const again = await post(body);
  assertEquals([again.status, (await again.json()).id], [200, row.id]);
  assertEquals((await post({ ...body, cents: 2700 })).status, 409);
  assertEquals((await post({ ...body, vendorOrderId: "has space" })).status, 400);
  assertEquals(h.ledger.windowsFor("mock", "general", h.clock.now())["global/day"].spentCents, 2600);
  const run = await h.reconcile();
  assertEquals([run.ok, run.unmatched, run.overCap], [1, 0, 0]);
  assertEquals(h.ledger.isStopped(), false);
  assertEquals(h.ledger.getRequest(row.id)!.hardCapCents, 2600);
});

Deno.test("reconcile on the real ledger: hard cap stored at placing; under-cap charge → finalCents, over-cap → STOP", async () => {
  const h = await harness();
  const row = await h.orch.submit(req("S20", { maxTotalCents: 2500 })); // silent tier: no DM
  assertEquals(row.state, "approved");
  await h.orch.tick();
  const placed = h.ledger.getRequest(row.id)!;
  assertEquals([placed.state, placed.finalCents, placed.hardCapCents], ["placed", 2000, 2000]);

  // The vendor's real charge comes in under the cap (a hold refunded down): no STOP, ledger follows.
  const real = await h.mock.listCharges("2000-01-01T00:00:00Z");
  assertEquals(real.length, 1);
  h.mock.listCharges = () => Promise.resolve([{ ...real[0], amountCents: 1890 }]);
  let run = await h.reconcile();
  assertEquals([run.ok, run.unmatched, run.overCap, run.adjusted], [1, 0, 0, 1]);
  assertEquals(h.ledger.isStopped(), false);
  assertEquals(h.ledger.getRequest(row.id)!.finalCents, 1890);
  assertEquals(h.ledger.windowsFor("mock", "general", h.clock.now())["global/day"].spentCents, 1890, "windows count finalCents");
  const ev = h.db.prepare("SELECT from_state, to_state, note FROM events WHERE request_id = ? ORDER BY id DESC LIMIT 1")
    .get(row.id) as { from_state: string; to_state: string; note: string };
  assertEquals([ev.from_state, ev.to_state, ev.note], ["placed", "placed", "reconcile_final:2000->1890"]);
  const rr = h.db.prepare("SELECT ok, unmatched, note FROM reconcile_runs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
  assertEquals([Number(rr.ok), Number(rr.unmatched), rr.note], [1, 0, "adjusted:1"]);

  // Same amount again: nothing to adjust, nothing logged.
  run = await h.reconcile();
  assertEquals([run.ok, run.adjusted], [1, 0]);

  // One cent over the cap: STOP.
  h.mock.listCharges = () => Promise.resolve([{ ...real[0], amountCents: 2001 }]);
  run = await h.reconcile();
  assertEquals([run.ok, run.overCap], [0, 1]);
  assert(h.ledger.isStopped());
  assertEquals(h.ledger.getRequest(row.id)!.finalCents, 1890, "an over-cap charge never rewrites the ledger");
  assert(h.notifier.messages.at(-1)!.includes("over_cap"));
});

Deno.test("cleanup", async () => {
  const { closeStore } = await import("../relay/store.ts");
  await closeStore();
  Deno.removeSync(RELAY_DIR, { recursive: true });
});
