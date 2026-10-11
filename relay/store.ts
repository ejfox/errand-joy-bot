// relay/store.ts — the relay's storage: published ApprovalRecords, taps, verdicts.
// Two backends behind one async interface:
//   - SqliteStore: node:sqlite at <RELAY_DATA_DIR or ./data>/relay.db (default; smallweb, any VPS)
//   - KvStore:     Deno KV via Deno.openKv(path?) (Deno Deploy, which has no writable disk)
// Every record has a deny-token hash and (kind=approve only) an approve-token hash; each link
// in the owner's message carries exactly one token, and each token does exactly one thing.
// Records hold token HASHES only. The one exception is the proof-of-tap token: the plaintext
// APPROVE token submitted with an approve tap is kept until the gate pulls it (returned once)
// or for at most PROOF_TTL_MS after the tap, whichever comes first.

// Local mirrors of gate/types.ts shapes so the relay deploys as a self-contained folder
// (no ../ import). main_test.ts asserts these stay assignable to/from the shared contract.
export interface ApprovalRecord {
  approvalId: string;
  requestId: string;
  denyTokenHash: string;
  approveTokenHash?: string;
  vendor: string;
  boundCents: number;
  kind: "approve" | "veto";
  summary: string;
  expiresAt: string;
  usedAt?: string;
  verdict?: "approve" | "deny";
}
export interface Verdict {
  approvalId: string;
  verdict: "approve" | "deny";
  at: string;
  /** Plaintext APPROVE token from an approve tap. Returned at most once, never on deny. */
  token?: string;
}

const RETENTION_MS = 30 * 24 * 3600_000; // prune records this long past expiry / tap
export const PROOF_TTL_MS = 24 * 3600_000; // proof tokens older than this (after the tap) are dropped
const DEFAULT_PAGE = 500;

export interface StoredApproval {
  approvalId: string;
  requestId: string;
  denyTokenHash: string;
  approveTokenHash: string | null;
  vendor: string;
  boundCents: number;
  kind: "approve" | "veto";
  summary: string;
  expiresAt: string;
  usedAt: string | null;
  verdict: "approve" | "deny" | null;
}

/** Which link a token belongs to: it may only perform that action. */
export type Role = "approve" | "deny";
export interface Found {
  approval: StoredApproval;
  role: Role;
}

export type UpsertResult = "stored" | "already_decided" | "hash_conflict";
/** wrong_link: a live record's token was posted to the other action; nothing was written. */
export type TapResult = "ok" | "gone" | "wrong_link";
export type Backend = "sqlite" | "kv";

export interface RelayStore {
  readonly backend: Backend;
  /** Read-only lookup of a token hash against both the deny and approve hashes. Never writes. */
  findByHash(tokenHash: string): Promise<Found | null>;
  /**
   * Upsert a record pushed by the gate. A tapped record is frozen ("already_decided"); either
   * hash already used by another approvalId is "hash_conflict". Client usedAt/verdict are ignored.
   */
  upsert(a: ApprovalRecord, now: Date): Promise<UpsertResult>;
  /**
   * Single-use tap (per record): unused, unexpired, and the token must be the one for this
   * action (approve token → approve, deny token → deny). Either successful tap consumes the
   * record. On approve, `proofToken` (the plaintext approve token) is stored for the gate.
   */
  tap(tokenHash: string, verdict: Role, now: Date, proofToken?: string): Promise<TapResult>;
  /**
   * Verdicts with used_at > since, oldest first, about `limit` per page (never splits a
   * same-millisecond group). Approve verdicts carry `token` the first time they are pulled,
   * within PROOF_TTL_MS of the tap; the stored token is deleted in the same operation.
   */
  verdictsSince(sinceIso: string, opts?: { now?: Date; limit?: number }): Promise<Verdict[]>;
  /** Test helper: full snapshot of everything stored (changes on any write). */
  dumpRows(): Promise<Array<Record<string, unknown>>>;
  close(): void;
}

export interface StoreConfig {
  backend: Backend;
  dataDir: string; // sqlite only
  kvPath?: string; // kv only; undefined → Deno.openKv() default (Deno Deploy)
}

/** Raised when the store cannot be selected/opened (bad RELAY_STORE, no KV available). */
export class StoreUnavailable extends Error {
  override name = "StoreUnavailable";
}

// ── handle cache (one per backend+path) ─────────────────────────────────────
const cache = new Map<string, Promise<RelayStore>>();

