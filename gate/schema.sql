-- purchase-gate ledger schema (WP2). Applied idempotently by db.ts openDb().
-- All timestamps are ISO-8601 UTC strings from Date.toISOString() (ms + "Z"),
-- so lexicographic comparison == chronological comparison.
-- Money is integer cents. Balances and window totals are always computed by SUM,
-- never stored.

CREATE TABLE IF NOT EXISTS requests (
  id                   TEXT PRIMARY KEY,
  idempotency_key      TEXT NOT NULL UNIQUE,
  payload_hash         TEXT NOT NULL,
  requester            TEXT NOT NULL,
  task_id              TEXT NOT NULL,
  vendor               TEXT NOT NULL,
  budget               TEXT NOT NULL DEFAULT 'general' CHECK (budget IN ('general','joy')),
  reach_declared       TEXT NOT NULL CHECK (reach_declared IN ('self','world','others')),
  reach_effective      TEXT CHECK (reach_effective IS NULL OR reach_effective IN ('self','world','others')),
  items_json           TEXT NOT NULL,
  reason               TEXT NOT NULL,
  max_total_cents      INTEGER NOT NULL CHECK (max_total_cents >= 0),
  category             TEXT,
  ship_to_json         TEXT,
  -- quote (vendor dry run); tiers are computed on quote_total_cents
  quote_subtotal_cents INTEGER,
  quote_tax_cents      INTEGER,
  quote_shipping_cents INTEGER,
  quote_total_cents    INTEGER,
  quote_currency       TEXT CHECK (quote_currency IS NULL OR quote_currency = 'USD'),
  quote_ref            TEXT,
  quoted_at            TEXT,
  quote_raw_json       TEXT,
  final_cents          INTEGER,
  tier                 TEXT CHECK (tier IS NULL OR tier IN ('auto','ask','fund_auto','refuse')),
  decision             TEXT CHECK (decision IS NULL OR decision IN ('auto','ask','deny')),
  reasons_json         TEXT,
  state                TEXT NOT NULL CHECK (state IN (
                         'received','quoted','decided','dm_pending','dm_delivered',
                         'pending_approval','approved','denied','expired','placing',
                         'placed','outcome_unknown','delivered','closed','cancelled','refunded','failed')),
  approver             TEXT,
  vendor_order_id      TEXT,
  dm_message_id        TEXT,
  dm_attempts          INTEGER NOT NULL DEFAULT 0,
  dm_last_error        TEXT,
  why_note             TEXT,
  hint                 TEXT,
  -- set at decide: silent = no pre-order DM (decided → approved); sealed = DMs never name the item
  silent               INTEGER CHECK (silent IS NULL OR silent IN (0,1)),
  sealed               INTEGER CHECK (sealed IS NULL OR sealed IN (0,1)),
  rating               INTEGER,
  -- the most the gate authorized for this order (set at placing); reconcile STOPs only above it
  hard_cap_cents       INTEGER CHECK (hard_cap_cents IS NULL OR hard_cap_cents >= 0),
  -- https delivery links an adapter reported (certificates, downloads, tracking); sanitized JSON array
  links_json           TEXT,
  -- vendor-side block the owner must clear (e.g. Prodigi RequiresPaymentAuthorisation); DM sent once
  needs_action         TEXT,
  needs_action_dm_at   TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_state_created ON requests(state, created_at);
CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at);
CREATE INDEX IF NOT EXISTS requests_vendor_created ON requests(vendor, created_at);

-- One row per state change (including the initial NULL -> received).
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT NOT NULL REFERENCES requests(id),
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  note        TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_request ON events(request_id, id);

-- Only sha256(token) is stored; plaintext tokens never touch the DB. Two separate tokens:
-- deny (every record) and approve (kind = 'approve' only). The lookup ids are the PUBLIC part of
-- each link's path (/a/<lookupId>#<token>); they cannot approve anything. Rows from before the
-- lookup ids existed have NULL there (db.ts adds the columns to an older ledger).
CREATE TABLE IF NOT EXISTS approvals (
  approval_id         TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL REFERENCES requests(id),
  deny_token_hash     TEXT NOT NULL UNIQUE,
  approve_token_hash  TEXT UNIQUE,
  deny_lookup_id      TEXT,
  approve_lookup_id   TEXT,
  vendor       TEXT NOT NULL,
  bound_cents  INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('approve','veto')),
  summary      TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  verdict      TEXT CHECK (verdict IS NULL OR verdict IN ('approve','deny')),
  created_at   TEXT NOT NULL,
  CHECK ((kind = 'approve') = (approve_token_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS approvals_request ON approvals(request_id);

CREATE TABLE IF NOT EXISTS budgets (
  key        TEXT PRIMARY KEY,           -- "global/day", "joy/week", "<vendor>/month"
  window     TEXT NOT NULL CHECK (window IN ('day','week','month')),
  cap_cents  INTEGER NOT NULL CHECK (cap_cents >= 0)
);

-- Robot fund. Sign convention: topup/income/release/refund > 0, hold/spend < 0.
CREATE TABLE IF NOT EXISTS fund_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cents       INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('topup','income','hold','release','spend','refund')),
  source      TEXT NOT NULL,
  ref         TEXT,
  request_id  TEXT REFERENCES requests(id),
  at          TEXT NOT NULL,
  CHECK (
    (kind IN ('topup','income','release','refund') AND cents > 0) OR
    (kind IN ('hold','spend') AND cents < 0)
  )
);
CREATE INDEX IF NOT EXISTS fund_entries_request ON fund_entries(request_id);

-- Vendor-side charges pulled during reconcile.
CREATE TABLE IF NOT EXISTS charges (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor            TEXT NOT NULL,
  vendor_charge_id  TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  at                TEXT NOT NULL,
  vendor_order_id   TEXT,
  request_id        TEXT REFERENCES requests(id),
  seen_at           TEXT NOT NULL,
  UNIQUE (vendor, vendor_charge_id)
);

CREATE TABLE IF NOT EXISTS reconcile_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor        TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  charges_seen  INTEGER NOT NULL DEFAULT 0,
  unmatched     INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER CHECK (ok IS NULL OR ok IN (0,1)),
  note          TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
