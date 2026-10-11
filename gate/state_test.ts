import { assertEquals, assertThrows } from "@std/assert";
import {
  assertTransition,
  canPlace,
  isTerminal,
  nextAfterApproved,
  nextAfterDecide,
  STOP_SAFE,
  TRANSITIONS,
  type TransitionCtx,
} from "./state.ts";
import { IllegalTransition, type PolicyResult, type State, StopActive } from "./types.ts";

const ALL: State[] = Object.keys(TRANSITIONS) as State[];
// `silent: true` so the silent-only edge (decided → approved) counts as legal in the table sweep.
const go: TransitionCtx = { stopped: false, messageId: "m1", whyNoteDelivered: true, silent: true };
const result = (decision: PolicyResult["decision"]): PolicyResult => ({
  decision,
  tier: "auto",
  effectiveReach: "self",
  reasons: [],
});

const LEGAL: [State, State][] = [
  ["received", "quoted"],
  ["received", "failed"],
  ["received", "cancelled"],
  ["quoted", "decided"],
  ["quoted", "denied"],
  ["quoted", "cancelled"],
  ["decided", "denied"],
  ["decided", "dm_pending"],
  ["decided", "approved"], // silent tier only
  ["decided", "cancelled"],
  ["dm_pending", "dm_delivered"],
  ["dm_pending", "expired"],
  ["dm_pending", "denied"],
  ["dm_pending", "cancelled"],
  ["dm_delivered", "pending_approval"],
  ["dm_delivered", "approved"],
  ["dm_delivered", "cancelled"],
  ["pending_approval", "approved"],
  ["pending_approval", "denied"],
  ["pending_approval", "expired"],
  ["pending_approval", "cancelled"],
  ["approved", "placing"],
  ["approved", "denied"],
  ["approved", "cancelled"],
  ["placing", "placed"],
  ["placing", "failed"],
  ["placing", "outcome_unknown"],
  ["outcome_unknown", "placed"],
  ["outcome_unknown", "failed"],
  ["placed", "delivered"],
  ["placed", "cancelled"],
  ["placed", "refunded"],
  ["delivered", "closed"],
];
const isLegal = (f: State, t: State) => LEGAL.some(([a, b]) => a === f && b === t);

Deno.test("table matches the contract exactly", () => {
  const fromTable = ALL.flatMap((f) => TRANSITIONS[f].map((t) => [f, t] as [State, State]));
  assertEquals(fromTable.length, LEGAL.length);
  for (const [f, t] of fromTable) assertEquals(isLegal(f, t), true, `${f} → ${t}`);
});

for (const from of ALL) {
  for (const to of ALL) {
    const legal = isLegal(from, to);
    Deno.test(`${from} → ${to} ${legal ? "allowed" : "throws"}`, () => {
      if (legal) assertTransition(from, to, go);
      else assertThrows(() => assertTransition(from, to, go), IllegalTransition);
    });
  }
}

Deno.test("placing is only reachable from approved", () => {
  assertEquals(ALL.filter((f) => TRANSITIONS[f].includes("placing")), ["approved"]);
  assertEquals(ALL.filter((f) => TRANSITIONS[f].includes("approved")), ["decided", "dm_delivered", "pending_approval"]);
  assertEquals(ALL.filter((f) => TRANSITIONS[f].includes("pending_approval")), ["dm_delivered"]);
});

Deno.test("decided → approved is the silent tier only", () => {
  assertThrows(() => assertTransition("decided", "approved", { stopped: false }), IllegalTransition);
  assertThrows(() => assertTransition("decided", "approved", { stopped: false, silent: false }), IllegalTransition);
  assertThrows(() => assertTransition("decided", "approved", { stopped: true, silent: true }), StopActive);
  assertTransition("decided", "approved", { stopped: false, silent: true });
});

Deno.test("approved → placing needs a delivered DM unless the row is silent", () => {
  const ok = result("auto");
  assertThrows(() => assertTransition("approved", "placing", { stopped: false, redecide: ok }), IllegalTransition);
  assertThrows(
    () => assertTransition("approved", "placing", { stopped: false, redecide: ok, silent: false, sealed: true }),
    IllegalTransition,
  );
  assertTransition("approved", "placing", { stopped: false, redecide: ok, messageId: "m1" });
  assertTransition("approved", "placing", { stopped: false, redecide: ok, silent: true });
});

