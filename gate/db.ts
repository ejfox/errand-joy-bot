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
