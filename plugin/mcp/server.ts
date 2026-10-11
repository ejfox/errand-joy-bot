// errand-joy-bot MCP server: a thin, request-only HTTP client for the purchase gate.
//
// It holds ONE credential, the gate's agent token (Bearer on /api/*). It can ask to buy,
// read request state and read budget usage. It cannot approve, deny, stop, unstop, fund
// or rate anything: those routes need the admin token or a human tap on the relay link,
// and this process never sees either.
//
// Launched by run.sh, which pins --allow-net to the gate's host:port and --allow-env to
// the two variables below. Config comes from the plugin's userConfig via .mcp.json:
//   EJB_GATE_URL     e.g. http://127.0.0.1:47400
//   EJB_AGENT_TOKEN  sensitive; stored in the OS credential store by Claude Code

import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/stdio.js";
import * as z from "npm:zod@3.25.76/v4";

const VERSION = "0.1.0";
const TIMEOUT_MS = 15_000;

// ── Contract mirrors (keep in sync with gate/types.ts) ─────────────────────
const AUTO_MAX_CENTS = 6_900;
const ASK_MAX_CENTS = 50_000;
const FUND_MAX_CENTS = 100_000;
const SILENT_BELOW_CENTS = 4_000; // [notify] silent_below_cents default
const HINT_MAX_CHARS = 80;

const STATES = [
  "received", "quoted", "decided", "dm_pending", "dm_delivered", "pending_approval",
  "approved", "denied", "expired", "placing", "placed", "delivered", "closed",
  "cancelled", "refunded", "failed",
] as const;
type State = typeof STATES[number];

/** States where money is in flight or the outcome is still open. Used when list_purchases gets no state. */
const OPEN_STATES: State[] = ["dm_pending", "dm_delivered", "pending_approval", "approved", "placing", "placed", "delivered"];

const STATE_TEXT: Record<State, string> = {
  received: "received by the gate",
  quoted: "quoted by the vendor",
  decided: "policy has decided",
  dm_pending: "waiting for the owner's notification to go out (nothing happens before it does; quiet hours queue it)",
  dm_delivered: "owner notified; inside the cancel/veto window",
  pending_approval: "waiting for the owner to tap Approve or Deny",
  approved: "approved; will be placed on the next gate tick",
  denied: "denied",
  expired: "expired (no answer or the notification never got through)",
  placing: "order is being placed",
  placed: "order placed with the vendor",
  delivered: "delivered",
  closed: "closed",
  cancelled: "cancelled (vetoed or cancelled)",
  refunded: "refunded",
  failed: "placing the order failed",
};

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// ── Config ─────────────────────────────────────────────────────────────────
/** An unset userConfig value can arrive empty or as the literal `${user_config.x}`; treat both as unset. */
const envValue = (name: string) => {
  const v = (Deno.env.get(name) ?? "").trim();
  return v.startsWith("${") ? "" : v;
};

