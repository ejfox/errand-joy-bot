import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type Charge,
  DEFAULT_NOTICE,
  IdempotencyConflict,
  IllegalTransition,
  type NoticePolicy,
  type Order,
  type PurchaseRequest,
  type Quote,
  type Reach,
  StopActive,
  type VendorAdapter,
} from "./types.ts";
import {
  contractPolicy,
  contractStateGuard,
  MemoryLedger,
  Orchestrator,
  type PolicyPort,
  type StatePort,
} from "./orchestrator.ts";
import { decide as wp1Decide } from "./policy.ts";
import { assertTransition as wp1AssertTransition } from "./state.ts";
import { FakeHealthAlerter, FakeNotifier } from "./notify.ts";
import { FakeRelayClient } from "./relay_client.ts";
import { hashToken } from "./approval.ts";
import { GuardRefused } from "./adapters/registry.ts";

// 12:00 America/New_York on a Monday: outside quiet hours.
const NOON = Date.parse("2026-10-12T16:00:00Z");
const MIN = 60_000, HOUR = 3600_000;
export const RELAY = "https://approve.example.test";

export class FakeAdapter implements VendorAdapter {
  id = "fakeshop";
  maxReach: Reach = "others";
  price = 2300;
  placed: { hardCap: number; key: string; total: number }[] = [];
  statusState: "open" | "shipped" | "delivered" | "cancelled" = "open";
  paused = 0;
  quoteCalls = 0;
  constructor(private readonly clock: { now(): Date }) {}
  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo && req.shipTo !== "owner-home" ? "others" : "self";
  }
  prices: Record<string, number> = {};
  quote(req: PurchaseRequest): Promise<Quote> {
    this.quoteCalls++;
    const total = req.items.reduce((s, i) => s + (this.prices[i.sku] ?? this.price) * i.qty, 0);
    return Promise.resolve({
      subtotalCents: total, taxCents: 0, shippingCents: 0, totalCents: total, currency: "USD",
      quotedAt: this.clock.now().toISOString(),
    });
  }
  place(_r: PurchaseRequest, q: Quote, hardCap: number, key: string): Promise<Order> {
    this.placed.push({ hardCap, key, total: q.totalCents });
    return Promise.resolve({ vendorOrderId: `ord-${this.placed.length}`, chargedCents: q.totalCents });
  }
  status(_id: string) {
    return Promise.resolve({ state: this.statusState });
  }
  cancel(_id: string) {
    return Promise.resolve(true);
  }
  listCharges(_since: string): Promise<Charge[]> {
    return Promise.resolve([]);
  }
  pause() {
    this.paused++;
    return Promise.resolve();
  }
}

/**
 * Most tests here exercise the DM / veto path with the $23 fixture price, which the default
 * [notify] would make silent, so the harness turns the silent tier off unless `notice` says
 * otherwise. The silent-tier and sealed tests pass DEFAULT_NOTICE explicitly.
 */
export function harness(
  start = NOON,
  wp1?: { policy: PolicyPort; state: StatePort },
  notice: Partial<NoticePolicy> = { silentBelowCents: 0 },
) {
  let t = start;
  const clock = { now: () => new Date(t) };
  const ledger = new MemoryLedger(clock);
  const notifier = new FakeNotifier();
  const relay = new FakeRelayClient();
  const adapter = new FakeAdapter(clock);
  const alerter = new FakeHealthAlerter(() => clock.now());
  const logs: string[] = [];
  const orch = new Orchestrator({
    ledger, policy: wp1?.policy ?? contractPolicy, state: wp1?.state ?? contractStateGuard, adapters: { fakeshop: adapter },
    notifier, relay, clock, alerter, log: (e, d) => logs.push(JSON.stringify({ e, d })),
    relayPublicUrl: RELAY, quietHours: { start: 22 * 60, end: 7 * 60 + 30, tz: "America/New_York" }, notice,
  });
  /** Owner taps approve: the relay forwards the approve link's token as proof-of-tap. */
  const approve = async (approvalId: string) => {
    const rec = relay.published.find((p) => p.approvalId === approvalId)!;
    for (const m of notifier.messages) {
      for (const t of tokensFrom(m)) {
        if ((await hashToken(t)) === rec.approveTokenHash) return relay.tap(approvalId, "approve", clock.now(), t);
      }
    }
    throw new Error("no DM token for that approval");
  };
  return {
    approve,
    clock, ledger, notifier, relay, adapter, alerter, logs, orch,
    advance: (ms: number) => (t += ms),
    set: (ms: number) => (t = ms),
  };
}

let n = 0;
export function req(over: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    idempotencyKey: `k-${++n}`, requester: "scout", taskId: "t1", vendor: "fakeshop",
    items: [{ sku: "SKU-1", qty: 1, title: "Brass Telescope" }],
    reason: "needed for the build: the old one cracked and the project is blocked until it is replaced",
    reach: "self", maxTotalCents: 60_000, ...over,
  };
}

