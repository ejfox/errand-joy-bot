// The request state machine. Implements CONTRACT.md "State machine" exactly.
// Pure: callers (the ledger adapter in wiring.ts and the orchestrator) persist the transition and its events row.
import { IllegalTransition, type PolicyResult, type State, StopActive } from "./types.ts";

export const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  received: ["quoted", "failed", "cancelled"], // failed = the vendor quote failed
  quoted: ["decided", "denied", "cancelled"], // denied = bad quote / quote over the agent's maxTotalCents
  decided: ["denied", "dm_pending", "cancelled"],
  dm_pending: ["dm_delivered", "expired", "denied", "cancelled"],
  dm_delivered: ["pending_approval", "approved", "cancelled"],
  pending_approval: ["approved", "denied", "expired", "cancelled"],
  approved: ["placing", "denied", "cancelled"],
  placing: ["placed", "failed", "outcome_unknown"],
  // place() errored after calling the vendor: resolved by reconcile or a human.
  outcome_unknown: ["placed", "failed"],
  placed: ["delivered", "cancelled", "refunded"],
  delivered: ["closed"],
  // terminal
  denied: [],
  expired: [],
  cancelled: [],
  refunded: [],
  failed: [],
  closed: [],
};

/**
 * Targets still allowed while STOP is set. They either halt money (denied, cancelled, expired,
 * failed) or record what a vendor already did (placed, outcome_unknown, refunded): STOP must never
 * stop the ledger from telling the truth about money that already moved.
 */
export const STOP_SAFE: ReadonlySet<State> = new Set([
  "denied",
  "cancelled",
  "expired",
  "failed",
  "placed",
  "outcome_unknown",
  "refunded",
]);

export interface TransitionCtx {
  stopped: boolean;
  /** Required for dm_pending → dm_delivered. */
  messageId?: string;
  /** For delivered → closed: must be true when budget is joy; false always blocks. */
  whyNoteDelivered?: boolean;
  budget?: "general" | "joy";
  /** For approved → placing: if supplied, a deny result blocks the transition. */
  redecide?: PolicyResult;
}

export function isTerminal(s: State): boolean {
  return TRANSITIONS[s].length === 0;
}

export function assertTransition(from: State, to: State, ctx: TransitionCtx): void {
  if (!TRANSITIONS[from].includes(to)) throw new IllegalTransition(`${from} → ${to}`);
  if (ctx.stopped && !STOP_SAFE.has(to)) throw new StopActive(`${from} → ${to} blocked by STOP`);

  if (from === "dm_pending" && to === "dm_delivered" && !ctx.messageId) {
    throw new IllegalTransition("dm_delivered requires messageId");
  }
  if (from === "approved" && to === "placing" && ctx.redecide && !canPlace(ctx.redecide)) {
    throw new IllegalTransition("placing requires a non-deny re-decide (policy_changed)");
  }
  if (
    from === "delivered" && to === "closed" &&
    (ctx.whyNoteDelivered === false || (ctx.budget === "joy" && !ctx.whyNoteDelivered))
  ) {
    throw new IllegalTransition("closed requires the why-note DM to be delivered");
  }
}

/** Where a request goes once decide() has run on the quoted total. */
export function nextAfterDecide(result: PolicyResult): State {
  return result.decision === "deny" ? "denied" : "dm_pending";
}

/** approved → placing only if re-decide() at that moment is not deny. */
export function canPlace(redecide: PolicyResult): boolean {
  return redecide.decision !== "deny";
}

/** Next state from `approved`: placing, or denied (policy_changed). */
export function nextAfterApproved(redecide: PolicyResult): "placing" | "denied" {
  return canPlace(redecide) ? "placing" : "denied";
}
