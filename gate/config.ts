// Policy config: config.toml (see examples/config.example.toml). Secrets never live here; they stay
// in env (.env). Every number has a code DEFAULT (types.ts) that is also its HARD CEILING: the file
// can only make policy stricter. Loosening past a ceiling needs `i_understand_the_risk = true`, and
// even then ABSOLUTE limits apply. Unknown keys are errors (a typo must never silently loosen policy).
import { parse as parseToml } from "@std/toml";
import {
  ASK_MAX_CENTS,
  AUTO_CANCEL_WINDOW_MS,
  AUTO_MAX_CENTS,
  APPROVAL_TTL_MS,
  type Budget,
  DEFAULT_BUDGETS,
  DEFAULT_VENDOR_MONTH_CAP_CENTS,
  FUND_MAX_CENTS,
  FUND_VETO_WINDOW_MS,
  MIN_REASON_CHARS,
  OWNER_HOME,
  type PolicyLimits,
  QUIET_HOURS,
  VELOCITY_LIMIT,
} from "./types.ts";
import { parseHm, quietHoursConfig, type QuietHoursConfig, validTz } from "./notify.ts";
import { knownVendors } from "./adapters/registry.ts";
import { MOCK_TAX_RATE } from "./adapters/mock.ts";
import type { Timing } from "./orchestrator.ts";