export function openStore(cfg: StoreConfig): Promise<RelayStore> {
  const key = cfg.backend === "sqlite" ? `sqlite:${cfg.dataDir}` : `kv:${cfg.kvPath ?? ""}`;
  let p = cache.get(key);
  if (!p) {
    p = cfg.backend === "sqlite" ? SqliteStore.open(cfg.dataDir) : KvStore.open(cfg.kvPath);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Close every cached handle so the next openStore reopens (tests; resource sanitizer). */
export async function closeStore(): Promise<void> {
  const all = [...cache.values()];
  cache.clear();
  for (const p of all) {
    try {
      (await p).close();
    } catch { /* failed open or already closed */ }
  }
}

// ── SQLite ─────────────────────────────────────────────────────────────────
// Minimal structural type so node:sqlite is only imported when this backend is used
// (Deno Deploy never loads it).
interface SqlStmt {
  get(...a: unknown[]): unknown;
  all(...a: unknown[]): unknown[];
  run(...a: unknown[]): { changes: number | bigint };
}
interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): SqlStmt;
  close(): void;
}

const COLS = `approval_id, request_id, deny_token_hash, approve_token_hash, vendor, bound_cents,
              kind, summary, expires_at, used_at, verdict`;

function rowToApproval(row: Record<string, unknown>): StoredApproval {
  return {
    approvalId: String(row.approval_id),
    requestId: String(row.request_id),
    denyTokenHash: String(row.deny_token_hash),
    approveTokenHash: row.approve_token_hash == null ? null : String(row.approve_token_hash),
    vendor: String(row.vendor),
    boundCents: Number(row.bound_cents),
    kind: row.kind === "veto" ? "veto" : "approve",
    summary: String(row.summary),
    expiresAt: String(row.expires_at),
    usedAt: row.used_at == null ? null : String(row.used_at),
    verdict: row.verdict === "approve" || row.verdict === "deny" ? row.verdict : null,
  };
}

function roleOf(a: StoredApproval, tokenHash: string): Role | null {
  if (a.denyTokenHash === tokenHash) return "deny";
  if (a.approveTokenHash !== null && a.approveTokenHash === tokenHash) return "approve";
  return null;
}

export class SqliteStore implements RelayStore {
  readonly backend = "sqlite" as const;
  #db: SqlDb;
  private constructor(db: SqlDb) {
    this.#db = db;
  }