function loadConfig(): { base: string; token: string } {
  const raw = envValue("EJB_GATE_URL") || "http://127.0.0.1:47400";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`gate_url is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("gate_url must be http(s)");
  const token = envValue("EJB_AGENT_TOKEN");
  return { base: u.origin + u.pathname.replace(/\/+$/, ""), token };
}

const cfg = loadConfig();

// ── Human-readable reasons ────────────────────────────────────────────────
const dollars = (c: number | undefined | null) =>
  typeof c === "number" && Number.isFinite(c) ? `$${(c / 100).toFixed(2)}` : "?";

function windowLabel(key: string): string {
  const [scope, period] = key.split("/");
  const when = period === "day" ? "today's" : period === "week" ? "this week's" : period === "month" ? "this month's" : `the ${period}`;
  if (scope === "global") return `${when} overall spending cap`;
  if (scope === "joy") return `${when} joy budget`;
  return `${when} cap for vendor "${scope}"`;
}

/** Policy reason codes (gate/policy.ts) → plain English. */
export function explainReason(code: string): string {
  if (code.startsWith("window:")) return `would exceed ${windowLabel(code.slice(7))}`;
  if (code.startsWith("window_missing:")) return `gate is missing budget window ${code.slice(15)} (gate misconfiguration; tell the owner)`;
  const map: Record<string, string> = {
    stopped: "the gate is in STOP. Nothing can be bought until the owner clears it",
    vendor_not_allowed: "that vendor is not on the gate's allowlist",
    velocity: "too many requests in 10 minutes; this tripped STOP",
    bad_total: "the vendor quote was not a valid amount",
    over_max: `the quoted total is over ${dollars(FUND_MAX_CENTS)}, which is always refused`,
    joy_reach: "joy purchases must be for the owner alone (reach: self)",
    joy_over_auto: `joy purchases must be under ${dollars(AUTO_MAX_CENTS)}; joy never asks`,
    fund_insufficient: "the robot fund does not cover this amount",
    fund_auto: "paid from the robot fund (owner gets a veto window)",
    reach_others: "it reaches other people, so the owner must approve it",
    policy_changed: "policy changed between approval and placing (a cap filled up or STOP was set)",
    vendor_cancelled: "the vendor cancelled the order",
    vendor_failed: "the vendor could not fulfil the order",
    silent: "silent tier: no pre-order DM; the owner learns about it from your why-note on delivery",
    quote_changed: "the vendor's price changed after the decision, so it was not placed",
    now_needs_dm: "it no longer qualifies for the silent tier; submit it again if still needed",
    now_needs_ask: "it now needs the owner's approval; submit it again if still needed",
  };
  return map[code] ?? code;
}

/** Gate HTTP error strings (gate/server.ts) → plain English. */
export function explainGateError(status: number, error: string): string {
  const map: Record<string, string> = {
    unauthorized: "the gate rejected the agent token. Re-enter agent_token in /plugin config (the user must do this; never paste it in chat)",
    stopped: "the gate is in STOP. Nothing can be bought until the owner clears it",
    idempotency_conflict: "that idempotencyKey was already used for a different request. This is treated as an integrity failure; use a fresh key and do not retry blindly",
    illegal_transition: "that request cannot move to that state from where it is",
    quote_failed: "the vendor could not quote this (bad SKU, out of stock, or the vendor is down)",
    not_found: "no such request",
    unknown_vendor: "that vendor is not on the gate's allowlist",
    too_large: "request body too large",
    internal: "the gate hit an internal error; run /errand-joy-bot:doctor",
  };
  const human = map[error] ?? (error.endsWith(" invalid") ? `invalid field: ${error.replace(/ invalid$/, "")}` : error);
  return `gate said ${status} ${error}: ${human}`;
}

// ── HTTP ───────────────────────────────────────────────────────────────────
class GateError extends Error {}

async function gate(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  if (!cfg.token) throw new GateError("agent_token is not set. The user sets it in /plugin config (it is stored as a secret); then restart the session");
  let res: Response;
  try {
    res = await fetch(cfg.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.name === "TimeoutError" ? "timed out" : e.message : String(e);
    throw new GateError(`cannot reach the gate at ${cfg.base} (${msg}). Is it running? Try /errand-joy-bot:doctor`);
  }
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = (json && typeof json === "object" && "error" in json) ? String((json as { error: unknown }).error) : text.slice(0, 200) || res.statusText;
    throw new GateError(explainGateError(res.status, err));
  }
  return json;
}

// ── Row presentation (sealed envelope for joy) ────────────────────────────
type Row = Record<string, unknown> & { id?: string; budget?: string; state?: State; reasons?: string[]; decision?: string; tier?: string };

function present(row: Row) {
  const quote = row.quote as { totalCents?: number } | undefined;
  const base = {
    id: row.id,
    state: row.state,
    stateMeaning: row.state ? STATE_TEXT[row.state] ?? row.state : undefined,
    budget: row.budget,
    vendor: row.vendor,
    decision: row.decision,
    tier: row.tier,
    reachEffective: row.reachEffective,
    quotedTotal: quote?.totalCents !== undefined ? dollars(quote.totalCents) : undefined,
    reasons: (row.reasons ?? []).map((c) => ({ code: c, meaning: explainReason(c) })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.budget === "joy") {
    // Sealed envelope: what was picked for the owner's joy budget stays out of chat.
    return { ...base, sealed: "joy purchase: items and note are hidden on purpose. Do not reveal or guess them." };
  }
  const notice = row.silent
    ? { silent: "no pre-order DM; the owner sees your whyNote when it is delivered" }
    : row.sealed
    ? { sealed: "the owner's DM shows only the amount and your hint; don't reveal the item in chat unless the owner asked for it" }
    : {};
  return { ...base, ...notice, items: row.items, reason: row.reason, requester: row.requester, taskId: row.taskId };
}

function ok(data: unknown, headline: string) {
  return { content: [{ type: "text" as const, text: `${headline}\n${JSON.stringify(data, null, 2)}` }] };
}
function fail(msg: string) {
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}
async function guarded<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    return fail(e instanceof GateError ? e.message : `unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Server ─────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "errand-joy-bot", version: VERSION });

