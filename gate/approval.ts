// WP3 · approval tokens (gate half).
// The gate mints a 256-bit token, stores ONLY sha256(token), and puts the plaintext in exactly one
// place: the FRAGMENT of the DM URL (`/a/<lookupId>#<token>`), which browsers never send to a
// server. Nothing here logs, and nothing here persists the plaintext.
import { APPROVAL_TTL_MS, type ApprovalRecord } from "./types.ts";

/** Public relay origin from RELAY_PUBLIC_URL, e.g. "https://approve.example.com". Must be https. */
export function relayPublicUrl(): string {
  let v: string | undefined;
  try {
    v = Deno.env.get("RELAY_PUBLIC_URL")?.trim();
  } catch { /* no env permission */ }
  if (!v) throw new Error("RELAY_PUBLIC_URL is not set");
  return v;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 CSPRNG bytes, base64url, no padding (43 chars). */
export function mintToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 16 CSPRNG bytes, base64url (22 chars): the public id in a link's path. Not a credential. */
export function mintLookupId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Hex sha256 of the plaintext token (WebCrypto). */
export async function hashToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

/**
 * Constant-time string equality. Both sides are sha256'd first, so the comparison runs over
 * 32 bytes regardless of input length and a length mismatch leaks nothing.
 */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Is this plaintext token the record's APPROVE token? (constant-time). The deny token never
 * verifies, and a record without an approve token (veto kind) never verifies.
 */
export async function verifyApproveToken(token: string, record: ApprovalRecord): Promise<boolean> {
  if (record.kind !== "approve" || !record.approveTokenHash) return false;
  return timingSafeEqualStr(await hashToken(token), record.approveTokenHash);
}

/**
 * `<RELAY_PUBLIC_URL>/a/<lookupId>#<token>`. The lookupId selects the record; the token rides in
 * the fragment, so GETs of the link (unfurlers, previews, access logs) never see it. The base must
 * be https with no credentials, query or fragment.
 */
export function approvalUrl(lookupId: string, token: string, baseUrl: string = relayPublicUrl()): string {
  const u = new URL(baseUrl);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) {
    throw new Error("relay public URL must be a plain https URL");
  }
  if (!/^[A-Za-z0-9_-]{22}$/.test(lookupId)) throw new Error("malformed lookup id");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("malformed token");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}/a/${lookupId}#${token}`;
}

export interface BuildApprovalInput {
  requestId: string;
  vendor: string;
  boundCents: number; // quoted total at mint time
  kind: "approve" | "veto";
  summary: string;
  now: Date;
  approvalId?: string; // reuse on DM retry so the relay upserts instead of piling up records
  ttlMs?: number;
}

export interface MintedApproval {
  denyToken: string;
  /** Present iff kind === "approve". */
  approveToken?: string;
  record: ApprovalRecord;
}

/**
 * Mint fresh tokens and the record that binds them: a deny token and lookupId always, an approve
 * token and lookupId only for kind "approve". The caller gets the plaintext tokens back exactly
 * once, to build the DM URLs; they must not be stored or logged. The record holds the hashes and
 * the (public) lookupIds only.
 */
export async function buildApprovalRecord(input: BuildApprovalInput): Promise<MintedApproval> {
  if (!Number.isSafeInteger(input.boundCents) || input.boundCents < 0) {
    throw new Error("boundCents must be a non-negative integer");
  }
  const denyToken = mintToken();
  const approveToken = input.kind === "approve" ? mintToken() : undefined;
  const record: ApprovalRecord = {
    approvalId: input.approvalId ?? crypto.randomUUID(),
    requestId: input.requestId,
    denyTokenHash: await hashToken(denyToken),
    ...(approveToken ? { approveTokenHash: await hashToken(approveToken) } : {}),
    denyLookupId: mintLookupId(),
    ...(approveToken ? { approveLookupId: mintLookupId() } : {}),
    vendor: input.vendor,
    boundCents: input.boundCents,
    kind: input.kind,
    summary: input.summary,
    expiresAt: new Date(input.now.getTime() + (input.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
  };
  return { denyToken, ...(approveToken ? { approveToken } : {}), record };
}

export interface BindingCheck {
  requestId: string;
  vendor: string;
  quoteTotalCents: number; // the CURRENT quote, re-fetched right before placing
  now?: Date;
  requireUnused?: boolean; // default false: a consumed approve record is the normal pre-place state
}

export type BindingResult = { ok: true } | { ok: false; reason: string };

/**
 * The approval is only good for the exact request, vendor and amount the owner saw.
 * A re-quote that moves the total by even one cent invalidates it (reason `quote_changed`).
 */
export function verifyBinding(record: ApprovalRecord, check: BindingCheck): BindingResult {
  if (record.requestId !== check.requestId) return { ok: false, reason: "binding_request" };
  if (record.vendor !== check.vendor) return { ok: false, reason: "binding_vendor" };
  if (!Number.isSafeInteger(check.quoteTotalCents) || record.boundCents !== check.quoteTotalCents) {
    return { ok: false, reason: "quote_changed" };
  }
  if (check.requireUnused && record.usedAt) return { ok: false, reason: "binding_used" };
  if (check.now && record.kind === "approve" && !record.usedAt) {
    if (check.now.getTime() > Date.parse(record.expiresAt)) return { ok: false, reason: "binding_expired" };
  }
  return { ok: true };
}
