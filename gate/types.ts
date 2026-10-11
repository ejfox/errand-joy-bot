// errand-joy-bot gate: the shared contract. Every module imports from here.
// CONTRACT.md is the prose version; keep the two in sync.

// ── Policy DEFAULTS (code, never prompts) ─────────────────────────────────
// These are the defaults AND the hard ceilings: config.toml can only make them stricter.
// Loosening any of them needs `i_understand_the_risk = true` (see config.ts), and even then
// config.ts enforces an absolute maximum.
export const AUTO_MAX_CENTS = 6_900; // < $69 automatic (after a cancel window)
export const ASK_MAX_CENTS = 50_000; // $69–500 ask
export const FUND_MAX_CENTS = 100_000; // $500–1000 automatic ONLY if the robot fund covers it
// > FUND_MAX_CENTS is always refused.

export const DEFAULT_BUDGETS: Budget[] = [
  { key: "global/day", window: "day", capCents: 10_000 },
  { key: "global/month", window: "month", capCents: 25_000 }, // joy spend counts INSIDE this
  { key: "joy/week", window: "week", capCents: 4_000 },
];
export const DEFAULT_VENDOR_MONTH_CAP_CENTS = 10_000; // per-vendor/month

export const VELOCITY_LIMIT = 5; // > 5 requests in 10 min trips STOP
export const APPROVAL_TTL_MS = 24 * 3600_000;
export const AUTO_CANCEL_WINDOW_MS = 10 * 60_000; // pre-order DM → placing (auto tier)
export const FUND_VETO_WINDOW_MS = 2 * 3600_000; // pre-order DM → placing (fund_auto tier)
export const QUIET_HOURS = { start: "22:00", end: "07:30", tz: "America/New_York" };
export const DM_DOWN_STOP_MS = 24 * 3600_000; // DM path down this long → STOP
export const MIN_REASON_CHARS = 60; // intake refuses shorter `reason` text

// ── Notice policy (config [notify]) ───────────────────────────────────────
/** auto tier, reach self/world, quoted total < this → SILENT: no pre-order DM, no cancel window. */
export const SILENT_BELOW_CENTS = 4_000;
/** Ask and fund approval DMs for reach self/world never name the item (revealed on delivery). */
export const SEALED_DEFAULT = true;
/** Fallback hint in a sealed DM when the agent wrote none. */
export const DEFAULT_HINT = "something for you";
export const HINT_MAX_CHARS = 80;

export interface NoticePolicy {
  /** Silent tier ceiling (exclusive). 0 turns the silent tier off. */
  silentBelowCents: number;
  /** Seal ask / fund_auto DMs and relay summaries for reach self/world. */
  sealed: boolean;
}

export const DEFAULT_NOTICE: NoticePolicy = { silentBelowCents: SILENT_BELOW_CENTS, sealed: SEALED_DEFAULT };

/** The ShipTo literal for "the owner's own address" (config `owner_home_label`). */
export const OWNER_HOME = "owner-home";

/** Tier thresholds and switches policy.decide() runs with (built by config.ts). */
export interface PolicyLimits {
  autoMaxCents: number; // total < this → auto
  askMaxCents: number; // total <= this → ask
  fundEnabled: boolean;
  fundMaxCents: number; // total <= this → fund_auto (only when fundEnabled); above → refuse
  velocityLimit: number; // > this many requests in 10 min → deny + STOP
  joyEnabled: boolean;
}

export const DEFAULT_LIMITS: PolicyLimits = {
  autoMaxCents: AUTO_MAX_CENTS,
  askMaxCents: ASK_MAX_CENTS,
  fundEnabled: true,
  fundMaxCents: FUND_MAX_CENTS,
  velocityLimit: VELOCITY_LIMIT,
  joyEnabled: true,
};

// ── Core enums ────────────────────────────────────────────────────────────
/** Who an action reaches. Ordered: self < world < others. `others` ALWAYS asks. */
export type Reach = "self" | "world" | "others";
export const REACH_RANK: Record<Reach, number> = { self: 0, world: 1, others: 2 };

export type Tier = "auto" | "ask" | "fund_auto" | "refuse";
export type Decision = "auto" | "ask" | "deny";

export type State =
  | "received" // intake recorded
  | "quoted" // vendor dry-run total known
  | "decided" // policy ran on the QUOTED total
  | "dm_pending" // DM must be sent before anything else happens
  | "dm_delivered" // the DM transport returned 2xx + messageId
  | "pending_approval" // ask tier: waiting on the owner's tap
  | "approved" // auto window elapsed / owner approved / fund veto window elapsed
  | "denied"
  | "expired"
  | "placing"
  | "placed"
  | "outcome_unknown" // place() errored after the vendor call: money MAY have moved. Counts against windows.
  | "delivered"
  | "closed"
  | "cancelled"
  | "refunded"
  | "failed";

