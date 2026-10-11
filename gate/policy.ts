// The spending policy. Pure: no I/O, no clock, no globals beyond types.ts constants.
// Implements CONTRACT.md "Policy" in order. Reasons are short machine codes.
// Thresholds come from `limits` (built by config.ts); the default is types.ts DEFAULT_LIMITS.
import {
  DEFAULT_LIMITS,
  type PolicyInput,
  type PolicyLimits,
  type PolicyResult,
  type Reach,
  REACH_RANK,
  type Tier,
} from "./types.ts";

/** Windows that must be present for a non-fund decision. Missing → deny (fail closed). */
export const REQUIRED_WINDOWS = ["global/day", "global/month"] as const;
export const JOY_WINDOW = "joy/week";

export function maxReach(a: Reach, b: Reach): Reach {
  return REACH_RANK[a] >= REACH_RANK[b] ? a : b;
}

export function tierFor(totalCents: number, limits: PolicyLimits = DEFAULT_LIMITS): Tier {
  if (totalCents < limits.autoMaxCents) return "auto";
  if (totalCents <= limits.askMaxCents) return "ask";
  if (limits.fundEnabled && totalCents <= limits.fundMaxCents) return "fund_auto";
  return "refuse";
}

export function decide(i: PolicyInput, limits: PolicyLimits = DEFAULT_LIMITS): PolicyResult {
  const effectiveReach = maxReach(i.reach, i.adapterReach);
  const tier = tierFor(i.totalCents, limits);
  const deny = (reasons: string[], extra: Partial<PolicyResult> = {}): PolicyResult => ({
    decision: "deny",
    tier,
    effectiveReach,
    reasons,
    ...extra,
  });

  // 1–3: hard stops.
  if (i.stopped) return deny(["stopped"]);
  if (!i.vendorAllowed) return deny(["vendor_not_allowed"]);
  if (i.requestsLast10m > limits.velocityLimit) return deny(["velocity"], { tripStop: true });
  if (!Number.isSafeInteger(i.totalCents) || i.totalCents < 0) return deny(["bad_total"]);

  // 5: tier by quoted total.
  if (tier === "refuse") return deny(["over_max"]);

  // 9 (joy constraints, checked before money moves): joy is self-reach, auto-tier only.
  // A joy request in fund_auto would skip joy/week entirely, so it is denied too.
  if (i.budget === "joy") {
    if (!limits.joyEnabled) return deny(["joy_disabled"]);
    if (effectiveReach !== "self") return deny(["joy_reach"]);
    if (tier !== "auto") return deny(["joy_over_auto"]);
  }

  const reachOthers = effectiveReach === "others";
  const reasons = reachOthers ? ["reach_others"] : [];

  // 6: fund tier is paid from the fund and ignores the spending windows.
  if (tier === "fund_auto") {
    if (i.fundBalanceCents < i.totalCents) return deny(["fund_insufficient"]);
    return {
      decision: reachOthers ? "ask" : "auto",
      tier,
      effectiveReach,
      reasons: ["fund_auto", ...reasons],
      holdFundCents: i.totalCents,
    };
  }

  // 7: every supplied window (joy/* only for joy), and this vendor's monthly window must be there.
  const required: string[] = [...REQUIRED_WINDOWS, `${i.vendor}/month`];
  if (i.budget === "joy") required.push(JOY_WINDOW);
  const missing = required.filter((k) => !(k in i.windows));
  if (missing.length) return deny(missing.map((k) => `window_missing:${k}`));

  const over = Object.entries(i.windows)
    .filter(([key]) => i.budget === "joy" || !key.startsWith("joy/"))
    .filter(([, w]) => w.spentCents + i.totalCents > w.capCents)
    .map(([key]) => `window:${key}`);
  if (over.length) return deny(over);

  // 8: reach others always asks.
  const decision = tier === "ask" || reachOthers ? "ask" : "auto";
  return { decision, tier, effectiveReach, reasons };
}
