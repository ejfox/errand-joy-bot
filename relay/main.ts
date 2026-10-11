// relay/main.ts — the approve relay: the ONLY internet-facing piece of the purchase gate.
// `export default { fetch }` (smallweb / Deno Deploy / `deno serve`); every async awaited.
// Treat every byte of every request as hostile. Never log URLs, tokens or bodies.
// Self-contained on purpose: deploy ONLY this folder; no parent-directory imports.
import { openStore, StoreUnavailable } from "./store.ts";
import type { ApprovalRecord, Backend, RelayStore } from "./store.ts";
import { approvalPage, donePage, messagePage, NEUTRAL_HTML, TOKEN_SCRIPT } from "./page.ts";

const MAX_BODY = 4096;
const RATE_LIMIT = 10; // per IP per minute on /a/*
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_KEYS = 10_000;
const MAX_EXPIRY_AHEAD_MS = 25 * 3600_000;
const MIN_RELAY_TOKEN_LEN = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/; // gate mints 32 bytes base64url (43 chars)
const LOOKUP_RE = /^[A-Za-z0-9_-]{16,64}$/; // gate mints 16 bytes base64url (22 chars)
const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const VENDOR_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const FUND_MAX_CENTS = 100_000; // default RELAY_MAX_CENTS; mirrors gate/types.ts (asserted in main_test.ts)
const MAX_SUMMARY = 1000; // the gate doesn't cap summary length; keep headroom under the 4KB body cap

/** CSP source for the page's single inline script: 'sha256-<base64 of sha256(TOKEN_SCRIPT)>'. */
export const SCRIPT_HASH_SOURCE = `'sha256-${
  btoa(String.fromCharCode(
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN_SCRIPT))),
  ))
}'`;

// Scripts: only that one hash (no 'unsafe-inline', no nonce, no sources). Everything else as before.
const CSP = `default-src 'none'; script-src ${SCRIPT_HASH_SOURCE}; style-src 'unsafe-inline'; ` +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// ── env / config ──────────────────────────────────────────────────────────
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function dataDir(): string {
  const fromEnv = env("RELAY_DATA_DIR");
  if (fromEnv) return fromEnv;
  const here = import.meta.dirname;
  return here ? `${here}/data` : "./data";
}

function relayToken(): string | null {
  let t = env("RELAY_TOKEN")?.trim();
  if (!t) {
    try {
      t = Deno.readTextFileSync(`${dataDir()}/.relay-token`).trim();
    } catch {
      t = undefined;
    }
  }
  return t && t.length >= MIN_RELAY_TOKEN_LEN ? t : null;
}

/** RELAY_STORE: "sqlite" (default) or "kv". Anything else → StoreUnavailable → 503 everywhere. */
function getStore(): Promise<RelayStore> {
  const raw = (env("RELAY_STORE")?.trim() || "sqlite").toLowerCase();
  if (raw !== "sqlite" && raw !== "kv") {
    return Promise.reject(new StoreUnavailable("bad RELAY_STORE"));
  }
  const backend: Backend = raw;
  return openStore({ backend, dataDir: dataDir(), kvPath: env("RELAY_KV_PATH")?.trim() || undefined });
}

/** RELAY_MAX_CENTS: positive integer upper bound on boundCents (default FUND_MAX_CENTS). */
function maxCents(): number {
  const raw = env("RELAY_MAX_CENTS")?.trim() ?? "";
  if (!/^\d{1,15}$/.test(raw)) return FUND_MAX_CENTS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : FUND_MAX_CENTS;
}

// ── helpers ───────────────────────────────────────────────────────────────
function respond(
  body: string | null,
  status: number,
  type: "html" | "json" | "text" = "html",
  extra: Record<string, string> = {},
): Response {
  const h = new Headers({
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": CSP,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": type === "html"
      ? "text/html; charset=utf-8"
      : type === "json"
      ? "application/json; charset=utf-8"
      : "text/plain; charset=utf-8",
    ...extra,
  });
  return new Response(body, { status, headers: h });
}