  static async open(dir: string): Promise<SqliteStore> {
    const { DatabaseSync } = await import("node:sqlite");
    Deno.mkdirSync(dir, { recursive: true });
    const d = new DatabaseSync(`${dir}/relay.db`) as unknown as SqlDb;
    d.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;`);
    // A pre-two-token database (single token_hash column) is set aside, never dropped.
    const cols = d.prepare(`PRAGMA table_info(approvals)`).all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === "deny_token_hash")) {
      d.exec(`ALTER TABLE approvals RENAME TO approvals_legacy_v1;
              DROP INDEX IF EXISTS approvals_used_at;`);
    }
    d.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id        TEXT PRIMARY KEY,
        request_id         TEXT NOT NULL,
        deny_token_hash    TEXT NOT NULL UNIQUE,
        approve_token_hash TEXT UNIQUE,
        vendor             TEXT NOT NULL,
        bound_cents        INTEGER NOT NULL,
        kind               TEXT NOT NULL CHECK (kind IN ('approve','veto')),
        summary            TEXT NOT NULL,
        expires_at         TEXT NOT NULL,
        used_at            TEXT,
        verdict            TEXT CHECK (verdict IN ('approve','deny')),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS approvals_used_at ON approvals(used_at);
      CREATE TABLE IF NOT EXISTS proof_tokens (
        approval_id TEXT PRIMARY KEY,
        token       TEXT NOT NULL,
        used_at     TEXT NOT NULL
      );
    `);
    return new SqliteStore(d);
  }

  #tx<T>(fn: () => T): T {
    const d = this.#db;
    d.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      d.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        d.exec("ROLLBACK");
      } catch { /* already rolled back */ }
      throw e;
    }
  }

  #purgeProofs(now: Date): void {
    const cutoff = new Date(now.getTime() - PROOF_TTL_MS).toISOString();
    this.#db.prepare(`DELETE FROM proof_tokens WHERE used_at <= ?`).run(cutoff);
  }

  #find(tokenHash: string): Found | null {
    const row = this.#db.prepare(
      `SELECT ${COLS} FROM approvals WHERE deny_token_hash = ? OR approve_token_hash = ?`,
    ).get(tokenHash, tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    const approval = rowToApproval(row);
    const role = roleOf(approval, tokenHash);
    return role ? { approval, role } : null;
  }

  findByHash(tokenHash: string): Promise<Found | null> {
    return Promise.resolve(this.#find(tokenHash));
  }

  upsert(a: ApprovalRecord, now: Date): Promise<UpsertResult> {
    const nowIso = now.toISOString();
    const d = this.#db;
    const approveHash = a.approveTokenHash ?? null;
    const r = this.#tx((): UpsertResult => {
      const other = d.prepare(
        `SELECT approval_id FROM approvals
          WHERE approval_id <> ?
            AND (deny_token_hash IN (?, ?) OR approve_token_hash IN (?, ?))`,
      ).get(
        a.approvalId,
        a.denyTokenHash,
        approveHash ?? a.denyTokenHash,
        a.denyTokenHash,
        approveHash ?? a.denyTokenHash,
      );
      if (other) return "hash_conflict";
      const existing = d.prepare(
        `SELECT used_at FROM approvals WHERE approval_id = ?`,
      ).get(a.approvalId) as { used_at: string | null } | undefined;
      if (existing && existing.used_at != null) return "already_decided";
      d.prepare(
        `INSERT INTO approvals (approval_id, request_id, deny_token_hash, approve_token_hash, vendor,
                                bound_cents, kind, summary, expires_at, used_at, verdict,
                                created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(approval_id) DO UPDATE SET
           request_id = excluded.request_id,
           deny_token_hash = excluded.deny_token_hash,
           approve_token_hash = excluded.approve_token_hash,
           vendor = excluded.vendor,
           bound_cents = excluded.bound_cents,
           kind = excluded.kind,
           summary = excluded.summary,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
         WHERE approvals.used_at IS NULL`,
      ).run(
        a.approvalId,
        a.requestId,
        a.denyTokenHash,
        approveHash,
        a.vendor,
        a.boundCents,
        a.kind,
        a.summary,
        a.expiresAt,
        nowIso,
        nowIso,
      );
      const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
      d.prepare(
        `DELETE FROM approvals WHERE expires_at < ? AND (used_at IS NULL OR used_at < ?)`,
      ).run(cutoff, cutoff);
      this.#purgeProofs(now);
      return "stored";
    });
    return Promise.resolve(r);
  }

  tap(tokenHash: string, verdict: Role, now: Date, proofToken?: string): Promise<TapResult> {
    const nowIso = now.toISOString();
    const d = this.#db;
    const r = this.#tx((): TapResult => {
      const f = this.#find(tokenHash);
      if (!f || f.approval.usedAt !== null || f.approval.expiresAt <= nowIso) return "gone";
      if (f.role !== verdict) return "wrong_link";
      // The WHERE clause repeats the whole guard; BEGIN IMMEDIATE already serializes writers.
      const col = verdict === "approve" ? "approve_token_hash" : "deny_token_hash";
      const res = d.prepare(
        `UPDATE approvals SET used_at = ?, verdict = ?, updated_at = ?
          WHERE ${col} = ? AND used_at IS NULL AND expires_at > ?
            AND (kind = 'approve' OR ? = 'deny')`,
      ).run(nowIso, verdict, nowIso, tokenHash, nowIso, verdict);
      if (Number(res.changes) !== 1) return "gone";
      if (verdict === "approve" && proofToken) {
        d.prepare(
          `INSERT OR REPLACE INTO proof_tokens (approval_id, token, used_at) VALUES (?, ?, ?)`,
        ).run(f.approval.approvalId, proofToken, nowIso);
      }
      return "ok";
    });
    return Promise.resolve(r);
  }

  verdictsSince(sinceIso: string, opts: { now?: Date; limit?: number } = {}): Promise<Verdict[]> {
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? DEFAULT_PAGE;
    const d = this.#db;
    const out = this.#tx(() => {
      this.#purgeProofs(now);
      const rows = d.prepare(
        `SELECT approval_id, verdict, used_at FROM approvals
          WHERE verdict IS NOT NULL AND used_at > ?
          ORDER BY used_at ASC, approval_id ASC LIMIT ?`,
      ).all(sinceIso, limit) as Array<Record<string, unknown>>;
      // The gate uses the last `at` as its next strict-`>` cursor. Never split a
      // same-millisecond group across pages or the remainder would be skipped.
      if (rows.length === limit && limit > 0) {
        const last = rows[rows.length - 1];
        const tail = d.prepare(
          `SELECT approval_id, verdict, used_at FROM approvals
            WHERE verdict IS NOT NULL AND used_at = ? AND approval_id > ?
            ORDER BY approval_id ASC`,
        ).all(String(last.used_at), String(last.approval_id)) as Array<Record<string, unknown>>;
        rows.push(...tail);
      }
      const getProof = d.prepare(`SELECT token FROM proof_tokens WHERE approval_id = ?`);
      const delProof = d.prepare(`DELETE FROM proof_tokens WHERE approval_id = ?`);
      return rows.map((r): Verdict => {
        const v: Verdict = {
          approvalId: String(r.approval_id),
          verdict: r.verdict === "approve" ? "approve" : "deny",
          at: String(r.used_at),
        };
        if (v.verdict === "approve") {
          const p = getProof.get(v.approvalId) as { token: string } | undefined;
          if (p) {
            delProof.run(v.approvalId);
            v.token = String(p.token);
          }
        }
        return v;
      });
    });
    return Promise.resolve(out);
  }

  dumpRows(): Promise<Array<Record<string, unknown>>> {
    const approvals = this.#db.prepare(`SELECT * FROM approvals ORDER BY approval_id`).all() as Array<
      Record<string, unknown>
    >;
    const proofs = this.#db.prepare(`SELECT * FROM proof_tokens ORDER BY approval_id`).all() as Array<
      Record<string, unknown>
    >;
    return Promise.resolve([
      ...approvals.map((r) => ({ table: "approvals", ...r })),
      ...proofs.map((r) => ({ table: "proof_tokens", ...r })),
    ]);
  }

  close(): void {
    this.#db.close();
  }
}