// ── Requests ──────────────────────────────────────────────────────────────
export interface Item {
  sku: string;
  qty: number;
  title?: string;
  url?: string;
  maxUnitCents?: number;
  /** Text printed on the item: a postcard's back message (Stannp). ≤ ITEM_MESSAGE_MAX chars. */
  message?: string;
  /** Print files, https URLs (Lulu: interior PDF + cover PDF). */
  files?: { interior?: string; cover?: string };
  /** Interior page count (Lulu). */
  pageCount?: number;
  /** How the image fills the print area (Prodigi: fillPrintArea | fitPrintArea | stretchToPrintArea). */
  sizing?: string;
  /** Product attributes (Prodigi, e.g. {color: "black"}). ≤ ITEM_ATTRIBUTES_MAX keys. */
  attributes?: Record<string, string>;
  /** Area of interest as a WKT polygon (SkyFi). ≤ ITEM_AOI_MAX chars. */
  aoi?: string;
}

export const ITEM_MESSAGE_MAX = 500;
export const ITEM_AOI_MAX = 10_000;
export const ITEM_PAGE_COUNT_MAX = 1200;
export const ITEM_ATTRIBUTES_MAX = 20;

export type ShipTo =
  | typeof OWNER_HOME
  | { name: string; line1: string; city: string; state: string; zip: string; phone?: string };

export interface PurchaseRequest {
  idempotencyKey: string; // UNIQUE; same key + different payload hash → STOP
  requester: string; // agent name
  taskId: string;
  vendor: string; // must be an enabled vendor (closed allowlist)
  items: Item[];
  reason: string; // why the agent wants this; shown to the owner. At least min_reason_chars.
  reach: Reach; // agent's declaration; effective = max(this, adapter.reachFor(req))
  maxTotalCents: number; // agent's ceiling incl. tax + shipping
  budget?: "general" | "joy";
  category?: string;
  shipTo?: ShipTo; // anything other than "owner-home" ⇒ reach "others" (enforced by guarded())
  /**
   * The note the owner reads ON DELIVERY for every silent or sealed purchase (joy included): what
   * it is and why the robot picked it. Never in a pre-order DM. Falls back to `reason`.
   */
  whyNote?: string;
  /**
   * A short teaser (max 80 chars) shown INSTEAD of the item in sealed DMs and relay pages. Must not
   * contain any item-title word of 4+ letters (intake rejects it). Default "something for you".
   */
  hint?: string;
}

export interface Quote {
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number; // tiers are computed on THIS, never the agent's estimate
  /** A vendor/API per-order fee (e.g. Zinc's $1). subtotal + tax + shipping + fee = total. */
  feeCents?: number;
  currency: "USD";
  vendorRef?: string;
  quotedAt: string; // ISO
  raw?: unknown;
}

export interface Order {
  vendorOrderId: string;
  chargedCents: number;
  /**
   * Vendor payload. The gate reads two optional fields from it (on place() and status()):
   * `links: string[]` (https delivery links: certificates, downloads, tracking; sanitized before
   * they are stored or DMed) and `blocked: string` (the order exists but waits on the owner at the
   * vendor, e.g. Prodigi "RequiresPaymentAuthorisation"; the owner gets ONE DM).
   */
  raw?: unknown;
}

export interface Charge {
  vendorChargeId: string;
  amountCents: number;
  at: string;
  vendorOrderId?: string;
}

// ── Policy (pure) ─────────────────────────────────────────────────────────
export interface WindowUsage {
  spentCents: number; // SUM over live requests in the window (never a stored counter)
  capCents: number;
}

export interface PolicyInput {
  totalCents: number; // quoted total
  vendor: string; // its `<vendor>/month` window must be present in `windows`
  reach: Reach; // agent-declared
  adapterReach: Reach; // adapter.reachFor(req)
  budget: "general" | "joy";
  fundBalanceCents: number;
  windows: Record<string, WindowUsage>; // keys like "global/day", "joy/week", "mock/month"
  requestsLast10m: number;
  stopped: boolean;
  vendorAllowed: boolean;
}

export interface PolicyResult {
  decision: Decision;
  tier: Tier;
  effectiveReach: Reach;
  reasons: string[]; // machine-readable codes, e.g. "reach_others", "window:global/day"
  holdFundCents?: number; // set when tier === "fund_auto"
  tripStop?: boolean; // velocity / integrity failure
}