export class ConfigError extends Error {
  constructor(readonly problems: string[], source = "config") {
    super(`${source}: ${problems.length} problem(s)\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export interface GateConfig {
  timezone: string;
  vendors: string[];
  /** The shipTo string agents use for the owner's own address (normalised to OWNER_HOME at intake). */
  ownerHomeLabel: string;
  minReasonChars: number;
  riskAcknowledged: boolean;
  limits: PolicyLimits;
  /** global/day, global/month, joy/week. */
  budgets: Budget[];
  vendorMonthCapCents: number;
  timing: Timing;
  quietHours: QuietHoursConfig;
  worldCategories: string[];
  mockTaxRate: number;
}

const DAY = DEFAULT_BUDGETS.find((b) => b.key === "global/day")!.capCents;
const MONTH = DEFAULT_BUDGETS.find((b) => b.key === "global/month")!.capCents;
const JOY_WEEK = DEFAULT_BUDGETS.find((b) => b.key === "joy/week")!.capCents;

/** The ceiling with i_understand_the_risk: $10,000 for any amount. */
export const ABSOLUTE_MAX_CENTS = 1_000_000;

type Dir = "max" | "min"; // max: bigger is looser (amounts). min: smaller is looser (windows, reason length).
interface NumSpec {
  def: number;
  /** Hard ceiling (max) or floor (min) without the risk flag. */
  limit: number;
  /** Absolute bound even with the risk flag. */
  abs: number;
  dir: Dir;
}

const NUMS: Record<string, NumSpec> = {
  "tiers.auto_max_cents": { def: AUTO_MAX_CENTS, limit: AUTO_MAX_CENTS, abs: ABSOLUTE_MAX_CENTS, dir: "max" },
  "tiers.ask_max_cents": { def: ASK_MAX_CENTS, limit: ASK_MAX_CENTS, abs: ABSOLUTE_MAX_CENTS, dir: "max" },
  "tiers.fund_max_cents": { def: FUND_MAX_CENTS, limit: FUND_MAX_CENTS, abs: ABSOLUTE_MAX_CENTS, dir: "max" },
  "caps.day_cents": { def: DAY, limit: DAY, abs: ABSOLUTE_MAX_CENTS, dir: "max" },
  "caps.month_cents": { def: MONTH, limit: MONTH, abs: ABSOLUTE_MAX_CENTS, dir: "max" },
  "caps.vendor_month_cents": { def: DEFAULT_VENDOR_MONTH_CAP_CENTS, limit: DEFAULT_VENDOR_MONTH_CAP_CENTS, abs: ABSOLUTE_MAX_CENTS, dir: "max" },
  "joy.week_cents": { def: JOY_WEEK, limit: JOY_WEEK, abs: ABSOLUTE_MAX_CENTS, dir: "max" },
  "velocity.max_requests_per_10m": { def: VELOCITY_LIMIT, limit: VELOCITY_LIMIT, abs: 20, dir: "max" },
  "windows.auto_cancel_minutes": { def: AUTO_CANCEL_WINDOW_MS / 60_000, limit: AUTO_CANCEL_WINDOW_MS / 60_000, abs: 1, dir: "min" },
  "windows.fund_veto_minutes": { def: FUND_VETO_WINDOW_MS / 60_000, limit: FUND_VETO_WINDOW_MS / 60_000, abs: 10, dir: "min" },
  // Approval links: shorter is stricter; 24h is the ceiling with or without the flag (the relay caps at 25h).
  "windows.approval_ttl_hours": { def: APPROVAL_TTL_MS / 3600_000, limit: APPROVAL_TTL_MS / 3600_000, abs: APPROVAL_TTL_MS / 3600_000, dir: "max" },
  "min_reason_chars": { def: MIN_REASON_CHARS, limit: MIN_REASON_CHARS, abs: 0, dir: "min" },
};

const SCHEMA: Record<string, readonly string[]> = {
  "": [
    "timezone", "vendors", "owner_home_label", "min_reason_chars", "i_understand_the_risk", "world_categories",
    "tiers", "caps", "joy", "quiet_hours", "velocity", "windows", "mock",
  ],
  tiers: ["auto_max_cents", "ask_max_cents", "fund_enabled", "fund_max_cents"],
  caps: ["day_cents", "month_cents", "vendor_month_cents"],
  joy: ["enabled", "week_cents"],
  quiet_hours: ["start", "end"],
  velocity: ["max_requests_per_10m"],
  windows: ["auto_cancel_minutes", "fund_veto_minutes", "approval_ttl_hours"],
  mock: ["tax_rate"],
};

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export const DEFAULT_CONFIG: GateConfig = validateConfig({}).config;

/** Validate a parsed TOML object. Throws ConfigError listing EVERY problem; returns info notices. */
export function validateConfig(raw: unknown, source = "config"): { config: GateConfig; notices: string[] } {
  const problems: string[] = [];
  const notices: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(["top level must be a table"], source);
  const root = raw as Record<string, unknown>;

  // unknown keys / wrong section types
  for (const [section, keys] of Object.entries(SCHEMA)) {
    const tbl = section === "" ? root : root[section];
    if (tbl === undefined) continue;
    if (section !== "" && (typeof tbl !== "object" || tbl === null || Array.isArray(tbl))) {
      problems.push(`[${section}] must be a table`);
      continue;
    }
    for (const k of Object.keys(tbl as object)) {
      if (!keys.includes(k)) problems.push(`unknown key ${section ? section + "." : ""}${k} (allowed: ${keys.join(", ")})`);
    }
  }
  const get = (path: string): unknown => {
    const [a, b] = path.split(".");
    if (b === undefined) return root[a];
    const t = root[a];
    return t && typeof t === "object" && !Array.isArray(t) ? (t as Record<string, unknown>)[b] : undefined;
  };

  const risk = get("i_understand_the_risk");
  if (risk !== undefined && typeof risk !== "boolean") problems.push("i_understand_the_risk must be true or false");
  const riskOk = risk === true;
  if (riskOk) {
    notices.push("WARNING: i_understand_the_risk = true: hard ceilings are lifted to the absolute limits");
  }

  const num = (path: string): number => {
    const s = NUMS[path];
    const v = get(path);
    if (v === undefined) return s.def;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      problems.push(`${path} must be a non-negative integer (got ${JSON.stringify(v)})`);
      return s.def;
    }
    const bound = riskOk ? s.abs : s.limit;
    if (s.dir === "max" && v > bound) {
      problems.push(
        riskOk || s.abs === s.limit
          ? `${path} = ${v} exceeds the absolute maximum of ${s.abs}`
          : `${path} = ${v} exceeds the hard ceiling of ${s.limit}. Lower it, or set i_understand_the_risk = true (absolute max ${s.abs})`,
      );
    }
    if (s.dir === "min" && v < bound) {
      problems.push(
        riskOk || s.abs === s.limit
          ? `${path} = ${v} is below the absolute minimum of ${s.abs}`
          : `${path} = ${v} is below the floor of ${s.limit}. Raise it, or set i_understand_the_risk = true (absolute min ${s.abs})`,
      );
    }
    return v;
  };
  const bool = (path: string, def: boolean): boolean => {
    const v = get(path);
    if (v === undefined) return def;
    if (typeof v !== "boolean") {
      problems.push(`${path} must be true or false`);
      return def;
    }
    return v;
  };
  const strList = (path: string, def: string[], re: RegExp): string[] => {
    const v = get(path);
    if (v === undefined) return def;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && re.test(x))) {
      problems.push(`${path} must be a list of strings matching ${re}`);
      return def;
    }
    if (new Set(v).size !== v.length) problems.push(`${path} has duplicates`);
    return v as string[];
  };

  // top level
  const tzRaw = get("timezone") ?? QUIET_HOURS.tz;
  let timezone = QUIET_HOURS.tz;
  if (typeof tzRaw !== "string" || !validTz(tzRaw)) problems.push(`timezone ${JSON.stringify(tzRaw)} is not a valid IANA zone`);
  else timezone = tzRaw;

  const vendors = strList("vendors", ["mock"], /^[a-z0-9_-]{1,40}$/);
  if (vendors.length === 0) problems.push("vendors must list at least one vendor");
  for (const v of vendors) {
    if (!knownVendors().includes(v)) problems.push(`vendors: "${v}" has no adapter (known: ${knownVendors().join(", ")})`);
  }

  const label = get("owner_home_label") ?? OWNER_HOME;
  let ownerHomeLabel = OWNER_HOME;
  if (typeof label !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(label)) {
    problems.push("owner_home_label must be 1-40 chars of a-z, 0-9, _ or -");
  } else ownerHomeLabel = label;

  const worldCategories = strList("world_categories", ["tree", "telescope"], /^[a-z0-9_-]{1,40}$/);
  const minReasonChars = num("min_reason_chars");
  if (minReasonChars > 1000) problems.push("min_reason_chars must be at most 1000 (the reason field's max length)");

  // tiers
  const autoMax = num("tiers.auto_max_cents");
  const askMax = num("tiers.ask_max_cents");
  const fundEnabled = bool("tiers.fund_enabled", true);
  const fundMax = num("tiers.fund_max_cents");
  if (autoMax > askMax) problems.push(`tiers.auto_max_cents (${autoMax}) must be <= tiers.ask_max_cents (${askMax})`);
  if (fundEnabled && fundMax <= askMax) {
    problems.push(`tiers.fund_max_cents (${fundMax}) must be > tiers.ask_max_cents (${askMax}) when fund_enabled = true`);
  }

  // caps
  const day = num("caps.day_cents");
  const month = num("caps.month_cents");
  const vendorMonth = num("caps.vendor_month_cents");
  const joyEnabled = bool("joy.enabled", true);
  const joyWeek = num("joy.week_cents");
  if (day < autoMax) {
    problems.push(`caps.day_cents (${day}) < tiers.auto_max_cents (${autoMax}): the top of the auto tier could never be bought`);
  }
  if (day > month) problems.push(`caps.day_cents (${day}) must be <= caps.month_cents (${month})`);
  if (joyEnabled && joyWeek > month) problems.push(`joy.week_cents (${joyWeek}) must be <= caps.month_cents (${month})`);
  const topTier = fundEnabled ? fundMax : askMax;
  if (topTier > FUND_MAX_CENTS) {
    notices.push(
      `WARNING: top tier ${usd(topTier)} exceeds the relay's default limit ${usd(FUND_MAX_CENTS)}: set RELAY_MAX_CENTS >= ${topTier} on the relay or those approvals can never publish`,
    );
  }
  const askCeiling = Math.min(askMax, day, month, vendorMonth);
  if (askCeiling < askMax) {
    const by = askCeiling === day ? "caps.day_cents" : askCeiling === month ? "caps.month_cents" : "caps.vendor_month_cents";
    notices.push(`effective ask ceiling = ${usd(askCeiling)} (limited by ${by})`);
  }