const LINK_RE = /<https:\/\/approve\.example\.test\/a\/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})>/g;

/** Every approval-link token (the #fragment) in a DM, in order (ask DMs: approve first, then deny). */
export function tokensFrom(msg: string): string[] {
  return [...msg.matchAll(LINK_RE)].map((m) => m[2]);
}

/** Every approval-link lookupId (the path part) in a DM, in the same order. */
export function lookupIdsFrom(msg: string): string[] {
  return [...msg.matchAll(LINK_RE)].map((m) => m[1]);
}

function tokenFrom(msg: string): string {
  const t = tokensFrom(msg)[0];
  if (!t) throw new Error("no approval link in DM");
  return t;
}

Deno.test("ask tier: exactly one DM with approve link; published record holds only the hash", async () => {
  const h = harness();
  h.adapter.price = 8000;
  const row = await h.orch.submit(req());
  assertEquals(row.state, "pending_approval");
  await h.orch.tick();
  assertEquals(h.notifier.messages.length, 1);
  const msg = h.notifier.messages[0];
  assert(msg.includes("approve (24h): <"));
  const [approveToken, denyToken] = tokensFrom(msg);
  assert(approveToken && denyToken && approveToken !== denyToken, "two separate links");
  assertEquals(h.relay.published.length, 1);
  const rec = h.relay.published[0];
  assert(msg.includes(`deny: <${RELAY}/a/${rec.denyLookupId}#${denyToken}>`));
  assert(msg.includes(`approve (24h): <${RELAY}/a/${rec.approveLookupId}#${approveToken}>`));
  assertEquals(lookupIdsFrom(msg), [rec.approveLookupId, rec.denyLookupId]);
  assertEquals(Object.keys(rec).sort(), [
    "approvalId", "approveLookupId", "approveTokenHash", "boundCents", "denyLookupId", "denyTokenHash", "expiresAt",
    "kind", "requestId", "summary", "vendor",
  ]);
  assertEquals(rec.kind, "approve");
  assertEquals(rec.boundCents, 8000);
  assertEquals(rec.approveTokenHash, await hashToken(approveToken));
  assertEquals(rec.denyTokenHash, await hashToken(denyToken));
  assert(!JSON.stringify(rec).includes(approveToken));
  assert(!JSON.stringify(rec).includes(denyToken));
  // the ask DM shows the cap headroom left if approved: $100 day − $80, $250 month − $80
  assert(msg.includes("if approved: $20.00 left today, $170.00 this month"), msg);
});

Deno.test("an approve verdict carrying the DENY token is ignored", async () => {
  const h = harness();
  h.adapter.price = 8000;
  const row = await h.orch.submit(req());
  const [, denyToken] = tokensFrom(h.notifier.messages[0]);
  const id = h.relay.published[0].approvalId;
  h.relay.tap(id, "approve", h.clock.now(), denyToken);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "pending_approval");
  assertEquals(h.ledger.getApproval(id)!.usedAt, undefined);
  assertEquals(h.adapter.placed.length, 0);
});

Deno.test("veto DMs carry only the deny link; their record has no approve hash", async () => {
  const h = harness();
  await h.orch.submit(req());
  assertEquals(tokensFrom(h.notifier.messages[0]).length, 1);
  assertEquals(h.relay.published[0].approveTokenHash, undefined);
  assertEquals(h.relay.published[0].approveLookupId, undefined);
  assertEquals(lookupIdsFrom(h.notifier.messages[0]), [h.relay.published[0].denyLookupId]);
  assertEquals(h.relay.published[0].kind, "veto");
});

Deno.test("intake refuses a short reason", async () => {
  const h = harness();
  await assertRejects(() => h.orch.submit(req({ reason: "because" })), Error, "reason too short");
});

Deno.test("approve verdict → re-decide → placing → placed with hardCap = bound", async () => {
  const h = harness();
  h.adapter.price = 8000;
  const row = await h.orch.submit(req());
  const rec = h.relay.published[0];
  h.advance(MIN);
  await h.approve(rec.approvalId);
  const rep = await h.orch.tick();
  assertEquals(rep.placed, 1);
  const after = h.ledger.getRequest(row.id)!;
  assertEquals(after.state, "placed");
  assertEquals(h.adapter.placed[0].hardCap, 8000);
  assert(h.ledger.events.some((e) => e.requestId === row.id && e.to === "placing"));
  assertEquals(after.approver, "owner");
  // replayed verdict is a no-op (single use)
  await h.approve(rec.approvalId);
  await h.orch.tick();
  assertEquals(h.adapter.placed.length, 1);
});

