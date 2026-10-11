// WP2: the robot fund. Balance is ALWAYS SUM(cents) over fund_entries; never stored.
//
// Sign convention (enforced here and by a CHECK in schema.sql):
//   topup, income, release, refund  → cents > 0  (money into the available balance)
//   hold, spend                     → cents < 0  (money out of the available balance)
// Lifecycle of a fund_auto purchase:
//   decide:  hold(-X)                              balance drops by X
//   place:   release(+X) then spend(-actualCharge)  net effect = actual charge
//   abort:   release(+X)                            back where it started
//   refund:  refund(+amount)
import type { FundKind } from "./types.ts";
import { type Db, nowISO, tx } from "./db.ts";

const POSITIVE: ReadonlySet<FundKind> = new Set([
  "topup",
  "income",
  "release",
  "refund",
]);

export interface FundEntryInput {
  cents: number; // signed per the convention above
  kind: FundKind;
  source: string; // who/what wrote it: "admin", "reconcile", "gate", ...
  ref?: string;
  requestId?: string;
}

/**
 * Available balance = SUM(cents). With `excludeHoldFor`, that request's own
 * outstanding hold is added back: use it for the approved → placing re-decide,
 * otherwise a fund_auto request is blocked by its own hold.
 */
export function fundBalance(
  db: Db,
  opts: { excludeHoldFor?: string } = {},
): number {
  const r = db.prepare("SELECT COALESCE(SUM(cents), 0) AS b FROM fund_entries")
    .get() as {
      b: number;
    };
  const own = opts.excludeHoldFor
    ? outstandingHold(db, opts.excludeHoldFor)
    : 0;
  return Number(r.b) + own;
}

export function addEntry(
  db: Db,
  e: FundEntryInput,
  now: Date = new Date(),
): number {
  if (!Number.isInteger(e.cents) || e.cents === 0) {
    throw new Error("fund entry cents must be a non-zero integer");
  }
  if (POSITIVE.has(e.kind) !== e.cents > 0) {
    throw new Error(
      `fund entry sign wrong: ${e.kind} must be ${
        POSITIVE.has(e.kind) ? "positive" : "negative"
      }`,
    );
  }
  const res = db.prepare(
    "INSERT INTO fund_entries (cents, kind, source, ref, request_id, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    e.cents,
    e.kind,
    e.source,
    e.ref ?? null,
    e.requestId ?? null,
    nowISO(now),
  );
  return Number(res.lastInsertRowid);
}

/** Reserve `cents` (positive amount) of the fund for a request. */
export function hold(
  db: Db,
  requestId: string,
  cents: number,
  source = "gate",
  now = new Date(),
) {
  if (cents <= 0) throw new Error("hold amount must be positive");
  return addEntry(db, {
    cents: -cents,
    kind: "hold",
    source,
    requestId,
    ref: requestId,
  }, now);
}

/** Cents currently held (net of releases) for a request; >= 0. */
export function outstandingHold(db: Db, requestId: string): number {
  const r = db.prepare(
    `SELECT COALESCE(SUM(cents), 0) AS s FROM fund_entries
     WHERE request_id = ? AND kind IN ('hold','release')`,
  ).get(requestId) as { s: number };
  return 0 - Number(r.s); // not -x: avoids -0
}

/** Release whatever is still held for a request. Returns cents released (0 if none). */
export function release(
  db: Db,
  requestId: string,
  source = "gate",
  now = new Date(),
): number {
  return tx(db, () => {
    const held = outstandingHold(db, requestId);
    if (held <= 0) return 0;
    addEntry(db, {
      cents: held,
      kind: "release",
      source,
      requestId,
      ref: requestId,
    }, now);
    return held;
  });
}
