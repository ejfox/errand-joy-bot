import { assertEquals } from "@std/assert";
import { decide, maxReach, tierFor } from "./policy.ts";
import type { PolicyInput, PolicyResult, WindowUsage } from "./types.ts";

const win = (spentCents: number, capCents: number): WindowUsage => ({ spentCents, capCents });

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    totalCents: 1_000,
    vendor: "mouser",
    reach: "self",
    adapterReach: "self",
    budget: "general",
    fundBalanceCents: 0,
    windows: {
      "global/day": win(0, 10_000),
      "global/month": win(0, 25_000),
      "mouser/month": win(0, 10_000),
      "joy/week": win(0, 4_000),
    },
    requestsLast10m: 0,
    stopped: false,
    vendorAllowed: true,
    ...over,
  };
}

// This vendor's monthly window, roomy, for cases that build windows by hand.
const V = { "mouser/month": win(0, 1e9) };

// Huge windows so tier tests aren't masked by window caps.
const roomy = {
  "global/day": win(0, 1e9),
  "global/month": win(0, 1e9),
  "joy/week": win(0, 1e9),
  "mouser/month": win(0, 1e9),
};
const RICH = 1e9;

type Case = { name: string; in: Partial<PolicyInput>; want: Partial<PolicyResult> };

const cases: Case[] = [
  // tier boundaries
  { name: "0 auto", in: { totalCents: 0 }, want: { decision: "auto", tier: "auto" } },
  { name: "6899 auto", in: { totalCents: 6_899, windows: roomy }, want: { decision: "auto", tier: "auto", reasons: [] } },
  { name: "6900 ask", in: { totalCents: 6_900, windows: roomy }, want: { decision: "ask", tier: "ask" } },
  { name: "50000 ask", in: { totalCents: 50_000, windows: roomy }, want: { decision: "ask", tier: "ask" } },
  {
    name: "50001 fund_auto",
    in: { totalCents: 50_001, fundBalanceCents: RICH },
    want: { decision: "auto", tier: "fund_auto", holdFundCents: 50_001, reasons: ["fund_auto"] },
  },
  {
    name: "100000 fund_auto",
    in: { totalCents: 100_000, fundBalanceCents: 100_000 },
    want: { decision: "auto", tier: "fund_auto", holdFundCents: 100_000 },
  },
  {
    name: "100001 deny",
    in: { totalCents: 100_001, fundBalanceCents: RICH, windows: roomy },
    want: { decision: "deny", tier: "refuse", reasons: ["over_max"] },
  },

  // fund
  {
    name: "fund_auto insufficient fund",
    in: { totalCents: 60_000, fundBalanceCents: 59_999 },
    want: { decision: "deny", tier: "fund_auto", reasons: ["fund_insufficient"], holdFundCents: undefined },
  },
  {
    name: "fund_auto ignores exhausted global windows",
    in: {
      totalCents: 60_000,
      fundBalanceCents: 60_000,
      windows: { "global/day": win(10_000, 10_000), "global/month": win(25_000, 25_000) },
    },
    want: { decision: "auto", tier: "fund_auto", holdFundCents: 60_000 },
  },
  {
    name: "fund_auto ignores missing windows",
    in: { totalCents: 60_000, fundBalanceCents: 60_000, windows: {} },
    want: { decision: "auto", tier: "fund_auto" },
  },

  // reach
  {
    name: "others at $5 asks",
    in: { totalCents: 500, reach: "others", adapterReach: "others" },
    want: { decision: "ask", tier: "auto", effectiveReach: "others", reasons: ["reach_others"] },
  },
  {
    name: "others at fund_auto asks, keeps hold",
    in: { totalCents: 70_000, reach: "others", fundBalanceCents: RICH },
    want: {
      decision: "ask",
      tier: "fund_auto",
      effectiveReach: "others",
      holdFundCents: 70_000,
      reasons: ["fund_auto", "reach_others"],
    },
  },
  {
    name: "adapterReach overrides declared self",
    in: { totalCents: 500, reach: "self", adapterReach: "others" },
    want: { decision: "ask", effectiveReach: "others" },
  },
  {
    name: "world reach at auto stays auto",
    in: { totalCents: 500, reach: "world", adapterReach: "self" },
    want: { decision: "auto", effectiveReach: "world" },
  },

  // windows
  {
    name: "global/day exceeded",
    in: { totalCents: 5_100, windows: { ...input().windows, "global/day": win(5_000, 10_000) } },
    want: { decision: "deny", reasons: ["window:global/day"] },
  },
  {
    name: "exactly at cap is allowed",
    in: { totalCents: 5_000, windows: { ...input().windows, "global/day": win(5_000, 10_000) } },
    want: { decision: "auto" },
  },
  {
    name: "global/month exceeded",
    in: { totalCents: 1_000, windows: { ...input().windows, "global/month": win(24_500, 25_000) } },
    want: { decision: "deny", reasons: ["window:global/month"] },
  },
  {
    name: "vendor/month exceeded",
    in: { totalCents: 1_000, windows: { ...input().windows, "mouser/month": win(9_500, 10_000) } },
    want: { decision: "deny", reasons: ["window:mouser/month"] },
  },
  {
    name: "all failing windows reported",
    in: {
      totalCents: 1_000,
      windows: { "global/day": win(9_500, 10_000), "global/month": win(24_500, 25_000), ...V },
    },
    want: { decision: "deny", reasons: ["window:global/day", "window:global/month"] },
  },
  {
    name: "ask tier is window-checked",
    in: { totalCents: 20_000, windows: { "global/day": win(0, 10_000), "global/month": win(0, 25_000), ...V } },
    want: { decision: "deny", tier: "ask", reasons: ["window:global/day"] },
  },
  {
    name: "general budget ignores a full joy/week",
    in: { totalCents: 1_000, windows: { ...input().windows, "joy/week": win(4_000, 4_000) } },
    want: { decision: "auto" },
  },
  {
    name: "missing global/day fails closed",
    in: { windows: { "global/month": win(0, 25_000), ...V } },
    want: { decision: "deny", reasons: ["window_missing:global/day"] },
  },
  {
    name: "joy missing joy/week fails closed",
    in: { budget: "joy", windows: { "global/day": win(0, 10_000), "global/month": win(0, 25_000), ...V } },
    want: { decision: "deny", reasons: ["window_missing:joy/week"] },
  },

  // joy
  { name: "joy under cap auto", in: { budget: "joy", totalCents: 2_300 }, want: { decision: "auto" } },
  {
    name: "joy over joy/week",
    in: { budget: "joy", totalCents: 2_000, windows: { ...input().windows, "joy/week": win(2_500, 4_000) } },
    want: { decision: "deny", reasons: ["window:joy/week"] },
  },
  {
    name: "joy counts inside global/day",
    in: { budget: "joy", totalCents: 2_000, windows: { ...input().windows, "global/day": win(9_000, 10_000) } },
    want: { decision: "deny", reasons: ["window:global/day"] },
  },
  {
    name: "joy reaching ask",
    in: { budget: "joy", totalCents: 6_900, windows: roomy },
    want: { decision: "deny", tier: "ask", reasons: ["joy_over_auto"] },
  },
  {
    name: "joy reaching fund_auto",
    in: { budget: "joy", totalCents: 60_000, fundBalanceCents: RICH, windows: roomy },
    want: { decision: "deny", tier: "fund_auto", reasons: ["joy_over_auto"] },
  },
  {
    name: "joy reach world",
    in: { budget: "joy", totalCents: 500, reach: "world" },
    want: { decision: "deny", reasons: ["joy_reach"] },
  },
  {
    name: "joy reach others via adapter",
    in: { budget: "joy", totalCents: 500, adapterReach: "others" },
    want: { decision: "deny", reasons: ["joy_reach"] },
  },

  // hard stops, in contract order
  { name: "stopped", in: { stopped: true }, want: { decision: "deny", reasons: ["stopped"], tripStop: undefined } },
  {
    name: "stopped wins over vendor + velocity",
    in: { stopped: true, vendorAllowed: false, requestsLast10m: 99 },
    want: { decision: "deny", reasons: ["stopped"] },
  },
  { name: "vendor not allowed", in: { vendorAllowed: false }, want: { decision: "deny", reasons: ["vendor_not_allowed"] } },
  { name: "velocity 5 ok", in: { requestsLast10m: 5 }, want: { decision: "auto", tripStop: undefined } },
  {
    name: "velocity 6 trips STOP",
    in: { requestsLast10m: 6 },
    want: { decision: "deny", reasons: ["velocity"], tripStop: true },
  },
  { name: "negative total", in: { totalCents: -1 }, want: { decision: "deny", reasons: ["bad_total"] } },
  { name: "fractional total", in: { totalCents: 10.5 }, want: { decision: "deny", reasons: ["bad_total"] } },
  { name: "NaN total", in: { totalCents: NaN }, want: { decision: "deny", reasons: ["bad_total"] } },
];