// ── Deno KV ───────────────────────────────────────────────────────────────
// Keys:
//   ["approval", approvalId]           → KvApproval
//   ["hash", tokenHash]                → approvalId   (deny AND approve hashes are indexed)
//   ["verdict", usedAtIso, approvalId] → "approve" | "deny"   (ordered index for verdictsSince)
//   ["proof", approvalId]              → { token, usedAt }     (expireIn PROOF_TTL_MS)
// All keys carry expireIn (approval expiry / tap + 30 days); reads still filter, since KV
// expiry is lazy.
interface KvApproval extends StoredApproval {
  createdAt: string;
  updatedAt: string;
}
interface KvProof {
  token: string;
  usedAt: string;
}

const MAX_ATTEMPTS = 8;

function retentionMs(a: { expiresAt: string; usedAt: string | null }, now: Date): number {
  const exp = Date.parse(a.expiresAt);
  const used = a.usedAt ? Date.parse(a.usedAt) : 0;
  return Math.max(60_000, Math.max(exp, used) + RETENTION_MS - now.getTime());
}

function hashesOf(a: { denyTokenHash: string; approveTokenHash?: string | null }): string[] {
  return a.approveTokenHash ? [a.denyTokenHash, a.approveTokenHash] : [a.denyTokenHash];
}

export class KvStore implements RelayStore {
  readonly backend = "kv" as const;
  #kv: Deno.Kv;
  private constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  static async open(path?: string): Promise<KvStore> {
    if (typeof Deno.openKv !== "function") {
      throw new StoreUnavailable("Deno KV unavailable (run with --unstable-kv)");
    }
    return new KvStore(await (path ? Deno.openKv(path) : Deno.openKv()));
  }

