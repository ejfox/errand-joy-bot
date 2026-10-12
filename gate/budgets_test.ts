import assert from "node:assert/strict";
import { type Db, openDb } from "./db.ts";
import {
  listBudgets,
  upsertBudget,
  windowBounds,
  windowUsage,
} from "./budgets.ts";
import { createRequest, transition } from "./ledger.ts";
import type { State, Tier } from "./types.ts";

async function tmpDb() {
  return openDb(
    await Deno.makeTempFile({
      dir: "/tmp",
      prefix: "pg-budget-",
      suffix: ".db",
    }),
  );
}

let seq = 0;
function mk(
  db: Db,
  at: string,
  state: State,
  cents: number,
  o: { tier?: Tier; vendor?: string; joy?: boolean; finalCents?: number } = {},
) {
  const r = createRequest(
    db,
    {
      idempotencyKey: `b-${++seq}`,
      requester: "a",
      taskId: "t",
      vendor: o.vendor ?? "mouser",
      items: [{ sku: "x", qty: 1 }],
      reason: "r",
      reach: "self",
      maxTotalCents: cents,
      budget: o.joy ? "joy" : "general",
    },
    "h",
    new Date(at),
  );
  transition(db, r.id, state, "test", {
    tier: o.tier ?? "auto",
    finalCents: o.finalCents,
    quote: {
      subtotalCents: cents,
      taxCents: 0,
      shippingCents: 0,
      totalCents: cents,
      currency: "USD",
      quotedAt: at,
    },
  });
  return r.id;
}

const iso = (d: Date) => d.toISOString();

Deno.test("day bounds are ET midnight (EDT and EST)", () => {
  const b = windowBounds(new Date("2026-10-11T03:59:59.999Z"), "day"); // Oct 10 23:59 EDT
  assert.equal(iso(b.start), "2026-10-10T04:00:00.000Z");
  assert.equal(iso(b.end), "2026-10-11T04:00:00.000Z");
  const w = windowBounds(new Date("2026-12-15T05:00:00.000Z"), "day"); // Dec 15 00:00 EST
  assert.equal(iso(w.start), "2026-12-15T05:00:00.000Z");
  assert.equal(iso(w.end), "2026-12-16T05:00:00.000Z");
  // DST change days are 23h / 25h long
  const spring = windowBounds(new Date("2026-03-08T12:00:00Z"), "day");
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23 * 3600_000);
  const fall = windowBounds(new Date("2026-11-01T12:00:00Z"), "day");
  assert.equal(fall.end.getTime() - fall.start.getTime(), 25 * 3600_000);
});

Deno.test("ISO week bounds across DST", () => {
  const spring = windowBounds(new Date("2026-03-08T15:00:00Z"), "week"); // Sunday
  assert.equal(iso(spring.start), "2026-03-02T05:00:00.000Z");
  assert.equal(iso(spring.end), "2026-03-09T04:00:00.000Z");
  const fall = windowBounds(new Date("2026-10-26T04:00:00Z"), "week"); // Mon 00:00 EDT
  assert.equal(iso(fall.start), "2026-10-26T04:00:00.000Z");
  assert.equal(iso(fall.end), "2026-11-02T05:00:00.000Z");
  // Sunday 23:59 ET belongs to the week that started the previous Monday
  const sun = windowBounds(new Date("2026-10-12T03:59:00Z"), "week"); // Sun Oct 11 23:59 EDT
  assert.equal(iso(sun.start), "2026-10-05T04:00:00.000Z");
});

Deno.test("month bounds incl. year rollover", () => {
  const m = windowBounds(new Date("2026-03-15T12:00:00Z"), "month");
  assert.equal(iso(m.start), "2026-03-01T05:00:00.000Z");
  assert.equal(iso(m.end), "2026-04-01T04:00:00.000Z");
  const d = windowBounds(new Date("2027-01-01T04:59:59Z"), "month"); // Dec 31 23:59 EST
  assert.equal(iso(d.start), "2026-12-01T05:00:00.000Z");
  assert.equal(iso(d.end), "2027-01-01T05:00:00.000Z");
});

Deno.test("window sums: counted vs excluded states and fund_auto", async () => {
  const db = await tmpDb();
  const at = "2026-10-11T14:00:00.000Z";
  const now = new Date("2026-10-11T18:00:00Z");
  // counted
  mk(db, at, "dm_pending", 100);
  mk(db, at, "dm_delivered", 200);
  mk(db, at, "pending_approval", 400);
  mk(db, at, "approved", 800);
  mk(db, at, "placing", 1600);
  mk(db, at, "placed", 3200, { finalCents: 3000 }); // final wins over quote
  mk(db, at, "delivered", 6000);
  mk(db, at, "closed", 12000, { vendor: "adafruit" });
  // excluded
  for (
    const s of [
      "received",
      "quoted",
      "decided",
      "denied",
      "cancelled",
      "expired",
      "refunded",
      "failed",
    ] as State[]
  ) {
    mk(db, at, s, 100_000);
  }
  mk(db, at, "placed", 70_000, { tier: "fund_auto" });

  const u = windowUsage(db, now, "mouser", "general");
  const all = 100 + 200 + 400 + 800 + 1600 + 3000 + 6000 + 12000;
  assert.equal(u["global/day"].spentCents, all);
  assert.equal(u["global/month"].spentCents, all);
  assert.equal(u["mouser/month"].spentCents, all - 12000);
  assert.equal(u["mouser/month"].capCents, 10_000);
  assert.equal(u["joy/week"].spentCents, 0);
  assert.equal(u["global/day"].capCents, 10_000);
  assert.equal(u["global/month"].capCents, 25_000);
  assert.equal(u["joy/week"].capCents, 4_000);
});