for (const c of cases) {
  Deno.test(`decide: ${c.name}`, () => {
    const got = decide(input(c.in));
    for (const [k, v] of Object.entries(c.want)) {
      assertEquals(got[k as keyof PolicyResult], v, `${c.name}: ${k}`);
    }
  });
}

Deno.test("decide: burst against global/day $100", () => {
  // The caller feeds back in-flight spend, so each request sees the previous ones.
  // Note: 2×$49 = $98 fits a $100 cap; it takes $1+ of prior spend for the 2nd to fail.
  const run = (prior: number, amounts: number[]) => {
    let spent = prior;
    return amounts.map((totalCents) => {
      const r = decide(input({
        totalCents,
        windows: { "global/day": win(spent, 10_000), "global/month": win(spent, 25_000), ...V },
      }));
      if (r.decision !== "deny") spent += totalCents;
      return r.decision;
    });
  };
  assertEquals(run(0, [4_900, 4_900]), ["auto", "auto"]);
  assertEquals(run(300, [4_900, 4_900]), ["auto", "deny"]);
  assertEquals(run(0, [5_100, 5_100]), ["auto", "deny"]);
  assertEquals(run(0, [4_900, 4_900, 4_900]), ["auto", "auto", "deny"]);
});

Deno.test("decide: is pure (same input, same output; input not mutated)", () => {
  const i = input({ totalCents: 6_000 });
  const snapshot = structuredClone(i);
  assertEquals(decide(i), decide(i));
  assertEquals(i, snapshot);
});