Deno.test("approve after the window filled → denied with policy_changed", async () => {
  const h = harness();
  h.adapter.price = 8000;
  const row = await h.orch.submit(req());
  assertEquals(row.state, "pending_approval");
  h.ledger.budgets["global/day"] = 5000; // something else ate the day
  await h.approve(h.relay.published[0].approvalId);
  await h.orch.tick();
  const after = h.ledger.getRequest(row.id)!;
  assertEquals(after.state, "denied");
  assert(after.reasons!.includes("policy_changed"));
  assertEquals(h.adapter.placed.length, 0);
});

Deno.test("auto tier: veto inside the 10 min window → cancelled, never placed", async () => {
  const h = harness();
  const row = await h.orch.submit(req());
  assertEquals(row.state, "dm_delivered");
  assertEquals(h.relay.published[0].kind, "veto");
  h.advance(5 * MIN);
  h.relay.tap(h.relay.published[0].approvalId, "deny", h.clock.now());
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "cancelled");
  h.advance(30 * MIN);
  await h.orch.tick();
  assertEquals(h.adapter.placed.length, 0);
});

Deno.test("auto tier: an approve tap on a veto link is ignored; window elapses → placed", async () => {
  const h = harness();
  const row = await h.orch.submit(req());
  // a relay claiming "approve" with the veto link's (deny) token
  h.relay.tap(h.relay.published[0].approvalId, "approve", h.clock.now(), tokenFrom(h.notifier.messages[0]));
  h.advance(9 * MIN);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "dm_delivered");
  h.advance(2 * MIN);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "placed");
});

Deno.test("joy veto: DM and relay summary never name the item", async () => {
  const h = harness();
  const row = await h.orch.submit(req({ budget: "joy", items: [{ sku: "X9", qty: 1, title: "Brass Telescope" }] }));
  assertEquals(row.state, "dm_delivered");
  const msg = h.notifier.messages[0];
  assert(msg.startsWith("robot spent $23.00 on something this week. tap to veto: <https://approve.example.test/a/"));
  // check the text minus the link: random lookupIds / tokens can contain "X9" by chance
  for (const s of [msg.replace(/<https:\/\/[^>]+>/g, "<link>"), h.relay.published[0].summary]) {
    assert(!s.includes("Telescope"));
    assert(!s.includes("X9"));
  }
});

Deno.test("DM failure → stays dm_pending, nothing placed; >2h alerts once; 24h trips STOP", async () => {
  const h = harness();
  h.notifier.fail = true;
  const row = await h.orch.submit(req());
  assertEquals(row.state, "dm_pending");
  for (let i = 0; i < 4; i++) {
    h.advance(30 * MIN);
    await h.orch.tick();
  }
  const mid = h.ledger.getRequest(row.id)!;
  assertEquals(mid.state, "dm_pending");
  assert(mid.dmAttempts >= 4);
  assertEquals(h.adapter.placed.length, 0);
  assertEquals(h.alerter.alerts.length, 0); // exactly 2h is not ">2h"
  h.advance(10 * MIN);
  await h.orch.tick();
  h.advance(10 * MIN);
  await h.orch.tick();
  assertEquals(h.alerter.alerts.map((a) => a.kind), ["dm_down"]); // rate limited to one
  h.set(NOON + 24 * HOUR);
  const rep = await h.orch.tick();
  assert(rep.stopped);
  assert(h.ledger.stopped);
  assertEquals(h.alerter.alerts.map((a) => a.kind), ["dm_down", "stop_tripped"]);
  assert(h.adapter.paused >= 1);
  assertEquals(h.adapter.placed.length, 0);
});

Deno.test("relay publish failure → no DM is sent and the row stays dm_pending", async () => {
  const h = harness();
  h.relay.failPublish = true;
  const row = await h.orch.submit(req());
  assertEquals(row.state, "dm_pending");
  assertEquals(h.notifier.messages.length, 0);
  h.relay.failPublish = false;
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "dm_delivered");
  assertEquals(h.notifier.messages.length, 1);
});

Deno.test("quiet hours → queued, not sent, not counted as a failure; sends at 07:30", async () => {
  const h = harness(Date.parse("2026-10-13T03:00:00Z")); // 23:00 NY
  const row = await h.orch.submit(req());
  assertEquals(row.state, "dm_pending");
  assertEquals(row.dmAttempts, 0);
  h.set(Date.parse("2026-10-13T11:00:00Z")); // 07:00 NY
  await h.orch.tick();
  assertEquals(h.notifier.messages.length, 0);
  h.set(Date.parse("2026-10-13T11:31:00Z")); // 07:31 NY
  await h.orch.tick();
  assertEquals(h.notifier.messages.length, 1);
  assertEquals(h.ledger.getRequest(row.id)!.state, "dm_delivered");
});

Deno.test("re-quote that changes the amount invalidates the binding → denied quote_changed", async () => {
  const h = harness();
  h.adapter.price = 8000;
  const row = await h.orch.submit(req());
  await h.approve(h.relay.published[0].approvalId);
  h.adapter.price = 8001;
  await h.orch.tick();
  const after = h.ledger.getRequest(row.id)!;
  assertEquals(after.state, "denied");
  assert(after.reasons!.includes("quote_changed"));
  assertEquals(h.adapter.placed.length, 0);
});

