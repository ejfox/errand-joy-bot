// WP2: database open + schema + transaction helper.
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_BUDGETS } from "./types.ts";

export type Db = DatabaseSync;

const SCHEMA = Deno.readTextFileSync(new URL("./schema.sql", import.meta.url));

/**
 * Open (or create) the ledger at `path`, apply the schema idempotently and seed
 * DEFAULT_BUDGETS with INSERT OR IGNORE (operator overrides survive restarts).
 *
 * synchronous=NORMAL under WAL: durable across process crashes; a power loss can
 * lose the last few commits but never corrupts the file.
 */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);
  // A ledger from before fragment links has no lookup-id columns; add them (nullable, nothing dropped).
  const cols = db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
  for (const c of ["deny_lookup_id", "approve_lookup_id"]) {
    if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE approvals ADD COLUMN ${c} TEXT`);
  }
  // A ledger from before the silent tier / sealed DMs has no hint, silent, sealed columns.
  const rcols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
  const add: [string, string][] = [
    ["hint", "TEXT"],
    ["silent", "INTEGER CHECK (silent IS NULL OR silent IN (0,1))"],
    ["sealed", "INTEGER CHECK (sealed IS NULL OR sealed IN (0,1))"],
    // ...nor the hard cap, delivery links and needs-action columns. Legacy rows keep NULL there
    // (reconcile falls back to max_total_cents, which the gate never authorized above).
    ["hard_cap_cents", "INTEGER CHECK (hard_cap_cents IS NULL OR hard_cap_cents >= 0)"],
    ["links_json", "TEXT"],
    ["needs_action", "TEXT"],
    ["needs_action_dm_at", "TEXT"],
  ];
  for (const [c, type] of add) {
    if (!rcols.some((x) => x.name === c)) db.exec(`ALTER TABLE requests ADD COLUMN ${c} ${type}`);
  }
  const seed = db.prepare(
    "INSERT OR IGNORE INTO budgets (key, window, cap_cents) VALUES (?, ?, ?)",
  );
  for (const b of DEFAULT_BUDGETS) seed.run(b.key, b.window, b.capCents);
  return db;
}

let spSeq = 0;

/**
 * Run `fn` atomically. Uses SAVEPOINT so calls nest safely (e.g. a tick that
 * wraps several ledger calls in its own tx). Rolls back and rethrows on error.
 */
export function tx<T>(db: Db, fn: () => T): T {
  const sp = `pg_sp_${++spSeq}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${sp}`);
    return out;
  } catch (e) {
    try {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
    } catch {
      // SQLite may already have rolled back the whole tx (SQLITE_FULL, I/O error);
      // the savepoint is gone. Surface the original error, not this one.
    }
    throw e;
  }
}

export function nowISO(d: Date = new Date()): string {
  return d.toISOString();
}
