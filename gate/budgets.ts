// Rolling budget windows. Totals are SUMs over live requests, never counters.
// Windows are calendar day / ISO week (Monday) / calendar month in the configured timezone
// (config.toml `timezone`; default types.ts QUIET_HOURS.tz).
import {
  type Budget,
  DEFAULT_BUDGETS,
  DEFAULT_VENDOR_MONTH_CAP_CENTS,
  QUIET_HOURS,
  type WindowUsage,
} from "./types.ts";
import type { Db } from "./db.ts";

export const WINDOW_TZ = QUIET_HOURS.tz;

/** States whose money counts against windows (committed, in flight, or possibly spent). */
export const COUNTED_STATES = [
  "dm_pending",
  "dm_delivered",
  "pending_approval",
  "approved",
  "placing",
  "placed",
  "outcome_unknown",
  "delivered",
  "closed",
] as const;

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmts.set(tz, f);
  }
  return f;
}

interface Wall {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallClock(t: Date, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const part of fmtFor(tz).formatToParts(t)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return {
    y: p.year,
    m: p.month,
    d: p.day,
    h: p.hour % 24,
    mi: p.minute,
    s: p.second,
  };
}

/** Offset (ms) of `tz` from UTC at instant t: wall - utc. */
function tzOffsetMs(t: Date, tz: string): number {
  const w = wallClock(t, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(t.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight y-m-d in `tz` (Date.UTC normalizes overflow). */
function localMidnight(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  const corrected = guess - tzOffsetMs(new Date(t), tz);
  if (corrected !== t) t = corrected; // offset differs across a DST edge; midnight is never in a gap
  return new Date(t);
}

export interface WindowBounds {
  start: Date;
  end: Date; // exclusive
}

export function windowBounds(
  now: Date,
  window: Budget["window"],
  tz: string = WINDOW_TZ,
): WindowBounds {
  const w = wallClock(now, tz);
  if (window === "day") {
    return {
      start: localMidnight(w.y, w.m, w.d, tz),
      end: localMidnight(w.y, w.m, w.d + 1, tz),
    };
  }
  if (window === "month") {
    return {
      start: localMidnight(w.y, w.m, 1, tz),
      end: localMidnight(w.y, w.m + 1, 1, tz),
    };
  }
  // ISO week: Monday 00:00 local.
  const dow = new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay(); // 0=Sun
  const back = (dow + 6) % 7;
  return {
    start: localMidnight(w.y, w.m, w.d - back, tz),
    end: localMidnight(w.y, w.m, w.d - back + 7, tz),
  };
}

function capFor(db: Db, key: string, fallback: number): number {
  const r = db.prepare("SELECT cap_cents FROM budgets WHERE key = ?").get(
    key,
  ) as
    | { cap_cents: number }
    | undefined;
  return r ? Number(r.cap_cents) : fallback;
}

function defaultCap(key: string): number {
  return DEFAULT_BUDGETS.find((b) => b.key === key)?.capCents ?? 0;
}

const STATE_LIST = COUNTED_STATES.map((s) => `'${s}'`).join(",");

function spent(
  db: Db,
  b: WindowBounds,
  excludeId: string | null,
  extra = "",
  args: string[] = [],
): number {
  const r = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(final_cents, quote_total_cents, 0)), 0) AS s FROM requests
     WHERE state IN (${STATE_LIST})
       AND (tier IS NULL OR tier <> 'fund_auto')
       AND created_at >= ? AND created_at < ?
       AND (? IS NULL OR id <> ?) ${extra}`,
  ).get(
    b.start.toISOString(),
    b.end.toISOString(),
    excludeId,
    excludeId,
    ...args,
  ) as {
    s: number;
  };
  return Number(r.s);
}

/**
 * Usage for every window policy may check: global/day, global/month,
 * `<vendor>/month` and joy/week. All four are always returned (the API shows
 * them all); policy only applies joy/week to joy requests. `_budget` is accepted
 * for call-site clarity and does not change the result.
 *
 * `opts.excludeRequestId`: leave that request out of every sum. REQUIRED for the
 * approved → placing re-decide, where the request itself is already in a counted
 * state and policy adds its total again (otherwise it is double-counted).
 */
export function windowUsage(
  db: Db,
  now: Date,
  vendor: string,
  _budget?: "general" | "joy",
  opts: { excludeRequestId?: string; tz?: string } = {},
): Record<string, WindowUsage> {
  const tz = opts.tz ?? WINDOW_TZ;
  const day = windowBounds(now, "day", tz);
  const month = windowBounds(now, "month", tz);
  const week = windowBounds(now, "week", tz);
  const vKey = `${vendor}/month`;
  const ex = opts.excludeRequestId ?? null;
  // The mock vendor moves no money, so its test purchases never eat a real vendor's
  // budget. Mock requests still count against each other, so caps stay testable.
  const real = vendor === "mock" ? "" : "AND vendor <> 'mock'";
  return {
    "global/day": {
      spentCents: spent(db, day, ex, real),
      capCents: capFor(db, "global/day", defaultCap("global/day")),
    },
    "global/month": {
      spentCents: spent(db, month, ex, real),
      capCents: capFor(db, "global/month", defaultCap("global/month")),
    },
    [vKey]: {
      spentCents: spent(db, month, ex, "AND vendor = ?", [vendor]),
      capCents: capFor(db, vKey, DEFAULT_VENDOR_MONTH_CAP_CENTS),
    },
    "joy/week": {
      spentCents: spent(db, week, ex, `AND budget = 'joy' ${real}`),
      capCents: capFor(db, "joy/week", defaultCap("joy/week")),
    },
  };
}

export function upsertBudget(db: Db, b: Budget): void {
  if (!Number.isInteger(b.capCents) || b.capCents < 0) {
    throw new Error("capCents must be a non-negative integer");
  }
  db.prepare(
    `INSERT INTO budgets (key, window, cap_cents) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET window = excluded.window, cap_cents = excluded.cap_cents`,
  ).run(b.key, b.window, b.capCents);
}

export function listBudgets(db: Db): Budget[] {
  return (db.prepare("SELECT key, window, cap_cents FROM budgets ORDER BY key")
    .all() as {
      key: string;
      window: Budget["window"];
      cap_cents: number;
    }[]).map((r) => ({
      key: r.key,
      window: r.window,
      capCents: Number(r.cap_cents),
    }));
}