  // velocity, windows
  const velocity = num("velocity.max_requests_per_10m");
  if (velocity < 1) problems.push("velocity.max_requests_per_10m must be >= 1");
  const autoCancelMin = num("windows.auto_cancel_minutes");
  const fundVetoMin = num("windows.fund_veto_minutes");
  const ttlH = num("windows.approval_ttl_hours");
  if (ttlH < 1) problems.push("windows.approval_ttl_hours must be >= 1");

  // quiet hours
  const qs = get("quiet_hours.start") ?? QUIET_HOURS.start;
  const qe = get("quiet_hours.end") ?? QUIET_HOURS.end;
  let quietHours = quietHoursConfig(QUIET_HOURS.start, QUIET_HOURS.end, timezone);
  if (typeof qs !== "string" || parseHm(qs) === undefined) problems.push(`quiet_hours.start ${JSON.stringify(qs)} must be "HH:MM"`);
  else if (typeof qe !== "string" || parseHm(qe) === undefined) problems.push(`quiet_hours.end ${JSON.stringify(qe)} must be "HH:MM"`);
  else quietHours = quietHoursConfig(qs, qe, timezone);

  // mock
  const tax = get("mock.tax_rate") ?? MOCK_TAX_RATE;
  let mockTaxRate = MOCK_TAX_RATE;
  if (typeof tax !== "number" || !(tax >= 0 && tax < 1)) problems.push("mock.tax_rate must be a number in [0, 1)");
  else mockTaxRate = tax;

