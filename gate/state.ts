// The request state machine. Implements CONTRACT.md "State machine" exactly.
// Pure: callers (the ledger adapter in wiring.ts and the orchestrator) persist the transition and its events row.
import { IllegalTransition, type PolicyResult, type State, StopActive } from "./types.ts";

export const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  received: ["quoted", "failed", "cancelled"], // failed = the vendor quote failed
  quoted: ["decided", "denied", "cancelled"], // denied = bad quote / quote over the agent's maxTotalCents
  decided: ["denied", "dm_pending", "approved", "cancelled"], // approved = silent tier only
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
  /** For delivered → closed: must be true when budget is joy or the row is silent/sealed; false always blocks. */
  whyNoteDelivered?: boolean;
  budget?: "general" | "joy";
  /** The row's persisted silent flag. decided → approved needs it; approved → placing without a DM needs it. */
  silent?: boolean;
  /** The row's persisted sealed flag (delivered → closed then needs the why-note). */
  sealed?: boolean;
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
  if (from === "decided" && to === "approved" && ctx.silent !== true) {
    throw new IllegalTransition("decided → approved is the silent tier only");
  }
  if (from === "approved" && to === "placing" && ctx.redecide && !canPlace(ctx.redecide)) {
    throw new IllegalTransition("placing requires a non-deny re-decide (policy_changed)");
  }
  // Fail closed: a non-silent purchase never reaches placing without a delivered DM.
  if (from === "approved" && to === "placing" && ctx.silent !== true && !ctx.messageId) {
    throw new IllegalTransition("placing requires a delivered DM (messageId) unless the row is silent");
  }
  if (
    from === "delivered" && to === "closed" &&
    (ctx.whyNoteDelivered === false || (needsWhyNote(ctx) && !ctx.whyNoteDelivered))
  ) {
    throw new IllegalTransition("closed requires the why-note DM to be delivered");
  }
}

/** Joy, silent and sealed purchases close only after the delivery why-note DM has a messageId. */
export function needsWhyNote(ctx: Pick<TransitionCtx, "budget" | "silent" | "sealed">): boolean {
  return ctx.budget === "joy" || ctx.silent === true || ctx.sealed === true;
}

/** Where a request goes once decide() has run on the quoted total (silent rows skip the DM). */
export function nextAfterDecide(result: PolicyResult, silent = false): State {
  if (result.decision === "deny") return "denied";
  return silent && result.decision === "auto" ? "approved" : "dm_pending";
}

/** approved → placing only if re-decide() at that moment is not deny. */
export function canPlace(redecide: PolicyResult): boolean {
  return redecide.decision !== "deny";
}

/** Next state from `approved`: placing, or denied (policy_changed). */
export function nextAfterApproved(redecide: PolicyResult): "placing" | "denied" {
  return canPlace(redecide) ? "placing" : "denied";
}