Deno.test("reach others (ship to a stranger) always asks, even under $69", async () => {
  const h = harness();
  const row = await h.orch.submit(req({
    shipTo: { name: "A", line1: "1 St", city: "C", state: "NY", zip: "10001" },
  }));
  assertEquals(row.state, "pending_approval");
  assertEquals(row.reachEffective, "others");
  assertEquals(h.relay.published[0].kind, "approve");
});

Deno.test("fund_auto: veto DM, 2h window, paid from the fund", async () => {
  const h = harness();
  h.adapter.price = 60_000;
  h.ledger.addFundEntry({ kind: "topup", cents: 100_000 }, h.clock.now());
  const row = await h.orch.submit(req({ maxTotalCents: 70_000 }));
  assertEquals(row.state, "dm_delivered");
  assert(h.notifier.messages[0].includes("robot fund pays $600.00"));
  assertEquals(h.ledger.fundBalance(), 40_000);
  h.advance(HOUR);
  await h.orch.tick();
  assertEquals(h.adapter.placed.length, 0);
  h.advance(HOUR + MIN);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "placed");
  assertEquals(h.ledger.fundBalance(), 40_000);
});

Deno.test("ask expires after 24h without a tap", async () => {
  const h = harness();
  h.adapter.price = 8000;
  const row = await h.orch.submit(req());
  h.advance(24 * HOUR + MIN);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "expired");
});

Deno.test("idempotency: same payload returns the row; different payload trips STOP", async () => {
  const h = harness();
  const r = req();
  const a = await h.orch.submit(r);
  const b = await h.orch.submit(r);
  assertEquals(a.id, b.id);
  assertEquals(h.notifier.messages.length, 1);
  await assertRejects(() => h.orch.submit({ ...r, reason: r.reason + " (and a different payload)" }), IdempotencyConflict);
  assert(h.ledger.stopped);
});

Deno.test("velocity: a 6th request inside 10 min is denied and trips STOP", async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) await h.orch.submit(req({ maxTotalCents: 100 * 100 }));
  h.adapter.price = 100;
  const sixth = await h.orch.submit(req());
  assertEquals(sixth.state, "denied");
  assert(h.ledger.stopped);
  assert(h.alerter.alerts.some((a) => a.kind === "stop_tripped"));
});

Deno.test("joy delivered → why-note DM → closed", async () => {
  const h = harness();
  const row = await h.orch.submit(req({ budget: "joy" }));
  h.advance(11 * MIN);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "placed");
  h.adapter.statusState = "delivered";
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "closed");
  assert(h.notifier.messages.at(-1)!.includes("Brass Telescope"));
});

Deno.test("the plaintext token appears only in the DM text", async () => {
  const captured: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) {
    console[k] = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  }
  try {
    const h = harness();
    h.adapter.price = 8000;
    h.ledger.budgets["global/day"] = 50_000;
    h.ledger.vendorMonthCap = 50_000;
    h.notifier.fail = true;
    const row = await h.orch.submit(req());
    h.notifier.fail = false;
    await h.orch.tick();
    h.adapter.prices["JOY-1"] = 2300;
    const auto = await h.orch.submit(req({ budget: "joy", items: [{ sku: "JOY-1", qty: 1, title: "Kite" }] }));
    await h.approve(h.relay.published.find((p) => p.requestId === row.id)!.approvalId);
    h.advance(11 * MIN);
    await h.orch.tick();
    assertEquals(h.ledger.getRequest(row.id)!.state, "placed");
    assertEquals(h.ledger.getRequest(auto.id)!.state, "placed");
    const tokens = h.notifier.messages.filter((m) => m.includes("/a/")).flatMap(tokensFrom);
    assertEquals(tokens.length, 3); // ask: approve + deny; joy veto: deny
    const haystacks = [
      ...h.ledger.writes,
      JSON.stringify([...h.ledger.rows.values()]),
      JSON.stringify([...h.ledger.approvals.values()]),
      JSON.stringify(h.ledger.events),
      JSON.stringify(h.relay.published),
      ...h.logs,
      ...captured,
      JSON.stringify(h.alerter.alerts),
    ];
    for (const t of tokens) for (const s of haystacks) assert(!s.includes(t), "token leaked outside the DM");
  } finally {
    Object.assign(console, orig);
  }
});

Deno.test("STOP blocks intake and tick", async () => {
  const h = harness();
  await h.orch.stop("manual");
  await assertRejects(() => h.orch.submit(req()));
  const rep = await h.orch.tick();
  assert(rep.stopped);
  assertEquals(h.notifier.messages.length, 1); // the STOP DM itself
  assert(h.notifier.messages[0].startsWith("purchase-gate STOP"));
});