  if (problems.length) throw new ConfigError(problems, source);

  return {
    notices,
    config: {
      timezone,
      vendors,
      ownerHomeLabel,
      minReasonChars,
      riskAcknowledged: riskOk,
      limits: { autoMaxCents: autoMax, askMaxCents: askMax, fundEnabled, fundMaxCents: fundEnabled ? fundMax : 0, velocityLimit: velocity, joyEnabled },
      budgets: [
        { key: "global/day", window: "day", capCents: day },
        { key: "global/month", window: "month", capCents: month },
        { key: "joy/week", window: "week", capCents: joyEnabled ? joyWeek : 0 },
      ],
      vendorMonthCapCents: vendorMonth,
      timing: {
        autoCancelWindowMs: autoCancelMin * 60_000,
        fundVetoWindowMs: fundVetoMin * 60_000,
        approvalTtlMs: ttlH * 3600_000,
      },
      quietHours,
      worldCategories,
      mockTaxRate,
    },
  };
}

/** Parse TOML text. TOML syntax errors become a ConfigError too. */
export function parseConfig(text: string, source = "config.toml"): { config: GateConfig; notices: string[] } {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new ConfigError([`TOML syntax error: ${e instanceof Error ? e.message : String(e)}`], source);
  }
  return validateConfig(raw, source);
}

/**
 * Load the policy file. `path` given (CONFIG_PATH) → it must exist. No path → ./config.toml if
 * present, otherwise the code defaults (with a notice).
 */
export function loadConfig(path?: string): { config: GateConfig; notices: string[]; source: string } {
  const p = path ?? "config.toml";
  let text: string;
  try {
    text = Deno.readTextFileSync(p);
  } catch (e) {
    if (!path && e instanceof Deno.errors.NotFound) {
      return { ...validateConfig({}, "defaults"), source: "defaults", notices: ["no config.toml found: using the code defaults"] };
    }
    throw new ConfigError([`cannot read ${p}: ${e instanceof Error ? e.name : "error"}`], p);
  }
  return { ...parseConfig(text, p), source: p };
}
