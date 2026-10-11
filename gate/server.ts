// Gate HTTP. main.ts binds it to GATE_HOST:GATE_PORT (loopback or tailnet only). Two bearer
// tokens: agent (/api/*) and admin (/internal/*).
import { Hono } from "@hono/hono";
import type { Context, MiddlewareHandler } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import { IdempotencyConflict, IllegalTransition, type State, StopActive } from "./types.ts";
import { timingSafeEqualStr } from "./approval.ts";
import { type LedgerPort, type Orchestrator, QuoteError, ValidationError } from "./orchestrator.ts";

export interface ServerDeps {
  orch: Orchestrator;
  ledger: LedgerPort;
  agentToken: string;
  adminToken: string;
  now?: () => Date;
  reconcile?: () => Promise<unknown>;
}

const MIN_TOKEN_LEN = 32;
const STATES: State[] = [
  "received", "quoted", "decided", "dm_pending", "dm_delivered", "pending_approval", "approved", "denied",
  "expired", "placing", "placed", "outcome_unknown", "delivered", "closed", "cancelled", "refunded", "failed",
];
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Bearer check. An unset/short expected token means every request is refused (never "matches empty"). */
export function bearer(expected: string): MiddlewareHandler {
  const usable = typeof expected === "string" && expected.length >= MIN_TOKEN_LEN;
  return async (c, next) => {
    const h = c.req.header("Authorization") ?? "";
    const m = /^Bearer ([^\s]+)$/.exec(h);
    const ok = usable && m !== null && (await timingSafeEqualStr(m[1], expected));
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

function fail(c: Context, err: unknown) {
  if (err instanceof ValidationError) {
    return c.json({ error: err.message }, err.message === "not_found" ? 404 : 400);
  }
  if (err instanceof StopActive) return c.json({ error: "stopped" }, 503);
  if (err instanceof IdempotencyConflict) return c.json({ error: "idempotency_conflict" }, 409);
  if (err instanceof IllegalTransition) return c.json({ error: "illegal_transition" }, 409);
  if (err instanceof QuoteError) return c.json({ error: "quote_failed" }, 502);
  return c.json({ error: "internal" }, 500);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError("invalid json");
  }
}

export function createApp(deps: ServerDeps): Hono {
  if (deps.agentToken && deps.agentToken === deps.adminToken) {
    throw new Error("GATE_AGENT_TOKEN and GATE_ADMIN_TOKEN must differ");
  }
  const { orch, ledger } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });
  app.use("*", bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }));
  app.onError((err, c) => fail(c, err));
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // ── health: {ok, stopped} and nothing else ──
  app.get("/health", async (c) => {
    let stopped = true;
    try {
      stopped = Boolean(await ledger.isStopped());
    } catch { /* unknown → report stopped */ }
    return c.json({ ok: true, stopped });
  });

  // ── agent API ──
  const api = new Hono();
  api.use("*", bearer(deps.agentToken));
  api.post("/requests", async (c) => {
    const row = await orch.submit(await readJson(c));
    return c.json(row, 201);
  });
  api.get("/requests/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new ValidationError("not_found");
    const row = await ledger.getRequest(id);
    if (!row) throw new ValidationError("not_found");
    return c.json(row);
  });
  api.get("/requests", async (c) => {
    const state = c.req.query("state") as State | undefined;
    if (!state || !STATES.includes(state)) throw new ValidationError("state query param required");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
    return c.json((await ledger.listByState(state)).slice(-limit));
  });
  api.post("/requests/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new ValidationError("not_found");
    return c.json(await orch.cancel(id));
  });
  api.get("/budgets", async (c) => {
    const vendor = c.req.query("vendor");
    if (vendor !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(vendor)) throw new ValidationError("vendor invalid");
    const w = await ledger.windowsFor(vendor ?? "_none", "joy", now());
    if (!vendor) delete w["_none/month"];
    return c.json(w);
  });
  api.get("/fund", async (c) => c.json({ balanceCents: await ledger.fundBalance() }));
  app.route("/api", api);

  // ── admin / cron ──
  const internal = new Hono();
  internal.use("*", bearer(deps.adminToken));
  internal.post("/tick", async (c) => c.json(await orch.tick()));
  internal.post("/reconcile", async (c) => {
    if (!deps.reconcile) return c.json({ error: "not_configured" }, 501);
    return c.json((await deps.reconcile()) ?? { ok: true });
  });
  internal.post("/fund/entries", async (c) => {
    const b = (await readJson(c)) as Record<string, unknown> | null;
    const kind = b?.kind;
    const cents = b?.cents;
    const note = b?.note;
    if (kind !== "topup" && kind !== "income") throw new ValidationError("kind must be topup or income");
    if (!Number.isSafeInteger(cents) || (cents as number) <= 0 || (cents as number) > 1_000_000) {
      throw new ValidationError("cents must be a positive integer ≤ 1000000");
    }
    if (note !== undefined && (typeof note !== "string" || note.length > 200)) throw new ValidationError("note invalid");
    await ledger.addFundEntry({ kind, cents: cents as number, ...(note ? { note: note as string } : {}) }, now());
    return c.json({ ok: true, balanceCents: await ledger.fundBalance() }, 201);
  });
  internal.post("/stop", async (c) => {
    let reason = "manual";
    try {
      const b = await c.req.json();
      if (typeof b?.reason === "string" && /^[\w .:-]{1,80}$/.test(b.reason)) reason = b.reason;
    } catch { /* body optional */ }
    await orch.stop(reason);
    return c.json({ ok: true, stopped: true });
  });
  internal.delete("/stop", async (c) => {
    await orch.clearStop();
    return c.json({ ok: true, stopped: false });
  });
  internal.post("/rate/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new ValidationError("not_found");
    const b = (await readJson(c)) as Record<string, unknown> | null;
    return c.json(await orch.rate(id, b?.rating as number));
  });
  // Settle an outcome_unknown row once reconcile or the vendor dashboard says what happened.
  internal.post("/resolve/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new ValidationError("not_found");
    const b = (await readJson(c)) as Record<string, unknown> | null;
    const outcome = b?.outcome;
    if (outcome !== "placed" && outcome !== "failed") throw new ValidationError("outcome must be placed or failed");
    const order = outcome === "placed"
      ? { vendorOrderId: String(b?.vendorOrderId ?? "").slice(0, 128), chargedCents: b?.chargedCents as number }
      : undefined;
    return c.json(await orch.resolveUnknown(id, outcome, order));
  });
  app.route("/internal", internal);

  return app;
}

export const GATE_HOST = "127.0.0.1";
export const GATE_PORT = 47400;

export function serve(
  deps: ServerDeps,
  opts: { hostname?: string; port?: number; signal?: AbortSignal } = {},
): Deno.HttpServer {
  return Deno.serve(
    { hostname: opts.hostname ?? GATE_HOST, port: opts.port ?? GATE_PORT, signal: opts.signal, onListen() {} },
    createApp(deps).fetch,
  );
}