Deno.test("integration with WP1 policy.ts + state.ts: ask→approve→placed, auto veto, joy sealed", async () => {
  const wp1 = { policy: { decide: wp1Decide }, state: { assertTransition: wp1AssertTransition } };
  const h = harness(NOON, wp1);
  h.adapter.price = 8000;
  const ask = await h.orch.submit(req());
  assertEquals(ask.state, "pending_approval");
  await h.approve(h.relay.published[0].approvalId);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(ask.id)!.state, "placed");

  const h2 = harness(NOON, wp1);
  const auto = await h2.orch.submit(req({ budget: "joy" }));
  assertEquals(auto.state, "dm_delivered");
  assert(!h2.notifier.messages[0].includes("Telescope"));
  h2.relay.tap(h2.relay.published[0].approvalId, "deny", h2.clock.now());
  await h2.orch.tick();
  assertEquals(h2.ledger.getRequest(auto.id)!.state, "cancelled");
});

Deno.test("relay can't approve on its own word: approve without/with a wrong token is ignored", async () => {
  const h = harness();
  h.adapter.price = 8000;
  const row = await h.orch.submit(req());
  const id = h.relay.published[0].approvalId;
  h.relay.tap(id, "approve", h.clock.now());
  h.relay.tap(id, "approve", h.clock.now(), "A".repeat(43));
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "pending_approval");
  assertEquals(h.ledger.getApproval(id)!.usedAt, undefined);
  assertEquals(h.adapter.placed.length, 0);
  h.advance(MIN);
  await h.approve(id);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "placed");
});

Deno.test("joy: published record hides the vendor too", async () => {
  const h = harness();
  await h.orch.submit(req({ budget: "joy" }));
  assertEquals(h.relay.published[0].vendor, "sealed");
});

Deno.test("place error = outcome unknown: STOP, still counted; resolveUnknown settles it", async () => {
  const h = harness();
  h.adapter.place = () => Promise.reject(new Error("timeout"));
  const row = await h.orch.submit(req());
  h.advance(11 * MIN);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "outcome_unknown");
  assert(h.ledger.stopped);
  // still counts against the day window
  assertEquals(h.ledger.windowsFor("fakeshop", "general", h.clock.now())["global/day"].spentCents, 2300);
  const done = await h.orch.resolveUnknown(row.id, "placed", { vendorOrderId: "v-9", chargedCents: 2300 });
  assertEquals([done.state, done.vendorOrderId], ["placed", "v-9"]);
});

Deno.test("a guard refusal (nothing sent to the vendor) is a plain failure, not outcome_unknown", async () => {
  const h = harness();
  h.adapter.place = () => Promise.reject(new GuardRefused("vendor_paused"));
  const row = await h.orch.submit(req());
  h.advance(11 * MIN);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "failed");
  assertEquals(h.ledger.stopped, false);
});

Deno.test("control characters in agent text are rejected at intake", async () => {
  const h = harness();
  await assertRejects(() => h.orch.submit(req({ reason: "ok\u0007bell" })));
  await assertRejects(() => h.orch.submit(req({ items: [{ sku: "a", qty: 1, url: "http://169.254.169.254/" }] })));
});

// ── Silent tier, sealed approvals, the reveal ([notify] defaults) ───────────
const ITEM = { sku: "B0SCOPE60", qty: 1, title: "Brass Telescope", url: "https://shop.example/brass-telescope-60" };
/** No title word, URL or SKU of ITEM, anywhere in `s` (links masked: random ids could collide). */
function revealsNothing(s: string): boolean {
  const t = s.replace(/<https:\/\/approve\.example\.test\/a\/[^>]+>/g, "<link>").toLowerCase();
  return !["brass", "telescope", "shop.example", "b0scope60"].some((w) => t.includes(w));
}
const silentHarness = () => harness(NOON, undefined, DEFAULT_NOTICE);

Deno.test("silent: $39.99 self → placed with zero DMs; delivered → why-note DM → closed", async () => {
  const h = silentHarness();
  h.adapter.price = 3999;
  const row = await h.orch.submit(req({ items: [ITEM], whyNote: "you keep squinting at Saturn from the roof" }));
  assertEquals([row.state, row.silent, row.tier, row.decision], ["approved", true, "auto", "auto"]);
  assertEquals(h.notifier.messages.length, 0);
  assertEquals(h.relay.published.length, 0, "no approval record, no relay page");
  // it counts in the windows straight away
  assertEquals(h.ledger.windowsFor("fakeshop", "general", h.clock.now())["global/day"].spentCents, 3999);
  await h.orch.tick();
  const placed = h.ledger.getRequest(row.id)!;
  assertEquals([placed.state, placed.finalCents], ["placed", 3999]);
  assertEquals(h.adapter.placed[0].hardCap, 3999);
  assertEquals(h.notifier.messages.length, 0, "still nothing before delivery");
  h.adapter.statusState = "delivered";
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "closed");
  assertEquals(h.notifier.messages.length, 1);
  const reveal = h.notifier.messages[0];
  assert(reveal.includes("Brass Telescope") && reveal.includes("squinting at Saturn"), reveal);
  assert(reveal.includes("link: <https://shop.example/brass-telescope-60>"), reveal);
});

