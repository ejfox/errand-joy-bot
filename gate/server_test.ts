import { assert, assertEquals, assertThrows } from "@std/assert";
import type { PurchaseRequest, Quote, VendorAdapter } from "./types.ts";
import { contractPolicy, contractStateGuard, MemoryLedger, Orchestrator } from "./orchestrator.ts";
import { FakeHealthAlerter, FakeNotifier } from "./notify.ts";
import { FakeRelayClient } from "./relay_client.ts";
import { createApp } from "./server.ts";

const AGENT = "agent-token-0123456789abcdef0123456789";
const ADMIN = "admin-token-0123456789abcdef0123456789";
const NOON = Date.parse("2026-10-12T16:00:00Z");

function setup(tokens: { agent?: string; admin?: string } = {}) {
  const clock = { now: () => new Date(NOON) };
  const ledger = new MemoryLedger(clock);
  const notifier = new FakeNotifier();
  const adapter: VendorAdapter = {
    id: "fakeshop",
    maxReach: "world",
    reachFor: () => "self",
    quote: (_r: PurchaseRequest): Promise<Quote> =>
      Promise.resolve({ subtotalCents: 2300, taxCents: 0, shippingCents: 0, totalCents: 2300, currency: "USD", quotedAt: clock.now().toISOString() }),
    place: () => Promise.resolve({ vendorOrderId: "o1", chargedCents: 2300 }),
    status: () => Promise.resolve({ state: "open" as const }),
    cancel: () => Promise.resolve(true),
    listCharges: () => Promise.resolve([]),
    pause: () => Promise.resolve(),
  };
  const orch = new Orchestrator({
    ledger, policy: contractPolicy, state: contractStateGuard, adapters: { fakeshop: adapter }, notifier,
    relay: new FakeRelayClient(), clock, alerter: new FakeHealthAlerter(clock.now),
    relayPublicUrl: "https://approve.example.test", quietHours: { start: 0, end: 0, tz: "UTC", off: true },
  });
  const app = createApp({
    orch, ledger, agentToken: tokens.agent ?? AGENT, adminToken: tokens.admin ?? ADMIN, now: clock.now,
  });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
  return { app, ledger, notifier, call };
}

const goodReq = {
  idempotencyKey: "k-1", requester: "scout", taskId: "t", vendor: "fakeshop",
  items: [{ sku: "S", qty: 1, title: "thing" }], reason: "because the test needs a thing and this reason must be at least sixty characters", reach: "self", maxTotalCents: 5000,
};

Deno.test("missing or wrong bearer → 401 everywhere; tokens are not interchangeable", async () => {
  const { call } = setup();
  const routes: [string, string][] = [
    ["POST", "/api/requests"], ["GET", "/api/requests/x"], ["GET", "/api/requests?state=placed"],
    ["POST", "/api/requests/x/cancel"], ["GET", "/api/budgets"], ["GET", "/api/fund"],
    ["POST", "/internal/tick"], ["POST", "/internal/reconcile"], ["POST", "/internal/fund/entries"],
    ["POST", "/internal/stop"], ["DELETE", "/internal/stop"], ["POST", "/internal/rate/x"],
  ];
  for (const [m, p] of routes) {
    assertEquals((await call(m, p)).status, 401, `${m} ${p} no token`);
    assertEquals((await call(m, p, "wrong")).status, 401, `${m} ${p} wrong token`);
    const other = p.startsWith("/api") ? ADMIN : AGENT;
    assertEquals((await call(m, p, other)).status, 401, `${m} ${p} other token`);
  }
  const raw = await setup().app.request("/api/fund", { headers: { Authorization: `Basic ${AGENT}` } });
  assertEquals(raw.status, 401);
});

Deno.test("unset tokens refuse everything (never match empty)", async () => {
  const { call } = setup({ agent: "", admin: "" });
  assertEquals((await call("GET", "/api/fund", "")).status, 401);
  assertEquals((await call("POST", "/internal/tick", "")).status, 401);
  assertEquals((await call("GET", "/api/fund", "short")).status, 401);
});

Deno.test("createApp refuses identical agent/admin tokens", () => {
  assertThrows(() => setup({ agent: AGENT, admin: AGENT }));
});

Deno.test("/health returns exactly {ok, stopped}", async () => {
  const { call } = setup();
  await call("POST", "/api/requests", AGENT, goodReq);
  const res = await call("GET", "/health");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(Object.keys(body).sort(), ["ok", "stopped"]);
  assertEquals(body, { ok: true, stopped: false });
  await call("POST", "/internal/stop", ADMIN, { reason: "test" });
  assertEquals(await (await call("GET", "/health")).json(), { ok: true, stopped: true });
});

Deno.test("agent flow: submit, read, list, budgets, fund; validation errors are 400", async () => {
  const { call, notifier } = setup();
  const res = await call("POST", "/api/requests", AGENT, goodReq);
  assertEquals(res.status, 201);
  const row = await res.json();
  assertEquals(row.state, "dm_delivered");
  assertEquals(notifier.messages.length, 1);
  assertEquals((await (await call("GET", `/api/requests/${row.id}`, AGENT)).json()).id, row.id);
  assertEquals((await (await call("GET", "/api/requests?state=dm_delivered", AGENT)).json()).length, 1);
  assertEquals((await call("GET", "/api/requests", AGENT)).status, 400);
  const budgets = await (await call("GET", "/api/budgets", AGENT)).json();
  assert("global/day" in budgets);
  assertEquals(await (await call("GET", "/api/fund", AGENT)).json(), { balanceCents: 0 });
  assertEquals((await call("POST", "/api/requests", AGENT, "{nope")).status, 400);
  assertEquals((await call("POST", "/api/requests", AGENT, { ...goodReq, idempotencyKey: "k2", vendor: "nope" })).status, 400);
  assertEquals((await call("POST", "/api/requests", AGENT, { ...goodReq, idempotencyKey: "k3", maxTotalCents: -1 })).status, 400);
  assertEquals((await call("GET", "/api/requests/does-not-exist", AGENT)).status, 404);
  const cancel = await call("POST", `/api/requests/${row.id}/cancel`, AGENT);
  assertEquals((await cancel.json()).state, "cancelled");
});

Deno.test("admin: tick, fund entries, stop/clear, reconcile unconfigured", async () => {
  const { call } = setup();
  assertEquals((await call("POST", "/internal/tick", ADMIN)).status, 200);
  assertEquals((await call("POST", "/internal/fund/entries", ADMIN, { kind: "topup", cents: 5000 })).status, 201);
  assertEquals((await call("POST", "/internal/fund/entries", ADMIN, { kind: "spend", cents: 5000 })).status, 400);
  assertEquals((await call("POST", "/internal/fund/entries", ADMIN, { kind: "topup", cents: 1.5 })).status, 400);
  assertEquals((await call("POST", "/internal/reconcile", ADMIN)).status, 501);
  assertEquals((await call("POST", "/internal/stop", ADMIN)).status, 200);
  assertEquals((await call("POST", "/api/requests", AGENT, goodReq)).status, 503);
  assertEquals((await call("DELETE", "/internal/stop", ADMIN)).status, 200);
  assertEquals((await call("POST", "/api/requests", AGENT, goodReq)).status, 201);
});

Deno.test("oversized bodies are refused", async () => {
  const { call } = setup();
  const res = await call("POST", "/api/requests", AGENT, { ...goodReq, reason: "x".repeat(40_000) });
  assertEquals(res.status, 413);
});