// ── Vendors ───────────────────────────────────────────────────────────────
export interface VendorAdapter {
  id: string;
  maxReach: Reach;
  /** True only for adapters that never move real money (the mock). DRY_RUN refuses place() on all others. */
  readonly simulated?: boolean;
  reachFor(req: PurchaseRequest): Reach; // floor the agent cannot lower
  quote(req: PurchaseRequest): Promise<Quote>; // dry run, no money moves
  place(req: PurchaseRequest, q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order>;
  /** "failed" = the vendor gave up on the order (treated like "cancelled" by the gate). */
  status(
    vendorOrderId: string,
  ): Promise<{ state: "open" | "shipped" | "delivered" | "cancelled" | "failed"; tracking?: string; raw?: unknown }>;
  cancel(vendorOrderId: string): Promise<boolean>;
  listCharges(sinceISO: string): Promise<Charge[]>;
  pause(): Promise<void>; // kill-switch instrument step (pause card / disable key)
}

// ── Notifications: one private DM transport, fail closed ──────────────────
export interface DmResult {
  ok: boolean; // true only if 2xx AND messageId present
  messageId?: string;
  error?: string;
}
export interface Notifier {
  send(text: string): Promise<DmResult>;
}

// ── Approvals (gate half ↔ relay) ─────────────────────────────────────────
// Gate mints 256-bit tokens and stores only their sha256. Plaintext appears ONLY in DM URLs.
// Two SEPARATE tokens: a deny token (every record) and an approve token (ask tier only). Each DM
// link carries exactly one, so a deny link can never approve. A link is
// `<RELAY_PUBLIC_URL>/a/<lookupId>#<token>`: the lookupId is a random public id that only selects
// the record (it cannot approve), and the token sits in the URL fragment, which browsers never send
// to servers. Opening a link (or a link unfurler / prefetcher fetching it) therefore never gives the
// relay a token; the approve token reaches the relay only in the POST body when the owner taps
// Approve. Deny-only use never exposes it.
// Gate PUSHES the record (hashes, no tokens) to the relay and PULLS verdicts. Relay never calls the gate.
export interface ApprovalRecord {
  approvalId: string;
  requestId: string;
  denyTokenHash: string; // hex sha256 of the deny-link token (every kind)
  approveTokenHash?: string; // hex sha256 of the approve-link token; present iff kind === "approve"
  denyLookupId: string; // public id in the deny link's path (every kind); useless for approving
  approveLookupId?: string; // public id in the approve link's path; present iff kind === "approve"
  vendor: string;
  boundCents: number; // quoted total at mint time; a re-quote invalidates
  kind: "approve" | "veto"; // approve = ask tier; veto = deny-only link for auto / fund_auto / joy
  summary: string; // rendered on the page. Joy and sealed summaries must NOT name the item
  expiresAt: string;
  usedAt?: string;
  verdict?: "approve" | "deny";
}

export interface Verdict {
  approvalId: string;
  verdict: "approve" | "deny";
  at: string;
  /**
   * Proof of tap: the plaintext APPROVE token the relay received with an approve tap. The gate only
   * accepts an approve whose token hashes to its stored approveTokenHash; approves without it (or
   * carrying the deny token) are ignored, so a compromised relay can deny but never approve.
   * The relay returns it once.
   */
  token?: string;
}

export interface RelayClient {
  publish(a: ApprovalRecord): Promise<void>;
  pullVerdicts(sinceISO: string): Promise<Verdict[]>;
}

// ── Ledger ────────────────────────────────────────────────────────────────
export interface Budget {
  key: string;
  window: "day" | "week" | "month";
  capCents: number;
}

/**
 * Robot fund entry kinds. ONE sign convention everywhere (enforced by fund.ts and a CHECK in
 * schema.sql): topup, income, release, refund are POSITIVE; hold and spend are NEGATIVE.
 */
export type FundKind = "topup" | "income" | "hold" | "release" | "spend" | "refund";

export interface RequestRow {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  requester: string;
  taskId: string;
  vendor: string;
  budget: "general" | "joy";
  reachDeclared: Reach;
  reachEffective?: Reach;
  items: Item[];
  reason: string;
  maxTotalCents: number;
  category?: string;
  shipTo?: ShipTo;
  quote?: Quote;
  finalCents?: number;
  tier?: Tier;
  decision?: Decision;
  reasons?: string[];
  state: State;
  approver?: string;
  vendorOrderId?: string;
  dmMessageId?: string;
  dmAttempts: number;
  dmLastError?: string;
  whyNote?: string;
  hint?: string;
  /** Set at decide: no pre-order DM, no approval record; decided → approved directly. */
  silent?: boolean;
  /** Set at decide: the pre-order DM and relay summary never name the item. */
  sealed?: boolean;
  rating?: number; // owner's one-tap rating after delivery (learning signal)
  /** The most the gate authorized for this order (min of the bound quote and maxTotalCents), set at placing. */
  hardCapCents?: number;
  /** Sanitized https delivery links from the adapter (certificate, download, tracking). */
  links?: string[];
  /** Vendor-side block the owner must clear (adapter code, e.g. "RequiresPaymentAuthorisation"). */
  needsAction?: string;
  /** When the one "needs you" DM for `needsAction` was delivered. */
  needsActionDmAt?: string;
  createdAt: string;
  updatedAt: string;
}

export class IdempotencyConflict extends Error {}
export class IllegalTransition extends Error {}
export class StopActive extends Error {}