Deno.test("silent: $40.00 is not silent → a pre-order veto DM (auto tier stays open)", async () => {
  const h = silentHarness();
  h.adapter.price = 4000;
  const row = await h.orch.submit(req({ items: [ITEM] }));
  assertEquals([row.state, row.silent ?? false], ["dm_delivered", false]);
  assertEquals(h.notifier.messages.length, 1);
  assert(h.notifier.messages[0].includes("unless you veto"));
  assertEquals(tokensFrom(h.notifier.messages[0]).length, 1);
});

Deno.test("silent: $5 reach others → ask, with full item, recipient and reason (never sealed)", async () => {
  const h = silentHarness();
  h.adapter.price = 500;
  const row = await h.orch.submit(req({
    items: [ITEM], hint: "for stargazing",
    shipTo: { name: "Jane Doe", line1: "1 Main St", city: "Springfield", state: "IL", zip: "62701" },
  }));
  assertEquals([row.state, row.decision, row.reachEffective, row.silent, row.sealed], ["pending_approval", "ask", "others", false, false]);
  const dm = h.notifier.messages[0];
  assert(dm.includes("Brass Telescope") && dm.includes("ship to: Jane Doe, Springfield IL") && dm.includes("why: needed for the build"), dm);
  assert(h.relay.published[0].summary.includes("Brass Telescope"));
  assertEquals(h.relay.published[0].vendor, "fakeshop");
});

Deno.test("sealed: the ask DM and relay summary never contain the title, URL or SKU", async () => {
  const h = silentHarness();
  h.adapter.price = 8000;
  const row = await h.orch.submit(req({ items: [ITEM], hint: "for looking up at night" }));
  assertEquals([row.state, row.sealed], ["pending_approval", true]);
  const dm = h.notifier.messages[0];
  assert(revealsNothing(dm), dm);
  assert(!dm.includes("needed for the build"), "the reason names the item too, so it stays out");
  assert(dm.includes("$80.00") && dm.includes("hint: for looking up at night"), dm);
  assert(dm.includes("if approved: $20.00 left today, $170.00 this month"), dm);
  assertEquals(tokensFrom(dm).length, 2, "approve + deny links");
  const rec = h.relay.published[0];
  assert(revealsNothing(rec.summary), rec.summary);
  assertEquals(rec.vendor, "sealed");
  // approved, placed, delivered → the reveal
  await h.approve(rec.approvalId);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "placed");
  h.adapter.statusState = "delivered";
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "closed");
  assert(h.notifier.messages.at(-1)!.includes("Brass Telescope"));
});

Deno.test("sealed: no hint → \"something for you\"; [notify] sealed = false shows the item", async () => {
  const h = silentHarness();
  h.adapter.price = 8000;
  await h.orch.submit(req({ items: [ITEM] }));
  assert(h.notifier.messages[0].includes("hint: something for you"));
  const open = harness(NOON, undefined, { ...DEFAULT_NOTICE, sealed: false });
  open.adapter.price = 8000;
  const row = await open.orch.submit(req({ items: [ITEM] }));
  assertEquals(row.sealed, false);
  assert(open.notifier.messages[0].includes("Brass Telescope"));
});

Deno.test("sealed: a fund_auto veto DM never names the item", async () => {
  const h = silentHarness();
  h.adapter.price = 60_000;
  h.ledger.addFundEntry({ kind: "topup", cents: 100_000 }, h.clock.now());
  const row = await h.orch.submit(req({ items: [ITEM], maxTotalCents: 70_000, hint: "a big shiny thing" }));
  assertEquals([row.state, row.tier, row.sealed], ["dm_delivered", "fund_auto", true]);
  const dm = h.notifier.messages[0];
  assert(revealsNothing(dm) && revealsNothing(h.relay.published[0].summary), dm);
  assert(dm.includes("robot fund pays $600.00") && dm.includes("fund after: $400.00") && dm.includes("left today"), dm);
});

Deno.test("joy $25 is silent: no veto DM, placed, then the reveal", async () => {
  const h = silentHarness();
  h.adapter.price = 2500;
  const row = await h.orch.submit(req({ budget: "joy", items: [ITEM], whyNote: "you mentioned Saturn twice this week" }));
  assertEquals([row.state, row.silent], ["approved", true]);
  assertEquals(h.notifier.messages.length, 0);
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "placed");
  h.adapter.statusState = "delivered";
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.state, "closed");
  assert(h.notifier.messages[0].startsWith("your robot's surprise arrived: 1× Brass Telescope"));
});