const itemSchema = z.object({
  sku: z.string().min(1).max(128).describe("Vendor SKU / product id"),
  qty: z.number().int().min(1).max(1000),
  title: z.string().max(300).optional().describe("Human-readable product name"),
  url: z.string().max(2000).optional().describe("Product page URL"),
  maxUnitCents: z.number().int().min(0).optional().describe("Refuse if the unit price is above this (cents)"),
  message: z.string().min(1).max(500).optional().describe(
    "Text the vendor PRINTS (stannp: the postcard's back message). The owner sees it in every unsealed DM.",
  ),
  files: z.object({
    interior: z.string().max(2000).optional().describe("https URL of the interior PDF"),
    cover: z.string().max(2000).optional().describe("https URL of the cover PDF"),
  }).strict().optional().describe("Print files (lulu: interior + cover PDFs, both https)"),
  pageCount: z.number().int().min(1).max(1200).optional().describe("Interior page count (lulu: 2-1200)"),
  sizing: z.string().regex(/^[A-Za-z]{1,40}$/).optional().describe(
    "prodigi: fillPrintArea (default) | fitPrintArea | stretchToPrintArea",
  ),
  attributes: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/), z.string().max(80)).optional().describe(
    'prodigi: product attributes, e.g. {"color": "black"} (max 20 keys)',
  ),
  aoi: z.string().min(1).max(10_000).optional().describe(
    "skyfi: area of interest on the archive:<id> item, a WKT polygon 'POLYGON((lon lat, ...))'",
  ),
});

const requestShape = {
  vendor: z.string().min(1).max(64).describe("Vendor id from the gate's allowlist (e.g. 'mock' in a test gate)"),
  items: z.array(itemSchema).min(1).max(50),
  reason: z.string().min(1).max(1000).describe("Why you want this, honestly and specifically. Shown to the owner when the DM is not sealed; the why-note fallback."),
  whyNote: z.string().min(1).max(500).optional().describe(
    "The note the owner reads ON DELIVERY for silent, sealed and joy purchases: what it is and why you picked it, specific and warm. Falls back to `reason`.",
  ),
  hint: z.string().min(1).max(HINT_MAX_CHARS).optional().describe(
    `A teaser (max ${HINT_MAX_CHARS} chars) shown INSTEAD of the item in sealed DMs, e.g. "for clear nights". Must not contain any 4+ letter word from an item title (the gate returns 400). Default "something for you".`,
  ),
  reach: z.enum(["self", "world", "others"]).describe("Who this affects. Pick truthfully; 'others' always asks."),
  maxTotalCents: z.number().int().positive().describe("Your ceiling in cents including tax and shipping. The gate refuses to place above it."),
  budget: z.enum(["general", "joy"]).optional().describe("Default 'general'. 'joy' only for the weekly quiet-joy routine."),
  category: z.string().max(64).optional(),
  requester: z.string().min(1).max(64).optional().describe("Your agent name. Default 'claude-code'."),
  taskId: z.string().min(1).max(128).optional().describe("What task this is for. Default: a generated id."),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:\-]{1,128}$/).optional().describe("Leave empty to auto-generate."),
};
const statusShape = { requestId: z.string().regex(ID_RE).describe("The `id` returned by request_purchase") };
const listShape = { state: z.enum(STATES).optional().describe("One gate state; omit for all open requests") };
const budgetShape = { vendor: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional().describe("Also show this vendor's monthly cap") };

