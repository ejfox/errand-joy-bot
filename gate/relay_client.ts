// WP3 · gate → relay client. The gate PUSHES approval records (hash only, never a token) and PULLS
// verdicts. The relay never calls the gate.
import type { ApprovalRecord, RelayClient, Verdict } from "./types.ts";

const RELAY_TIMEOUT_MS = 10_000;
const MAX_VERDICTS = 1000;

export class RelayError extends Error {}
/** The relay refused to replace a record the owner has already tapped. */
export class RelayAlreadyDecided extends RelayError {}

export class HttpRelayClient implements RelayClient {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly relayToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const u = new URL(baseUrl);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
      throw new RelayError("relay base URL must be https (http allowed only for 127.0.0.1)");
    }
    if (!relayToken) throw new RelayError("RELAY_TOKEN missing");
    this.base = u.origin + u.pathname.replace(/\/+$/, "");
  }

  private headers(json = false): HeadersInit {
    const h: Record<string, string> = { "Authorization": `Bearer ${this.relayToken}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async publish(a: ApprovalRecord): Promise<void> {
    // Whitelist fields so nothing unexpected (e.g. a stray plaintext token) can ride along.
    const body: ApprovalRecord = {
      approvalId: a.approvalId,
      requestId: a.requestId,
      denyTokenHash: a.denyTokenHash,
      ...(a.kind === "approve" && a.approveTokenHash ? { approveTokenHash: a.approveTokenHash } : {}),
      denyLookupId: a.denyLookupId,
      ...(a.kind === "approve" && a.approveLookupId ? { approveLookupId: a.approveLookupId } : {}),
      vendor: a.vendor,
      boundCents: a.boundCents,
      kind: a.kind,
      summary: a.summary,
      expiresAt: a.expiresAt,
    };
    const HEX = /^[0-9a-f]{64}$/;
    const LOOKUP = /^[A-Za-z0-9_-]{22}$/;
    if (!HEX.test(body.denyTokenHash)) throw new RelayError("denyTokenHash must be sha256 hex");
    if (!LOOKUP.test(body.denyLookupId)) throw new RelayError("denyLookupId malformed");
    if (body.kind === "approve" && !HEX.test(body.approveTokenHash ?? "")) {
      throw new RelayError("approveTokenHash must be sha256 hex for kind=approve");
    }
    if (body.kind === "approve" && !LOOKUP.test(body.approveLookupId ?? "")) {
      throw new RelayError("approveLookupId malformed for kind=approve");
    }
    const res = await this.fetchImpl(`${this.base}/internal/pending`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new RelayError(`relay publish http_${res.status}`);
    }
    let status: unknown;
    try {
      status = ((await res.json()) as { status?: unknown })?.status;
    } catch {
      throw new RelayError("relay publish: bad response");
    }
    // Only "stored" means the relay now holds THESE hashes; anything else must not be DM'd.
    if (status === "already_decided") throw new RelayAlreadyDecided("relay record already decided");
    if (status !== "stored") throw new RelayError("relay publish: not stored");
  }

  async pullVerdicts(sinceISO: string): Promise<Verdict[]> {
    const res = await this.fetchImpl(
      `${this.base}/internal/verdicts?since=${encodeURIComponent(sinceISO)}`,
      { headers: this.headers(), signal: AbortSignal.timeout(RELAY_TIMEOUT_MS), redirect: "error" },
    );
    if (!res.ok) {
      await res.body?.cancel();
      throw new RelayError(`relay verdicts http_${res.status}`);
    }
    const body = await res.json();
    const list: unknown = Array.isArray(body) ? body : (body as { verdicts?: unknown })?.verdicts;
    if (!Array.isArray(list)) throw new RelayError("relay verdicts: bad shape");
    return list.slice(0, MAX_VERDICTS).filter(isVerdict).map((v) => {
      const token = (v as { token?: unknown }).token;
      return {
        approvalId: v.approvalId,
        verdict: v.verdict,
        at: v.at,
        // proof-of-tap for approves (Verdict.token); verified against approveTokenHash, never stored
        ...(typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) ? { token } : {}),
      };
    });
  }
}

export function isVerdict(v: unknown): v is Verdict {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.approvalId === "string" && o.approvalId.length <= 64 &&
    (o.verdict === "approve" || o.verdict === "deny") &&
    typeof o.at === "string" && !Number.isNaN(Date.parse(o.at));
}

/** In-memory relay for DRY_RUN and tests. */
export class FakeRelayClient implements RelayClient {
  published: ApprovalRecord[] = [];
  verdicts: Verdict[] = [];
  failPublish = false;
  publish(a: ApprovalRecord): Promise<void> {
    if (this.failPublish) return Promise.reject(new RelayError("fake relay down"));
    this.published = this.published.filter((p) => p.approvalId !== a.approvalId);
    this.published.push(structuredClone(a));
    return Promise.resolve();
  }
  pullVerdicts(sinceISO: string): Promise<Verdict[]> {
    return Promise.resolve(this.verdicts.filter((v) => v.at > sinceISO));
  }
  /** Test helper: simulate the owner tapping a button (approves carry the link's token as proof). */
  tap(approvalId: string, verdict: "approve" | "deny", at: Date, token?: string): void {
    this.verdicts.push({ approvalId, verdict, at: at.toISOString(), ...(token ? { token } : {}) });
  }
}
