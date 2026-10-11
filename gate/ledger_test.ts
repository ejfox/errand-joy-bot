import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import {
  consumeApproval,
  createRequest,
  getRequest,
  getRequestExtras,
  hashPayload,
  insertApproval,
  isStopped,
  listEvents,
  listRequests,
  recordDecision,
  recordQuote,
  recordRating,
  requestsSince,
  setStop,
  transition,
} from "./ledger.ts";
import { IdempotencyConflict, type PurchaseRequest } from "./types.ts";

async function tmpDb() {
  const path = await Deno.makeTempFile({
    dir: "/tmp",
    prefix: "pg-ledger-",
    suffix: ".db",
  });
  return { db: openDb(path), path };
}

function req(
  key: string,
  over: Partial<PurchaseRequest> = {},
): PurchaseRequest {
  return {
    idempotencyKey: key,
    requester: "test-agent",
    taskId: "t1",
    vendor: "mouser",
    items: [{ sku: "ABC-1", qty: 2 }],
    reason: "testing",
    reach: "self",
    maxTotalCents: 3000,
    ...over,
  };
}

Deno.test("openDb is idempotent and seeds budgets", async () => {
  const { db, path } = await tmpDb();
  db.close();
  const db2 = openDb(path);
  const n = db2.prepare("SELECT COUNT(*) AS n FROM budgets").get() as {
    n: number;
  };
  assert.equal(Number(n.n), 3);
  db2.close();
});

Deno.test("idempotent replay returns the same row", async () => {
  const { db } = await tmpDb();
  const r = req("k1", { category: "parts", shipTo: "owner-home" });
  const h = await hashPayload(r);
  const a = createRequest(db, r, h);
  const b = createRequest(db, r, h);
  assert.equal(a.id, b.id);
  assert.equal(a.state, "received");
  assert.deepEqual(a.items, r.items);
  assert.equal(a.budget, "general");
  assert.deepEqual(getRequestExtras(db, a.id), {
    category: "parts",
    shipTo: "owner-home",
  });
  // RequestRow now carries them directly too
  assert.equal(a.category, "parts");
  assert.equal(a.shipTo, "owner-home");
  assert.equal(listRequests(db).length, 1);
  assert.equal(listEvents(db, a.id).length, 1);
});

Deno.test("hashPayload is key-order independent", async () => {
  const a = await hashPayload(req("k"));
  const r = req("k");
  const reordered = Object.fromEntries(
    Object.entries(r).reverse(),
  ) as unknown as PurchaseRequest;
  assert.equal(await hashPayload(reordered), a);
  assert.notEqual(await hashPayload(req("k", { maxTotalCents: 3001 })), a);
});

Deno.test("same key, different hash throws IdempotencyConflict", async () => {
  const { db } = await tmpDb();
  createRequest(db, req("k2"), "hash-a");
  assert.throws(
    () => createRequest(db, req("k2"), "hash-b"),
    IdempotencyConflict,
  );
  assert.equal(listRequests(db).length, 1);
});

Deno.test("each transition writes an event; patch and updated_at apply", async () => {
  const { db } = await tmpDb();
  const t0 = new Date("2026-10-11T12:00:00.000Z");
  const r = createRequest(db, req("k3"), "h", t0);
  recordQuote(db, r.id, {
    subtotalCents: 2000,
    taxCents: 160,
    shippingCents: 500,
    totalCents: 2660,
    currency: "USD",
    vendorRef: "Q-1",
    quotedAt: t0.toISOString(),
    raw: { a: 1 },
  }, t0);
  const t1 = new Date("2026-10-11T12:01:00.000Z");
  transition(db, r.id, "quoted", "quote ok", {}, t1);
  recordDecision(db, r.id, {
    decision: "auto",
    tier: "auto",
    effectiveReach: "self",
    reasons: ["under_auto"],
  });
  const t2 = new Date("2026-10-11T12:02:00.000Z");
  const d = transition(db, r.id, "decided", "policy", { dmAttempts: 0 }, t2);
  const p = transition(
    db,
    r.id,
    "dm_pending",
    "queue dm",
    { dmLastError: "x" },
    t2,
  );
  const ev = listEvents(db, r.id);
  assert.deepEqual(ev.map((e) => [e.fromState, e.toState]), [
    [undefined, "received"],
    ["received", "quoted"],
    ["quoted", "decided"],
    ["decided", "dm_pending"],
  ]);
  assert.equal(d.updatedAt, t2.toISOString());
  assert.equal(p.quote?.totalCents, 2660);
  assert.deepEqual(p.quote?.raw, { a: 1 });
  assert.equal(p.tier, "auto");
  assert.deepEqual(p.reasons, ["under_auto"]);
  assert.equal(p.reachEffective, "self");
  assert.equal(p.dmLastError, "x");
  // patch to undefined clears
  const c = transition(db, r.id, "dm_delivered", "sent", {
    dmLastError: undefined,
    dmMessageId: "m1",
  });
  assert.equal(c.dmLastError, undefined);
  assert.equal(c.dmMessageId, "m1");
  recordRating(db, r.id, 4);
  assert.equal(getRequest(db, r.id)?.rating, 4);
  assert.equal(listRequests(db, { state: "dm_delivered" }).length, 1);
  assert.equal(listRequests(db, { state: "placed" }).length, 0);
});

