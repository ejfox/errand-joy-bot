// End to end: real SQLite ledger, real policy/state, guarded MockAdapter, FakeNotifier, and the REAL
// relay handler in-process (HttpRelayClient with its fetch pointed at relay/main.ts). No network.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { validateConfig } from "./config.ts";
import { buildDeps } from "./wiring.ts";
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
/** The owner's browser: POST the form on the page the DM link opened. */
function tap(token: string, action: "approve" | "deny"): Promise<Response> {
  ip++;
  return relayMod.default.fetch(
    new Request(`${RELAY_BASE}/a/${token}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": `198.51.100.${ip % 250}` },
      body: new URLSearchParams({ token }).toString(),
    }),
  );
}
function view(token: string): Promise<Response> {
  ip++;
  return relayMod.default.fetch(new Request(`${RELAY_BASE}/a/${token}`, { headers: { "cf-connecting-ip": `198.51.100.${ip % 250}` } }));
}

const tokensIn = (dm: string) => [...dm.matchAll(/<https:\/\/relay\.test\/a\/([A-Za-z0-9_-]{43})>/g)].map((m) => m[1]);

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

Deno.test("(a) $20 auto → veto DM → cancel window elapses → placed", async () => {
  const h = await harness({ tiers: { auto_max_cents: 2500, ask_max_cents: 10_000, fund_enabled: false, fund_max_cents: 0 }, caps: { day_cents: 2500, month_cents: 7500, vendor_month_cents: 7500 }, joy: { week_cents: 1000 } });
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
  assert(approveToken && denyToken && approveToken !== denyToken);
  assert(dm.includes("if approved: $20.00 left today, $170.00 this month"), dm);
  // the approve page shows only the approve form
  const page = await (await view(approveToken)).text();
  assert(page.includes(`/a/${approveToken}/approve`) && !page.includes("/deny\""));
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

Deno.test("(d) joy: the veto DM and relay page never name the item; a veto tap → cancelled", async () => {
  const h = await harness();
  const row = await h.orch.submit(req("S20", {
    budget: "joy",
    items: [{ sku: "S20", qty: 1, title: "Secret Kite" }],
    whyNote: "you mentioned kites on the beach last week",
  }));
  assertEquals(row.state, "dm_delivered");
  const dm = h.notifier.messages[0];
  assert(!dm.includes("Kite") && !dm.includes("S20") && !dm.includes("beach"), dm);
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
  const h = await harness();
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
  assert(!dump.includes(a) && !dump.includes(d));
  assert(dump.includes(await hashToken(a)));
});

Deno.test("cleanup", async () => {
  const { closeStore } = await import("../relay/store.ts");
  await closeStore();
  Deno.removeSync(RELAY_DIR, { recursive: true });
});