const neutral = (head = false) => respond(head ? null : NEUTRAL_HTML, 404);
const json = (v: unknown, status = 200) => respond(JSON.stringify(v), status, "json");
const methodNotAllowed = (allow: string) =>
  respond(messagePage("Not allowed", "Method not allowed."), 405, "html", { Allow: allow });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string equality: hash both sides, XOR-fold fixed-length digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  const ax = new Uint8Array(x), by = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ by[i];
  return diff === 0;
}

class TooLarge extends Error {}

/** Read the body with a hard cap; works for chunked bodies too (Content-Length can lie). */
async function readBody(req: Request): Promise<string> {
  const cl = req.headers.get("content-length");
  if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > MAX_BODY)) throw new TooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        await reader.cancel().catch(() => {});
        throw new TooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

// ── rate limit (in memory, fixed 1-minute window per IP) ──────────────────
const buckets = new Map<string, { start: number; count: number }>();

/**
 * RELAY_IP_HEADER picks the client-IP header: default cf-connecting-ip; x-forwarded-for uses
 * the right-most hop (the one your proxy appended); any other name is read as-is; "none" puts
 * everyone in one shared bucket.
 */
function clientKey(req: Request): string {
  const header = (env("RELAY_IP_HEADER")?.trim() || "cf-connecting-ip").toLowerCase();
  if (header === "none") return "_shared";
  let ip: string;
  try {
    ip = req.headers.get(header) ?? "";
  } catch {
    ip = ""; // not a valid header name: shared bucket
  }
  // Right-most hop: the one your trusted proxy appended. Earlier hops are client-supplied and spoofable.
  if (header === "x-forwarded-for") ip = ip.split(",").at(-1) ?? "";
  ip = ip.trim();
  // IPv4 / IPv6 charset only; anything else shares one bucket.
  return ip.length > 0 && ip.length <= 45 && /^[0-9A-Fa-f:.]+$/.test(ip) ? ip : "_shared";
}

function rateLimited(req: Request, now: number): boolean {
  const key = clientKey(req);
  let b = buckets.get(key);
  if (!b || now - b.start >= RATE_WINDOW_MS) {
    if (!b && buckets.size >= RATE_MAX_KEYS) {
      for (const [k, v] of buckets) if (now - v.start >= RATE_WINDOW_MS) buckets.delete(k);
      if (buckets.size >= RATE_MAX_KEYS) {
        // Still full of live buckets: under a spray. Fold newcomers into one shared bucket.
        const shared = buckets.get("_overflow") ?? { start: now, count: 0 };
        if (now - shared.start >= RATE_WINDOW_MS) {
          shared.start = now;
          shared.count = 0;
        }
        shared.count++;
        buckets.set("_overflow", shared);
        return shared.count > RATE_LIMIT;
      }
    }
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count++;
  return b.count > RATE_LIMIT;
}

/** Test helper. */
export function _resetRateLimit(): void {
  buckets.clear();
}

// ── /internal/pending validation ──────────────────────────────────────────
const ALLOWED_KEYS = new Set([
  "approvalId",
  "requestId",
  "denyTokenHash",
  "approveTokenHash",
  "denyLookupId",
  "approveLookupId",
  "vendor",
  "boundCents",
  "kind",
  "summary",
  "expiresAt",
  "usedAt",
  "verdict",
]);

// deno-lint-ignore no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

function validateRecord(v: unknown, now: Date): ApprovalRecord | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "not_object";
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) return "unknown_key";
  const {
    approvalId,
    requestId,
    denyTokenHash,
    approveTokenHash,
    denyLookupId,
    approveLookupId,
    vendor,
    boundCents,
    kind,
    summary,
    expiresAt,
  } = o;
  if (typeof approvalId !== "string" || !ID_RE.test(approvalId)) return "bad_approvalId";
  if (typeof requestId !== "string" || !ID_RE.test(requestId)) return "bad_requestId";
  if (typeof denyTokenHash !== "string" || !HASH_RE.test(denyTokenHash)) return "bad_denyTokenHash";
  if (kind !== "approve" && kind !== "veto") return "bad_kind";
  // approveTokenHash: required for kind=approve, forbidden (absent) for kind=veto.
  if (kind === "veto" && "approveTokenHash" in o) return "approveTokenHash_on_veto";
  if (kind === "approve") {
    if (typeof approveTokenHash !== "string" || !HASH_RE.test(approveTokenHash)) {
      return "bad_approveTokenHash";
    }
    if (approveTokenHash === denyTokenHash) return "same_token_hashes";
  }
  // Lookup ids follow the same rule: deny always, approve iff kind=approve, never equal.
  if (typeof denyLookupId !== "string" || !LOOKUP_RE.test(denyLookupId)) return "bad_denyLookupId";
  if (kind === "veto" && "approveLookupId" in o) return "approveLookupId_on_veto";
  if (kind === "approve") {
    if (typeof approveLookupId !== "string" || !LOOKUP_RE.test(approveLookupId)) {
      return "bad_approveLookupId";
    }
    if (approveLookupId === denyLookupId) return "same_lookup_ids";
  }
  if (typeof vendor !== "string" || !VENDOR_RE.test(vendor)) return "bad_vendor";
  if (
    typeof boundCents !== "number" || !Number.isSafeInteger(boundCents) || boundCents < 0 ||
    boundCents > maxCents()
  ) return "bad_boundCents";
  if (
    typeof summary !== "string" || summary.length === 0 || summary.length > MAX_SUMMARY ||
    BAD_CHARS.test(summary)
  ) return "bad_summary";
  if (typeof expiresAt !== "string" || expiresAt.length > 40) return "bad_expiresAt";
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return "bad_expiresAt";
  if (exp.getTime() > now.getTime() + MAX_EXPIRY_AHEAD_MS) return "expiresAt_too_far";
  for (const k of ["usedAt", "verdict"] as const) {
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "string") return `bad_${k}`;
  }
  return {
    approvalId,
    requestId,
    denyTokenHash,
    ...(kind === "approve" ? { approveTokenHash: approveTokenHash as string } : {}),
    denyLookupId,
    ...(kind === "approve" ? { approveLookupId: approveLookupId as string } : {}),
    vendor,
    boundCents,
    kind,
    summary,
    expiresAt: exp.toISOString(), // normalized so SQL string compares are correct
  };
}