Deno.test("transition rolls back the update when the event insert fails", async () => {
  const { db } = await tmpDb();
  const r = createRequest(db, req("k4"), "h");
  // invalid state violates CHECK → whole transition rolls back
  // deno-lint-ignore no-explicit-any
  assert.throws(() => transition(db, r.id, "bogus" as any, "bad"));
  assert.equal(getRequest(db, r.id)?.state, "received");
  assert.equal(listEvents(db, r.id).length, 1);
});

Deno.test("requestsSince counts all states", async () => {
  const { db } = await tmpDb();
  createRequest(db, req("a"), "h", new Date("2026-10-11T12:00:00Z"));
  const b = createRequest(db, req("b"), "h", new Date("2026-10-11T12:05:00Z"));
  transition(db, b.id, "denied", "x");
  createRequest(db, req("c"), "h", new Date("2026-10-11T12:09:00Z"));
  assert.equal(requestsSince(db, "2026-10-11T12:01:00.000Z"), 2);
  assert.equal(
    listRequests(db, { since: "2026-10-11T12:01:00.000Z" }).length,
    2,
  );
});

Deno.test("consumeApproval is single-use and honors expiry", async () => {
  const { db } = await tmpDb();
  const r = createRequest(db, req("k5"), "h");
  const base = {
    requestId: r.id,
    vendor: "mouser",
    boundCents: 9000,
    kind: "approve" as const,
    summary: "buy a thing",
  };
  insertApproval(db, {
    ...base,
    approvalId: "ap1",
    denyTokenHash: "aa",
    approveTokenHash: "aa2",
    expiresAt: "2026-10-12T00:00:00.000Z",
  });
  insertApproval(db, {
    ...base,
    approvalId: "ap2",
    denyTokenHash: "bb",
    approveTokenHash: "bb2",
    expiresAt: "2026-10-10T00:00:00.000Z",
  });
  const now = new Date("2026-10-11T12:00:00Z");
  assert.equal(consumeApproval(db, "ap1", "approve", now), true);
  assert.equal(consumeApproval(db, "ap1", "deny", now), false);
  assert.equal(consumeApproval(db, "ap2", "approve", now), false, "expired");
  assert.equal(consumeApproval(db, "nope", "approve", now), false, "unknown");
  const row = db.prepare(
    "SELECT verdict FROM approvals WHERE approval_id='ap1'",
  ).get() as {
    verdict: string;
  };
  assert.equal(row.verdict, "approve");
});

Deno.test("STOP via settings or file", async () => {
  const { db } = await tmpDb();
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "pg-data-" });
  assert.equal(isStopped(db, dir), false);
  setStop(db, true);
  assert.equal(isStopped(db, dir), true);
  setStop(db, false);
  assert.equal(isStopped(db, dir), false);
  await Deno.writeTextFile(`${dir}/STOP`, "");
  assert.equal(isStopped(db, dir), true);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("1000 inserts in under 2s", async () => {
  const { db } = await tmpDb();
  const t = performance.now();
  for (let i = 0; i < 1000; i++) createRequest(db, req(`bulk-${i}`), "h");
  const ms = performance.now() - t;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)}ms`);
  assert.equal(requestsSince(db, "1970-01-01T00:00:00.000Z"), 1000);
});