  async #find(tokenHash: string): Promise<{ entry: Deno.KvEntry<KvApproval>; role: Role } | null> {
    const h = await this.#kv.get<string>(["hash", tokenHash]);
    if (h.value === null) return null;
    const e = await this.#kv.get<KvApproval>(["approval", h.value]);
    if (e.value === null) return null;
    const role = roleOf(e.value, tokenHash);
    return role ? { entry: e as Deno.KvEntry<KvApproval>, role } : null;
  }

  async findByHash(tokenHash: string): Promise<Found | null> {
    const f = await this.#find(tokenHash);
    if (!f) return null;
    const { createdAt: _c, updatedAt: _u, ...approval } = f.entry.value;
    return { approval, role: f.role };
  }

  async upsert(a: ApprovalRecord, now: Date): Promise<UpsertResult> {
    const nowIso = now.toISOString();
    const newHashes = hashesOf(a);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const apE = await this.#kv.get<KvApproval>(["approval", a.approvalId]);
      const hashEs = await this.#kv.getMany<string[]>(newHashes.map((h) => ["hash", h]));
      for (const [j, he] of hashEs.entries()) {
        if (he.value === null || he.value === a.approvalId) continue;
        // Only a conflict if the other record still exists and still owns this hash.
        const other = await this.#kv.get<KvApproval>(["approval", he.value]);
        if (other.value !== null && roleOf(other.value, newHashes[j]) !== null) return "hash_conflict";
      }
      const existing = apE.value;
      if (existing && existing.usedAt !== null) return "already_decided";
      const rec: KvApproval = {
        approvalId: a.approvalId,
        requestId: a.requestId,
        denyTokenHash: a.denyTokenHash,
        approveTokenHash: a.approveTokenHash ?? null,
        vendor: a.vendor,
        boundCents: a.boundCents,
        kind: a.kind,
        summary: a.summary,
        expiresAt: a.expiresAt,
        usedAt: null,
        verdict: null,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      const expireIn = retentionMs(rec, now);
      const op = this.#kv.atomic().check(apE, ...hashEs)
        .set(["approval", a.approvalId], rec, { expireIn });
      for (const h of newHashes) op.set(["hash", h], a.approvalId, { expireIn });
      // Re-published with new hashes: drop the old index keys.
      if (existing) {
        for (const h of hashesOf(existing)) if (!newHashes.includes(h)) op.delete(["hash", h]);
      }
      const res = await op.commit();
      if (res.ok) {
        await this.#purgeProofs(now);
        return "stored";
      }
    }
    throw new Error("kv upsert contention");
  }

  async tap(tokenHash: string, verdict: Role, now: Date, proofToken?: string): Promise<TapResult> {
    const nowIso = now.toISOString();
    const f = await this.#find(tokenHash);
    if (!f) return "gone";
    const a = f.entry.value;
    if (a.usedAt !== null || a.expiresAt <= nowIso) return "gone";
    if (f.role !== verdict || (verdict === "approve" && a.kind !== "approve")) return "wrong_link";
    const next: KvApproval = { ...a, usedAt: nowIso, verdict, updatedAt: nowIso };
    const expireIn = retentionMs(next, now);
    // The versionstamp check is the single-use guard: of two concurrent taps exactly one commits.
    const op = this.#kv.atomic()
      .check(f.entry)
      .set(["approval", a.approvalId], next, { expireIn })
      .set(["verdict", nowIso, a.approvalId], verdict, { expireIn });
    for (const h of hashesOf(a)) op.set(["hash", h], a.approvalId, { expireIn });
    if (verdict === "approve" && proofToken) {
      const proof: KvProof = { token: proofToken, usedAt: nowIso };
      op.set(["proof", a.approvalId], proof, {
        expireIn: Math.max(1000, now.getTime() + PROOF_TTL_MS - Date.now()),
      });
    }
    const res = await op.commit();
    return res.ok ? "ok" : "gone";
  }

  async #purgeProofs(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - PROOF_TTL_MS).toISOString();
    for await (const e of this.#kv.list<KvProof>({ prefix: ["proof"] })) {
      if (!e.value || e.value.usedAt <= cutoff) {
        await this.#kv.atomic().check(e).delete(e.key).commit();
      }
    }
  }

  async verdictsSince(sinceIso: string, opts: { now?: Date; limit?: number } = {}): Promise<Verdict[]> {
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? DEFAULT_PAGE;
    await this.#purgeProofs(now);
    const out: Verdict[] = [];
    // ["verdict", since, *] sorts before ["verdict", since + "\0"]: strict `>` on used_at.
    const iter = this.#kv.list<string>({ prefix: ["verdict"], start: ["verdict", sinceIso + "\0"] });
    for await (const e of iter) {
      const at = String(e.key[1]);
      const approvalId = String(e.key[2]);
      if (!(at > sinceIso)) continue;
      // Never split a same-millisecond group: past the limit, only finish the last group.
      if (out.length >= limit && (out.length === 0 || at !== out[out.length - 1].at)) break;
      out.push({ approvalId, verdict: e.value === "approve" ? "approve" : "deny", at });
    }
    const cutoff = new Date(now.getTime() - PROOF_TTL_MS).toISOString();
    for (const v of out) {
      if (v.verdict !== "approve") continue;
      const p = await this.#kv.get<KvProof>(["proof", v.approvalId]);
      if (p.value === null) continue;
      // Delete-and-return in one atomic step: a concurrent pull gets it at most once.
      const res = await this.#kv.atomic().check(p).delete(p.key).commit();
      if (res.ok && p.value.usedAt > cutoff) v.token = p.value.token;
    }
    return out;
  }

  async dumpRows(): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    for await (const e of this.#kv.list({ prefix: [] })) {
      rows.push({ key: e.key, value: e.value, versionstamp: e.versionstamp });
    }
    return rows;
  }

  close(): void {
    this.#kv.close();
  }
}