Deno.test("joy counts in joy/week AND global", async () => {
  const db = await tmpDb();
  const now = new Date("2026-10-14T18:00:00Z"); // Wed
  mk(db, "2026-10-12T04:00:00.000Z", "closed", 2300, { joy: true }); // Mon 00:00 EDT
  mk(db, "2026-10-12T03:59:59.999Z", "closed", 999, { joy: true }); // prior week
  const u = windowUsage(db, now, "mouser", "joy");
  assert.equal(u["joy/week"].spentCents, 2300);
  assert.equal(u["global/month"].spentCents, 3299);
  assert.equal(u["global/day"].spentCents, 0);
});

Deno.test("day/week/month edges at ET midnight, incl. DST week", async () => {
  const db = await tmpDb();
  // Spring-forward week: [2026-03-02T05:00Z, 2026-03-09T04:00Z)
  mk(db, "2026-03-02T04:59:59.999Z", "closed", 1, { joy: true }); // out (Sun Mar 1 23:59 EST)
  mk(db, "2026-03-02T05:00:00.000Z", "closed", 10, { joy: true }); // in
  mk(db, "2026-03-09T03:59:59.999Z", "closed", 100, { joy: true }); // in (Sun Mar 8 23:59 EDT)
  mk(db, "2026-03-09T04:00:00.000Z", "closed", 1000, { joy: true }); // out (next week)
  const u = windowUsage(db, new Date("2026-03-05T12:00:00Z"), "mouser");
  assert.equal(u["joy/week"].spentCents, 110);
  // month of March: starts 2026-03-01T05:00Z; everything above except none is before → 1111
  assert.equal(u["global/month"].spentCents, 1111);
  // day of Mar 8 (23h day): [03-08T05:00Z, 03-09T04:00Z)
  const d = windowUsage(db, new Date("2026-03-08T20:00:00Z"), "mouser");
  assert.equal(d["global/day"].spentCents, 100);
  // Feb 28 23:59 EST is outside March
  mk(db, "2026-03-01T04:59:59.999Z", "closed", 10_000);
  assert.equal(
    windowUsage(db, new Date("2026-03-20T12:00:00Z"), "mouser")["global/month"]
      .spentCents,
    1111,
  );
  assert.equal(
    windowUsage(db, new Date("2026-02-20T12:00:00Z"), "mouser")["global/month"]
      .spentCents,
    10_000,
  );
});

Deno.test("upsertBudget overrides caps; openDb does not clobber them", async () => {
  const path = await Deno.makeTempFile({
    dir: "/tmp",
    prefix: "pg-budget-",
    suffix: ".db",
  });
  const db = openDb(path);
  upsertBudget(db, { key: "global/day", window: "day", capCents: 5_000 });
  upsertBudget(db, { key: "mouser/month", window: "month", capCents: 20_000 });
  db.close();
  const db2 = openDb(path);
  const u = windowUsage(db2, new Date(), "mouser");
  assert.equal(u["global/day"].capCents, 5_000);
  assert.equal(u["mouser/month"].capCents, 20_000);
  assert.equal(
    windowUsage(db2, new Date(), "digikey")["digikey/month"].capCents,
    10_000,
  );
  assert.equal(listBudgets(db2).length, 4);
  assert.throws(() =>
    upsertBudget(db2, { key: "x", window: "day", capCents: -1 })
  );
});

Deno.test("mock-vendor test purchases never count against a real vendor's windows", async () => {
  const db = await tmpDb();
  const at = "2026-10-11T14:00:00.000Z";
  const now = new Date("2026-10-11T18:00:00Z");
  mk(db, at, "placed", 8_040, { vendor: "mock" }); // the live mock "heat gun" test, 2026-10-11
  mk(db, at, "placed", 200, { vendor: "zinc" });
  mk(db, at, "placed", 500, { vendor: "mock", joy: true });
  const zinc = windowUsage(db, now, "zinc", "joy");
  assert.equal(zinc["global/day"].spentCents, 200);
  assert.equal(zinc["global/month"].spentCents, 200);
  assert.equal(zinc["joy/week"].spentCents, 0);
  const mock = windowUsage(db, now, "mock", "joy"); // mock still sees everything, so caps stay testable
  assert.equal(mock["global/day"].spentCents, 8_740);
  assert.equal(mock["joy/week"].spentCents, 500);
});

Deno.test("excludeRequestId leaves the re-decided request out of every window", async () => {
  const db = await tmpDb();
  const at = "2026-10-11T14:00:00.000Z";
  const now = new Date("2026-10-11T18:00:00Z");
  mk(db, at, "closed", 1_000, { joy: true });
  const self = mk(db, at, "approved", 6_900, { joy: true });
  const all = windowUsage(db, now, "mouser", "joy");
  assert.equal(all["global/day"].spentCents, 7_900);
  const ex = windowUsage(db, now, "mouser", "joy", { excludeRequestId: self });
  assert.equal(ex["global/day"].spentCents, 1_000);
  assert.equal(ex["global/month"].spentCents, 1_000);
  assert.equal(ex["mouser/month"].spentCents, 1_000);
  assert.equal(ex["joy/week"].spentCents, 1_000);
});