Deno.test("joy $55 keeps the sealed veto DM (joy/week raised so it fits)", async () => {
  const h = silentHarness();
  h.ledger.budgets["joy/week"] = 10_000;
  h.adapter.price = 5500;
  const row = await h.orch.submit(req({ budget: "joy", items: [ITEM], hint: "for clear nights" }));
  assertEquals([row.state, row.silent, row.sealed], ["dm_delivered", false, true]);
  const dm = h.notifier.messages[0];
  assert(revealsNothing(dm) && dm.includes("$55.00") && dm.includes("hint: for clear nights"), dm);
  assertEquals(tokensFrom(dm).length, 1, "deny-only veto link");
  assert(revealsNothing(h.relay.published[0].summary));
});

Deno.test("delivered → closed is blocked until the why-note DM is delivered; other rows still move", async () => {
  const h = silentHarness();
  h.adapter.price = 1000;
  const row = await h.orch.submit(req({ items: [ITEM] }));
  await h.orch.tick();
  h.adapter.statusState = "delivered";
  h.notifier.fail = true; // DM path down
  await h.orch.tick();
  let cur = h.ledger.getRequest(row.id)!;
  assertEquals([cur.state, cur.dmLastError], ["delivered", "fake_down"]);
  // the closed transition itself refuses without a delivered why-note
  assertThrows(() => contractStateGuard.assertTransition("delivered", "closed", { stopped: false, silent: true }), IllegalTransition);
  // another silent purchase still goes through while the reveal waits
  h.adapter.statusState = "open";
  const other = await h.orch.submit(req({ items: [{ sku: "X", qty: 1, title: "Other" }] }));
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(other.id)!.state, "placed");
  assertEquals(h.ledger.getRequest(row.id)!.state, "delivered");
  h.notifier.fail = false;
  h.adapter.statusState = "delivered";
  await h.orch.tick();
  cur = h.ledger.getRequest(row.id)!;
  assertEquals(cur.state, "closed");
  assertEquals(h.notifier.messages.length, 2, "one reveal per purchase");
});

Deno.test("silent rows keep caps, velocity and STOP; a changed re-quote is denied", async () => {
  const h = silentHarness();
  h.adapter.price = 3900;
  const a = await h.orch.submit(req());
  const b = await h.orch.submit(req());
  const c = await h.orch.submit(req()); // 3 × $39 > $100/day
  assertEquals([a.state, b.state, c.state], ["approved", "approved", "denied"]);
  assert(c.reasons!.includes("window:global/day"));
  h.adapter.price = 3950; // the vendor's price moved after the decision
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(a.id)!.reasons!.includes("quote_changed"), true);
  assertEquals(h.adapter.placed.length, 0);
  await h.orch.stop("test");
  await assertRejects(() => h.orch.submit(req()), StopActive);
});

// ── item fields, delivery links, needs-action ─────────────────────────────
Deno.test("intake keeps the print/geo item fields (bounded) and refuses bad ones", async () => {
  const h = silentHarness();
  h.adapter.price = 1000;
  const item = {
    sku: "SKU-P", qty: 1, title: "Postcard", message: "hello from the robot\nsecond line",
    files: { interior: "https://files.example/i.pdf", cover: "https://files.example/c.pdf" }, pageCount: 24,
    sizing: "fillPrintArea", attributes: { color: "black" }, aoi: "POLYGON((0 0,1 0,1 1,0 0))",
  };
  const row = await h.orch.submit(req({ items: [item] }));
  assertEquals(row.items[0], item);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ message: "x".repeat(501) }, /item\.message/],
    [{ message: "" }, /item\.message/],
    [{ files: { interior: "http://files.example/i.pdf" } }, /item\.files\.interior must be https/],
    [{ files: { cover: "https://files.example/c.pdf", extra: "https://x.example" } }, /only interior, cover/],
    [{ files: "https://files.example/i.pdf" }, /item\.files invalid/],
    [{ pageCount: 0 }, /item\.pageCount/],
    [{ pageCount: 1201 }, /item\.pageCount/],
    [{ pageCount: 1.5 }, /item\.pageCount/],
    [{ sizing: "fill print area" }, /item\.sizing/],
    [{ attributes: { "bad key": "x" } }, /item\.attributes/],
    [{ attributes: { color: 3 } }, /item\.attributes/],
    [{ attributes: Object.fromEntries(Array.from({ length: 21 }, (_, k) => [`k${k}`, "v"])) }, /item\.attributes/],
    [{ aoi: "P".repeat(10_001) }, /item\.aoi/],
  ];
  for (const [over, re] of bad) {
    const e = await assertRejects(() => h.orch.submit(req({ items: [{ sku: "SKU-P", qty: 1, ...over }] })));
    assert(re.test((e as Error).message), `${JSON.stringify(over).slice(0, 60)} → ${(e as Error).message}`);
  }
});