// ── handlers ──────────────────────────────────────────────────────────────
async function handleInternal(req: Request, path: string, now: Date): Promise<Response> {
  const expected = relayToken();
  if (!expected) return json({ error: "relay_token_unset" }, 503);
  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!(await safeEqual(presented, expected)) || presented.length === 0) {
    return json({ error: "unauthorized" }, 401);
  }

  if (path === "/internal/pending") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) return json({ error: "bad_content_type" }, 415);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof TooLarge) return json({ error: "too_large" }, 413);
      return json({ error: "bad_json" }, 400);
    }
    const rec = validateRecord(parsed, now);
    if (typeof rec === "string") return json({ error: rec }, 400);
    const r = await (await getStore()).upsert(rec, now);
    if (r === "hash_conflict") return json({ error: "hash_conflict" }, 409);
    return json({ ok: true, status: r });
  }

  if (path === "/internal/verdicts") {
    if (req.method !== "GET") return methodNotAllowed("GET");
    const since = new URL(req.url).searchParams.get("since");
    let sinceIso = new Date(0).toISOString();
    if (since !== null && since !== "") {
      const d = new Date(since);
      if (since.length > 40 || Number.isNaN(d.getTime())) return json({ error: "bad_since" }, 400);
      sinceIso = d.toISOString();
    }
    // Approve verdicts carry their proof token on the first pull only (see store.ts).
    return json(await (await getStore()).verdictsSince(sinceIso, { now }));
  }

  return neutral();
}

/**
 * GET/HEAD /a/:lookupId. The path carries only the public lookupId (the token is in the link's
 * #fragment, which never reaches a server), so prefetchers and unfurlers see a page with an empty
 * token field and a disabled button. ZERO writes.
 */