// The SDK's zod-compat types don't resolve under Deno's global npm cache, so handler
// args are typed explicitly from the same shapes.
type Args<S extends Record<string, z.ZodType>> = z.infer<z.ZodObject<S>>;

server.registerTool(
  "request_purchase",
  {
    title: "Ask the owner's purchase gate to buy something",
    description: [
      "Submit a purchase REQUEST to the owner's capped, ledgered purchase gate. This is the ONLY way to spend money:",
      "never call vendor APIs or checkout pages directly, and never try to approve your own request.",
      "",
      "Tiers are set by the vendor's QUOTED total (tax + shipping), not your estimate:",
      `  under ${dollars(SILENT_BELOW_CENTS)} (reach self/world): SILENT. Placed with no DM; the owner reads your whyNote on delivery.`,
      `  ${dollars(SILENT_BELOW_CENTS)} to ${dollars(AUTO_MAX_CENTS)}: automatic. The owner is notified first and has a short window to cancel.`,
      `  ${dollars(AUTO_MAX_CENTS)} to ${dollars(ASK_MAX_CENTS)}: the owner must tap Approve on a private link.`,
      `  ${dollars(ASK_MAX_CENTS + 1)} to ${dollars(FUND_MAX_CENTS)}: automatic only if the robot fund covers it (with a longer veto window).`,
      `  over ${dollars(FUND_MAX_CENTS)}: always refused.`,
      "Daily, monthly and per-vendor caps apply; a request that would exceed one is denied.",
      "Ask and fund DMs for reach self/world are SEALED: the owner sees the amount, caps and your `hint`, not the item,",
      "until the why-note arrives on delivery. So write a teasing `hint` that doesn't name the item, a real `whyNote`,",
      "and never reveal a sealed or silent pick in chat. Reach 'others' is never silent or sealed.",
      "",
      "reach, declared honestly: 'self' = only affects the owner; 'world' = affects the public or shared spaces;",
      "'others' = reaches another person (a gift, something in a housemate's space). 'others' ALWAYS needs the owner's approval.",
      "The vendor can raise reach but you can never lower it.",
      "",
      "budget 'joy' = the owner's small weekly surprise budget. Joy must be reach 'self', must land in the automatic tier",
      "(never asks), and is a sealed envelope: never name joy picks in chat. For joy, `whyNote` (else `reason`) is the note the owner reads on delivery.",
      "",
      "Returns the gate's row: a denial is a normal result with plain-English reasons, not an error.",
      "Every request gets an idempotencyKey (auto-generated if missing); reuse the SAME key only to retry the SAME payload.",
    ].join("\n"),
    inputSchema: requestShape,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args: Args<typeof requestShape>) =>
    guarded(async () => {
      const body = {
        idempotencyKey: args.idempotencyKey ?? `ejb-${crypto.randomUUID()}`,
        requester: args.requester ?? "claude-code",
        taskId: args.taskId ?? `task-${crypto.randomUUID().slice(0, 8)}`,
        vendor: args.vendor,
        items: args.items,
        reason: args.reason,
        reach: args.reach,
        maxTotalCents: args.maxTotalCents,
        budget: args.budget ?? "general",
        ...(args.category ? { category: args.category } : {}),
        ...(args.whyNote ? { whyNote: args.whyNote } : {}),
        ...(args.hint ? { hint: args.hint } : {}),
        // shipTo is deliberately not exposed: omitted means "the owner's configured home address".
      };
      const row = (await gate("POST", "/api/requests", body)) as Row;
      const shown = { idempotencyKey: body.idempotencyKey, ...present(row) };
      const headline = row.decision === "deny"
        ? `DENIED: ${(row.reasons ?? []).map(explainReason).join("; ") || "no reason given"}. Do not retry the same request; tell the user.`
        : row.decision === "ask"
        ? "Submitted. The owner must approve it from their private link; you cannot approve it. Check back with purchase_status."
        : row.silent
        ? "Submitted (silent tier). It is placed on the gate's next tick with no DM; the owner reads your whyNote on delivery. Don't reveal it in chat."
        : "Submitted. The owner is notified first and can cancel within the window; check back with purchase_status.";
      return ok(shown, headline);
    }),
);

