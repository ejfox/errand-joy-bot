import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import {
  addEntry,
  fundBalance,
  hold,
  outstandingHold,
  release,
} from "./fund.ts";
import { createRequest } from "./ledger.ts";

async function tmpDb() {
  return openDb(
    await Deno.makeTempFile({ dir: "/tmp", prefix: "pg-fund-", suffix: ".db" }),
  );
}

Deno.test("balance is SUM of entries", async () => {
  const db = await tmpDb();
  assert.equal(fundBalance(db), 0);
  addEntry(db, { cents: 50_000, kind: "topup", source: "admin" });
  addEntry(db, {
    cents: 1_234,
    kind: "income",
    source: "sponsor",
    ref: "inv-1",
  });
  addEntry(db, { cents: -2_000, kind: "spend", source: "gate" });
  addEntry(db, { cents: 500, kind: "refund", source: "reconcile" });
  assert.equal(fundBalance(db), 49_734);
});

Deno.test("sign convention is enforced", async () => {
  const db = await tmpDb();
  assert.throws(() => addEntry(db, { cents: -1, kind: "topup", source: "admin" }));
  assert.throws(() => addEntry(db, { cents: 1, kind: "hold", source: "gate" }));
  assert.throws(() =>
    addEntry(db, { cents: 1, kind: "spend", source: "gate" })
  );
  assert.throws(() => addEntry(db, { cents: 0, kind: "income", source: "x" }));
  assert.throws(() =>
    addEntry(db, { cents: 1.5, kind: "income", source: "x" })
  );
  // CHECK constraint backs it up even if someone bypasses addEntry
  assert.throws(() =>
    db.prepare(
      "INSERT INTO fund_entries (cents, kind, source, at) VALUES (5, 'hold', 'x', 'now')",
    )
      .run()
  );
  assert.equal(fundBalance(db), 0);
});

Deno.test("hold/release round-trips to the starting balance", async () => {
  const db = await tmpDb();
  const r = createRequest(db, {
    idempotencyKey: "f1",
    requester: "a",
    taskId: "t",
    vendor: "mouser",
    items: [{ sku: "x", qty: 1 }],
    reason: "r",
    reach: "self",
    maxTotalCents: 80_000,
  }, "h");
  hold(db, r.id, 75_000);
  assert.equal(fundBalance(db), -75_000);
  assert.equal(outstandingHold(db, r.id), 75_000);
  assert.equal(release(db, r.id), 75_000);
  assert.equal(fundBalance(db), 0);
  assert.equal(outstandingHold(db, r.id), 0);
  assert.equal(release(db, r.id), 0, "second release is a no-op");
  assert.equal(fundBalance(db), 0);

  addEntry(db, { cents: 100_000, kind: "topup", source: "admin" });
  hold(db, r.id, 75_000);
  release(db, r.id);
  addEntry(db, {
    cents: -74_100,
    kind: "spend",
    source: "gate",
    requestId: r.id,
  });
  assert.equal(fundBalance(db), 25_900);

  // re-decide before placing must not be blocked by the request's own hold
  addEntry(db, { cents: 54_100, kind: "topup", source: "admin" }); // 80_000
  hold(db, r.id, 60_000);
  assert.equal(fundBalance(db), 20_000);
  assert.equal(fundBalance(db, { excludeHoldFor: r.id }), 80_000);
  assert.equal(fundBalance(db, { excludeHoldFor: "other" }), 20_000);
});