Deno.test("tierFor / maxReach", () => {
  assertEquals([6_899, 6_900, 50_000, 50_001, 100_000, 100_001].map((t) => tierFor(t)), [
    "auto",
    "ask",
    "ask",
    "fund_auto",
    "fund_auto",
    "refuse",
  ]);
  assertEquals(maxReach("self", "world"), "world");
  assertEquals(maxReach("others", "self"), "others");
  assertEquals(maxReach("self", "self"), "self");
});

Deno.test("decide: config limits (stricter tiers, fund off, joy off, missing vendor window)", () => {
  const strict = { autoMaxCents: 2_000, askMaxCents: 7_500, fundEnabled: false, fundMaxCents: 0, velocityLimit: 3, joyEnabled: true };
  assertEquals(decide(input({ totalCents: 1_999 }), strict).decision, "auto");
  assertEquals(decide(input({ totalCents: 2_000 }), strict).decision, "ask");
  assertEquals(decide(input({ totalCents: 7_500 }), strict).tier, "ask");
  // fund off: above ask is refused even with a rich fund
  const r = decide(input({ totalCents: 7_501, fundBalanceCents: RICH, windows: roomy }), strict);
  assertEquals([r.decision, r.tier, r.reasons], ["deny", "refuse", ["over_max"]]);
  assertEquals(decide(input({ requestsLast10m: 4 }), strict).tripStop, true);
  const joyOff = decide(input({ budget: "joy" }), { ...strict, joyEnabled: false });
  assertEquals(joyOff.reasons, ["joy_disabled"]);
  const noVendor = decide(input({ vendor: "zinc" }));
  assertEquals(noVendor.reasons, ["window_missing:zinc/month"]);
});