Deno.test("a postcard message is shown in unsealed DMs, never in sealed ones", async () => {
  const h = harness();
  await h.orch.submit(req({ items: [{ sku: "SKU-1", qty: 1, title: "Postcard", message: "Happy birthday, Jane!" }] }));
  assert(h.notifier.messages[0].includes(`printed message: "Happy birthday, Jane!"`), h.notifier.messages[0]);
  const s = harness(NOON, undefined, { silentBelowCents: 0, sealed: true });
  s.adapter.price = 9000; // ask tier, reach self → sealed
  await s.orch.submit(req({ items: [{ sku: "SKU-1", qty: 1, title: "Postcard", message: "Happy birthday, Jane!" }] }));
  assert(!s.notifier.messages[0].includes("Happy birthday"), s.notifier.messages[0]);
});

Deno.test("delivery links: persisted from place() and status(), sanitized; the reveal DMs at most 3", async () => {
  const h = silentHarness();
  h.adapter.price = 1000;
  h.adapter.place = (_r, q) =>
    Promise.resolve({
      vendorOrderId: "ord-L",
      chargedCents: q.totalCents,
      raw: {
        links: [
          "https://certs.example/tree/1",
          "https://api.vendor.example/download?apiKey=SECRETKEY1234&id=1", // key in the URL: dropped
          "http://plain.example/insecure", // not https: dropped
          "https://user:pw@certs.example/x", // userinfo: dropped
          "https://certs.example/tree/1", // duplicate
          "https://dl.example/file?TOKEN=abc", // case-insensitive token param: dropped
        ],
      },
    });
  const row = await h.orch.submit(req({ items: [ITEM], whyNote: "you keep squinting at Saturn from the roof" }));
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.links, ["https://certs.example/tree/1"]);
  // A status poll adds more; the row keeps at most 5, the reveal shows at most 3.
  h.adapter.status = () =>
    Promise.resolve({
      state: "delivered" as const,
      raw: { links: ["https://dl.example/a", "https://dl.example/b", "https://dl.example/c", "https://dl.example/d", "nope"] },
    });
  await h.orch.tick();
  const done = h.ledger.getRequest(row.id)!;
  assertEquals(done.state, "closed");
  assertEquals(done.links, [
    "https://certs.example/tree/1",
    "https://dl.example/a",
    "https://dl.example/b",
    "https://dl.example/c",
    "https://dl.example/d",
  ]);
  const reveal = h.notifier.messages.at(-1)!;
  assertEquals([...reveal.matchAll(/^delivery: <https:\/\/[^\s<>]+>$/gm)].length, 3, reveal);
  assert(reveal.includes("delivery: <https://certs.example/tree/1>"), reveal);
  assert(!/SECRETKEY|apiKey|token=|insecure|user:pw/i.test(reveal), reveal);
  assert(!h.ledger.writes.some((w) => w.includes("SECRETKEY")), "a keyed link is never stored");
});

Deno.test("needs action: a vendor-side block → ONE owner DM (label + hint), retried only if the send fails", async () => {
  const h = silentHarness();
  h.adapter.price = 1000;
  h.adapter.place = (_r, q) =>
    Promise.resolve({
      vendorOrderId: "ord-B",
      chargedCents: q.totalCents,
      raw: { blocked: "RequiresPaymentAuthorisation", authorisationUrl: "https://pay.vendor.example/auth?token=SECRET" },
    });
  h.adapter.status = () =>
    Promise.resolve({ state: "open" as const, raw: { blocked: "RequiresPaymentAuthorisation", authorisationUrl: "https://x?token=SECRET" } });
  const row = await h.orch.submit(req());
  h.notifier.fail = true;
  await h.orch.tick();
  let cur = h.ledger.getRequest(row.id)!;
  assertEquals([cur.state, cur.needsAction, cur.needsActionDmAt], ["placed", "RequiresPaymentAuthorisation", undefined]);
  assertEquals(h.ledger.isStopped(), false, "a blocked order is not outcome_unknown and never trips STOP");
  h.notifier.fail = false;
  await h.orch.tick();
  await h.orch.tick();
  await h.orch.tick();
  assertEquals(h.notifier.messages.length, 1, "exactly one DM per request");
  const dm = h.notifier.messages[0];
  assert(dm.startsWith("fakeshop order needs you: "), dm);
  assert(!/SECRET|https?:/.test(dm), "the vendor's action URL never reaches the DM");
  cur = h.ledger.getRequest(row.id)!;
  assert(cur.needsActionDmAt);
  // The block clears; a later block on the same request does not DM again.
  h.adapter.status = () => Promise.resolve({ state: "open" as const, raw: {} });
  await h.orch.tick();
  assertEquals(h.ledger.getRequest(row.id)!.needsAction, undefined);
  h.adapter.status = () => Promise.resolve({ state: "open" as const, raw: { blocked: "RequiresPaymentAuthorisation" } });
  await h.orch.tick();
  assertEquals(h.notifier.messages.length, 1);
});