server.registerTool(
  "purchase_status",
  {
    title: "Check one purchase request",
    description: "Get the current state of a request you submitted, with the gate's reasons in plain English. Joy requests stay sealed (items hidden).",
    inputSchema: statusShape,
    annotations: { readOnlyHint: true },
  },
  ({ requestId }: Args<typeof statusShape>) =>
    guarded(async () => {
      const row = (await gate("GET", `/api/requests/${encodeURIComponent(requestId)}`)) as Row;
      return ok(present(row), `Request ${requestId}: ${row.state ? STATE_TEXT[row.state] ?? row.state : "unknown state"}`);
    }),
);

server.registerTool(
  "list_purchases",
  {
    title: "List purchase requests",
    description: `List requests in one state. With no state, lists everything still open (${OPEN_STATES.join(", ")}). Joy requests stay sealed.`,
    inputSchema: listShape,
    annotations: { readOnlyHint: true },
  },
  ({ state }: Args<typeof listShape>) =>
    guarded(async () => {
      const states = state ? [state] : OPEN_STATES;
      const lists = await Promise.all(states.map((s) => gate("GET", `/api/requests?state=${encodeURIComponent(s)}`)));
      const rows = (lists.flat() as Row[]).map(present);
      return ok(rows, `${rows.length} request(s) in ${state ?? "open states"}`);
    }),
);

server.registerTool(
  "budget",
  {
    title: "Show spending windows and the robot fund",
    description: "Show how much of each spending window (day, month, joy week, per vendor) is used, and the robot fund balance. Check this before requesting so you don't ask for something a cap will deny.",
    inputSchema: budgetShape,
    annotations: { readOnlyHint: true },
  },
  ({ vendor }: Args<typeof budgetShape>) =>
    guarded(async () => {
      const [windows, fund] = await Promise.all([
        gate("GET", `/api/budgets${vendor ? `?vendor=${encodeURIComponent(vendor)}` : ""}`) as Promise<Record<string, { spentCents: number; capCents: number }>>,
        gate("GET", "/api/fund") as Promise<{ balanceCents: number }>,
      ]);
      const rows = Object.entries(windows ?? {}).map(([key, w]) => ({
        window: key,
        meaning: windowLabel(key),
        spent: dollars(w.spentCents),
        cap: dollars(w.capCents),
        left: dollars(Math.max(0, w.capCents - w.spentCents)),
      }));
      return ok({ windows: rows, robotFund: dollars(fund?.balanceCents) }, "Budget windows (in-flight requests count as spent):");
    }),
);

// NOTE: no approve, deny, stop, unstop, fund or rate tools, by design. Those are human-only.

await server.connect(new StdioServerTransport());
