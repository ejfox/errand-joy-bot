import { assert, assertEquals, assertThrows } from "@std/assert";
import { ConfigError, DEFAULT_CONFIG, loadConfig, parseConfig, validateConfig } from "./config.ts";

const EXAMPLE_LIKE = `
timezone = "America/New_York"
vendors = ["mock"]
owner_home_label = "owner-home"
min_reason_chars = 60

[tiers]
auto_max_cents = 2000
ask_max_cents = 7500
fund_enabled = false
fund_max_cents = 0

[caps]
day_cents = 7500
month_cents = 15000
vendor_month_cents = 7500

[joy]
enabled = true
week_cents = 1000

[quiet_hours]
start = "22:00"
end = "07:30"

[velocity]
max_requests_per_10m = 5

[windows]
auto_cancel_minutes = 10
fund_veto_minutes = 120
approval_ttl_hours = 24
`;

function problems(f: () => unknown): string[] {
  try {
    f();
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  throw new Error("expected a ConfigError");
}

Deno.test("defaults are the types.ts values ($69/$500/$1000, $100/day, $250/month, $100/vendor, $40 joy)", () => {
  const c = DEFAULT_CONFIG;
  assertEquals(c.limits, { autoMaxCents: 6900, askMaxCents: 50000, fundEnabled: true, fundMaxCents: 100000, velocityLimit: 5, joyEnabled: true });
  assertEquals(c.budgets.map((b) => b.capCents), [10000, 25000, 4000]);
  assertEquals(c.vendorMonthCapCents, 10000);
  assertEquals(c.minReasonChars, 60);
  assertEquals(c.timing, { autoCancelWindowMs: 600_000, fundVetoWindowMs: 7_200_000, approvalTtlMs: 86_400_000 });
  assertEquals(c.ownerHomeLabel, "owner-home");
});

Deno.test("[notify] defaults load: silent below $40, sealed on", () => {
  assertEquals(DEFAULT_CONFIG.notice, { silentBelowCents: 4000, sealed: true });
  assertEquals(loadConfig("examples/config.example.toml").config.notice, { silentBelowCents: 4000, sealed: true });
  const { config } = validateConfig({ notify: { silent_below_cents: 0, sealed: false } });
  assertEquals(config.notice, { silentBelowCents: 0, sealed: false });
  // the default follows a lowered auto tier down (the example file's $20)
  assertEquals(parseConfig(EXAMPLE_LIKE).config.notice.silentBelowCents, 2000);
});

Deno.test("[notify] raising the silent ceiling is looser; above the auto tier is an error", () => {
  const p = problems(() => validateConfig({ notify: { silent_below_cents: 5000, sealed: "yes", loud: 1 } }));
  assert(p.some((x) => x.includes("notify.silent_below_cents = 5000 exceeds the hard ceiling of 4000")), p.join("\n"));
  assert(p.some((x) => x.includes("notify.sealed must be true or false")));
  assert(p.some((x) => x.includes("unknown key notify.loud")));
  const q = problems(() => validateConfig({ tiers: { auto_max_cents: 3000 }, caps: { day_cents: 10_000 }, notify: { silent_below_cents: 3500 } }));
  assert(q.some((x) => x.includes("must be <= tiers.auto_max_cents (3000)")), q.join("\n"));
  const risky = validateConfig({ i_understand_the_risk: true, notify: { silent_below_cents: 6000 } });
  assertEquals(risky.config.notice.silentBelowCents, 6000);
});

Deno.test("a stricter, example-style file parses; fund off; ask ceiling notice", () => {
  const { config, notices } = parseConfig(EXAMPLE_LIKE);
  assertEquals(config.limits.autoMaxCents, 2000);
  assertEquals(config.limits.fundEnabled, false);
  assertEquals(config.limits.fundMaxCents, 0);
  assertEquals(config.budgets.find((b) => b.key === "joy/week")!.capCents, 1000);
  assertEquals(notices, []);
  const tight = parseConfig(EXAMPLE_LIKE.replace("day_cents = 7500", "day_cents = 5000"));
  assertEquals(tight.notices, ["effective ask ceiling = $50.00 (limited by caps.day_cents)"]);
});

Deno.test("looser than a hard ceiling is refused, with a clear message", () => {
  const p = problems(() => validateConfig({ tiers: { ask_max_cents: 80_000, fund_max_cents: 150_000 }, caps: { day_cents: 20_000 } }));
  assert(p.some((x) => x.includes("tiers.ask_max_cents = 80000 exceeds the hard ceiling of 50000")), p.join("\n"));
  assert(p.some((x) => x.includes("tiers.fund_max_cents = 150000 exceeds the hard ceiling of 100000")));
  assert(p.some((x) => x.includes("caps.day_cents")));
  assert(p.some((x) => x.includes("i_understand_the_risk")));
  // shorter veto window / faster velocity are looser too
  const w = problems(() => validateConfig({ windows: { auto_cancel_minutes: 2 }, velocity: { max_requests_per_10m: 9 } }));
  assertEquals(w.length, 2);
});

Deno.test("i_understand_the_risk lifts ceilings to the absolute limits only", () => {
  const { config, notices } = validateConfig({
    i_understand_the_risk: true,
    tiers: { ask_max_cents: 80_000, fund_max_cents: 150_000 },
    caps: { day_cents: 20_000, month_cents: 50_000 },
  });
  assertEquals(config.limits.fundMaxCents, 150_000);
  assert(notices[0].startsWith("WARNING"));
  const p = problems(() => validateConfig({ i_understand_the_risk: true, tiers: { fund_max_cents: 2_000_000 } }));
  assert(p[0].includes("absolute maximum of 1000000"));
  // approval TTL can never exceed 24h
  assert(problems(() => validateConfig({ i_understand_the_risk: true, windows: { approval_ttl_hours: 48 } }))[0].includes("absolute"));
});

Deno.test("structural errors: unknown keys, day < auto, bad types, unknown vendor, bad tz/quiet hours", () => {
  const p = problems(() =>
    validateConfig({
      tierz: {},
      tiers: { auto_max_cents: 5000, oops: 1 },
      caps: { day_cents: 4000 },
      vendors: ["amazon"],
      timezone: "Mars/Olympus",
      quiet_hours: { start: "25:00" },
      joy: { enabled: "yes" },
      velocity: { max_requests_per_10m: 2.5 },
    })
  );
  const has = (s: string) => assert(p.some((x) => x.includes(s)), `missing "${s}" in:\n${p.join("\n")}`);
  has("unknown key tierz");
  has("unknown key tiers.oops");
  has("caps.day_cents (4000) < tiers.auto_max_cents (5000)");
  has(`vendors: "amazon" has no adapter`);
  has("timezone");
  has("quiet_hours.start");
  has("joy.enabled must be true or false");
  has("velocity.max_requests_per_10m must be a non-negative integer");
});

Deno.test("TOML syntax errors and missing files", () => {
  assertThrows(() => parseConfig("tiers = [ unclosed"), ConfigError, "TOML syntax error");
  assertThrows(() => loadConfig("/tmp/definitely-not-here-ejb.toml"), ConfigError, "cannot read");
  const dflt = loadConfig(undefined);
  // repo root has no config.toml in tests → defaults
  if (dflt.source === "defaults") assertEquals(dflt.config.limits.autoMaxCents, 6900);
});

Deno.test("equal quiet hours = off; joy disabled zeroes the joy cap", () => {
  const { config } = validateConfig({ quiet_hours: { start: "00:00", end: "00:00" }, joy: { enabled: false } });
  assert(config.quietHours.off);
  assertEquals(config.limits.joyEnabled, false);
  assertEquals(config.budgets.find((b) => b.key === "joy/week")!.capCents, 0);
});