Deno.test("dm_pending → dm_delivered needs a messageId", () => {
  assertThrows(() => assertTransition("dm_pending", "dm_delivered", { stopped: false }), IllegalTransition);
  assertThrows(() => assertTransition("dm_pending", "dm_delivered", { stopped: false, messageId: "" }), IllegalTransition);
  assertTransition("dm_pending", "dm_delivered", { stopped: false, messageId: "123" });
});

Deno.test("STOP blocks everything except halting money or recording what a vendor already did", () => {
  assertEquals([...STOP_SAFE].sort(), ["cancelled", "denied", "expired", "failed", "outcome_unknown", "placed", "refunded"]);
  // Nothing that moves a request TOWARD spending is STOP-safe.
  for (const s of ["quoted", "decided", "dm_pending", "dm_delivered", "pending_approval", "approved", "placing"] as State[]) {
    assertEquals(STOP_SAFE.has(s), false, s);
  }
  for (const [from, to] of LEGAL) {
    const ctx = { ...go, stopped: true };
    if (STOP_SAFE.has(to)) assertTransition(from, to, ctx);
    else assertThrows(() => assertTransition(from, to, ctx), StopActive, undefined, `${from} → ${to}`);
  }
});

Deno.test("STOP does not make an illegal transition legal", () => {
  assertThrows(() => assertTransition("received", "denied", { stopped: true }), IllegalTransition);
  assertThrows(() => assertTransition("closed", "cancelled", { stopped: true }), IllegalTransition);
});

const closeCases: { name: string; ctx: TransitionCtx; ok: boolean }[] = [
  { name: "joy with why-note", ctx: { stopped: false, budget: "joy", whyNoteDelivered: true }, ok: true },
  { name: "joy without why-note", ctx: { stopped: false, budget: "joy" }, ok: false },
  { name: "joy why-note false", ctx: { stopped: false, budget: "joy", whyNoteDelivered: false }, ok: false },
  { name: "general immediately", ctx: { stopped: false, budget: "general" }, ok: true },
  { name: "no budget given", ctx: { stopped: false }, ok: true },
  { name: "explicit why-note false", ctx: { stopped: false, whyNoteDelivered: false }, ok: false },
  { name: "silent without why-note", ctx: { stopped: false, budget: "general", silent: true }, ok: false },
  { name: "silent with why-note", ctx: { stopped: false, silent: true, whyNoteDelivered: true }, ok: true },
  { name: "sealed without why-note", ctx: { stopped: false, budget: "general", sealed: true }, ok: false },
  { name: "sealed with why-note", ctx: { stopped: false, sealed: true, whyNoteDelivered: true }, ok: true },
  { name: "open (neither) closes immediately", ctx: { stopped: false, silent: false, sealed: false }, ok: true },
];
for (const c of closeCases) {
  Deno.test(`delivered → closed: ${c.name}`, () => {
    if (c.ok) assertTransition("delivered", "closed", c.ctx);
    else assertThrows(() => assertTransition("delivered", "closed", c.ctx), IllegalTransition);
  });
}

Deno.test("approved → placing re-decide gate", () => {
  assertThrows(
    () => assertTransition("approved", "placing", { stopped: false, redecide: result("deny") }),
    IllegalTransition,
  );
  assertTransition("approved", "placing", { stopped: false, messageId: "m1", redecide: result("auto") });
  assertTransition("approved", "placing", { stopped: false, messageId: "m1", redecide: result("ask") });
  assertTransition("approved", "denied", { stopped: false, redecide: result("deny") });
});

Deno.test("nextAfterDecide / canPlace / nextAfterApproved", () => {
  assertEquals(nextAfterDecide(result("deny")), "denied");
  assertEquals(nextAfterDecide(result("auto")), "dm_pending");
  assertEquals(nextAfterDecide(result("ask")), "dm_pending");
  assertEquals(nextAfterDecide(result("auto"), true), "approved");
  assertEquals(nextAfterDecide(result("ask"), true), "dm_pending");
  assertEquals(nextAfterDecide(result("deny"), true), "denied");
  assertEquals(canPlace(result("deny")), false);
  assertEquals(canPlace(result("ask")), true);
  assertEquals(nextAfterApproved(result("deny")), "denied");
  assertEquals(nextAfterApproved(result("auto")), "placing");
});

Deno.test("terminal states", () => {
  assertEquals(ALL.filter(isTerminal).sort(), ["cancelled", "closed", "denied", "expired", "failed", "refunded"]);
});