async function handleView(req: Request, lookupId: string, now: Date): Promise<Response> {
  const head = req.method === "HEAD";
  if (req.method !== "GET" && !head) return methodNotAllowed("GET, HEAD");
  const found = LOOKUP_RE.test(lookupId) ? await (await getStore()).findByLookupId(lookupId) : null;
  if (!found || found.approval.usedAt !== null || found.approval.expiresAt <= now.toISOString()) {
    return neutral(head);
  }
  return respond(head ? null : approvalPage(found.approval, lookupId, found.role), 200);
}

const forbidden = () => respond(messagePage("Forbidden", "This request could not be verified."), 403);

/** POST /a/:lookupId/approve|deny with the form field `token` (filled in from the fragment). */
async function handleTap(
  req: Request,
  lookupId: string,
  verdict: "approve" | "deny",
  now: Date,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed("POST");
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/x-www-form-urlencoded")) {
    return respond(messagePage("Bad request", "Bad request."), 400);
  }
  let bodyToken = "";
  try {
    bodyToken = new URLSearchParams(await readBody(req)).get("token") ?? "";
  } catch (e) {
    if (e instanceof TooLarge) return respond(messagePage("Too large", "Request too large."), 413);
    return respond(messagePage("Bad request", "Bad request."), 400);
  }
  if (!LOOKUP_RE.test(lookupId)) return neutral();
  // Order inside tap(): unknown/used/expired → gone (neutral 404), other action → wrong_link (403),
  // then the token: missing (no JS), malformed or not this link's → bad_token (403). A 403 writes nothing.
  const hash = await sha256Hex(TOKEN_RE.test(bodyToken) ? bodyToken : "");
  // On approve, the plaintext approve token is kept as proof of tap for the gate (pulled once);
  // it is only stored on "ok", i.e. after it matched the stored hash.
  const r = await (await getStore()).tap(
    lookupId,
    hash,
    verdict,
    now,
    verdict === "approve" ? bodyToken : undefined,
  );
  if (r === "ok") return respond(donePage(verdict), 200);
  if (r === "bad_token") return forbidden(); // the token isn't this link's: nothing consumed
  if (r === "wrong_link") {
    // Each token does one thing; nothing was consumed.
    return respond(
      messagePage(
        "Not available",
        verdict === "approve"
          ? "This link can only deny, not approve."
          : "This link can only approve. To decline, use the Deny link from your message.",
      ),
      403,
    );
  }
  return neutral();
}

export async function handle(req: Request): Promise<Response> {
  const now = new Date();
  let path: string;
  try {
    path = new URL(req.url).pathname;
  } catch {
    return neutral();
  }

  // Fail closed on a misconfigured store: every route answers 503 (StoreUnavailable, below).
  await getStore();

  if (path.startsWith("/internal/")) return await handleInternal(req, path, now);

  if (path.startsWith("/a/")) {
    // A deny tap is never blocked: veto links mean "goes ahead unless the owner taps",
    // so a 429 there (e.g. an IP spray filling the overflow bucket) would fail OPEN
    // toward spending. It still counts toward the bucket.
    const isDeny = req.method === "POST" && /^\/a\/[^/]*\/deny$/.test(path);
    if (rateLimited(req, now.getTime()) && !isDeny) {
      return respond(messagePage("Slow down", "Too many requests. Try again in a minute."), 429, "html", {
        "Retry-After": "60",
      });
    }
    const parts = path.slice(3).split("/");
    if (parts.length === 1) return await handleView(req, parts[0], now);
    if (parts.length === 2 && (parts[1] === "approve" || parts[1] === "deny")) {
      return await handleTap(req, parts[0], parts[1], now);
    }
  }

  return neutral(req.method === "HEAD");
}

export default {
  async fetch(req: Request): Promise<Response> {
    try {
      return await handle(req);
    } catch (e) {
      if (e instanceof StoreUnavailable) {
        // Fail closed: no store, no taps, no publishes.
        console.error("relay: store unavailable (check RELAY_STORE / --unstable-kv)");
        return respond(messagePage("Unavailable", "Temporarily unavailable."), 503);
      }
      // Name only: messages can carry SQL or paths; URLs/bodies can carry tokens.
      console.error("relay: internal error", e instanceof Error ? e.name : "unknown");
      return respond(messagePage("Error", "Something went wrong."), 500);
    }
  },
};
