# errand-joy-bot gate contract

The prose companion to `gate/types.ts`; keep the two in sync. Code enforces every rule here; prompts never do.

## Ground rules
- Deno 2.6+. `node:sqlite` `new DatabaseSync(path)` with no options object. Hono for the gate HTTP.
- `DRY_RUN=1` is the default; only exactly `0` is live. Tests never touch the network, never DM, never ssh.
- Secrets live in env (`.env`, gitignored). Policy lives in `config.toml` (`CONFIG_PATH`). Agents see neither.
- Tests: `deno task test` (gate + relay, both relay storage backends). `deno task check`, `deno task lint`.

## Config (`gate/config.ts`)
Keys: `timezone`, `vendors[]`, `owner_home_label`, `min_reason_chars`, `world_categories[]`, `i_understand_the_risk`;
`[tiers] auto_max_cents, ask_max_cents, fund_enabled, fund_max_cents`; `[caps] day_cents, month_cents, vendor_month_cents`;
`[joy] enabled, week_cents`; `[quiet_hours] start, end`; `[velocity] max_requests_per_10m`;
`[windows] auto_cancel_minutes, fund_veto_minutes, approval_ttl_hours`; `[mock] tax_rate`;
`[notify] silent_below_cents, sealed`.
- Defaults = the `types.ts` constants: $69 auto / $500 ask / $1000 fund (on; inert at a $0 balance), $100/day,
  $250/month, $100/vendor/month, $40/week joy inside the month cap, velocity 5, 10 min cancel, 2h fund veto,
  24h approval TTL, quiet 22:00–07:30, `min_reason_chars = 60`, silent below $40 (or `auto_max_cents` if lower),
  `sealed = true`.
- `notify.silent_below_cents` is a looser-when-higher amount (ceiling $40 without the risk flag) and must be
  `<= tiers.auto_max_cents`; 0 turns the silent tier off.
- The defaults are also the HARD CEILINGS: config can only make policy stricter. Loosening needs
  `i_understand_the_risk = true`, and even then amounts stop at $10,000, velocity at 20, approval TTL at 24h.
- Unknown keys are errors. `day_cents < auto_max_cents` is an error. A cap below `ask_max_cents` logs an INFO
  line (`effective ask ceiling = $X (limited by caps.day_cents)`): caps are absolute, the ask tier included.

## Policy (`decide(input, limits)` in policy.ts)
1. `stopped` → deny. 2. `!vendorAllowed` → deny. 3. velocity: `requestsLast10m > limits.velocityLimit` → deny + tripStop.
4. `effectiveReach = max(reach, adapterReach)`.
5. Tier by QUOTED `totalCents`: `< autoMax` auto · `≤ askMax` ask · `≤ fundMax` fund_auto (only when fund enabled) · else refuse.
6. Joy: disabled → deny `joy_disabled`; reach must be `self` (`joy_reach`); tier must be auto (`joy_over_auto`).
7. fund_auto needs `fundBalanceCents >= totalCents` (`fund_insufficient`); paid from the fund, exempt from windows.
8. Non-fund tiers: `global/day`, `global/month` and `<vendor>/month` must be present (`window_missing:*`), plus
   `joy/week` for joy; any window where `spent + total > cap` → deny `window:<key>`. Joy counts inside global.
9. `effectiveReach === "others"` → at least ask (fund_auto too).

## Silent and sealed (`noticeFor()` in orchestrator.ts; stored on the row at decide)
- **silent** = decision `auto` AND tier `auto` AND effectiveReach `self`|`world` AND quoted total
  `< notify.silent_below_cents` (joy included). No pre-order DM, no approval record, no cancel window:
  `decided → approved`, then tick re-quotes (must equal the decided quote, else `quote_changed`), re-decides
  (must still be silent, else `policy_changed, now_needs_dm`) and places with hard cap
  `min(quote, maxTotalCents)`. Caps, velocity, STOP, REACH and the ledger apply unchanged.
- **sealed** = not silent, effectiveReach `self`|`world`, and either budget joy, or `notify.sealed` with decision
  `ask` or tier `fund_auto`. The DM and relay summary show the amount, today's / this month's headroom, the
  vendor category (`VENDOR_LABELS` in notify.ts, e.g. "Amazon via Zinc"), and the agent's `hint` (default
  "something for you"); never the title, URL, SKU, reason or requester. The published record's vendor is
  `"sealed"`. Auto-tier non-joy veto DMs ($40 up to auto max) stay open.
- effectiveReach `others` is never silent and never sealed: the DM and page always show item, recipient, reason.
- THE REVEAL: every silent, sealed or joy purchase gets a why-note DM on delivery (what it is, `whyNote` falling
  back to `reason`, and the first item URL if any), and stays `delivered` until that DM has a messageId.

## State machine (state.ts)
```
received → quoted | failed (quote failed) | cancelled
quoted → decided | denied (bad quote / over the agent's maxTotalCents) | cancelled
decided → denied | dm_pending | approved (ONLY a silent row) | cancelled
dm_pending → dm_delivered (needs messageId) | expired (24h of failed DMs) | denied | cancelled
dm_delivered → pending_approval (ask) | approved (cancel / veto window elapsed) | cancelled (veto)
pending_approval → approved | denied | expired | cancelled
approved → placing (ONLY with a non-deny re-decide, and a DM messageId unless the row is silent)
         | denied (policy_changed) | cancelled
placing → placed | failed (guard refused before the vendor call) | outcome_unknown (vendor call errored)
outcome_unknown → placed | failed      (reconcile or POST /internal/resolve/:id)
placed → delivered | cancelled (incl. vendor status "failed") | refunded
delivered → closed (joy, silent or sealed: only after the why-note DM has a messageId)
```
The fail-closed rule "nothing reaches `placing` without a delivered DM" applies to every NON-silent row.
The ledger re-checks `silent` / `sealed` from the persisted row, never from the caller.
Under STOP only transitions into `denied, cancelled, expired, failed, placed, outcome_unknown, refunded` are allowed:
they halt money or record what a vendor already did. Every transition writes an `events` row, is a compare-and-set
on the current state, and re-runs `assertTransition` inside the ledger transaction (wiring.ts `SqliteLedger`).

## Ledger
- Window totals = `SUM(COALESCE(final_cents, quote_total_cents))` over requests in
  `dm_pending, dm_delivered, pending_approval, approved, placing, placed, outcome_unknown, delivered, closed`, created
  inside the window (calendar day / ISO week / calendar month in `timezone`), tier not `fund_auto`.
  In-flight asks reserve budget. Intake and the pre-place re-decide run under one async lock, so concurrent
  requests are judged one at a time.
- Re-decide before placing calls `windowUsage(..., { excludeRequestId })` and `fundBalance(db, { excludeHoldFor })`.
- Fund: balance = `SUM(fund_entries.cents)`, never stored. ONE sign convention: topup, income, release, refund > 0;
  hold, spend < 0 (CHECK in schema.sql). fund_auto: hold(−X) at decide, release(+X) and spend(−charged) at place,
  release(+X) on abort. A release releases only what is still held, so a double release is a no-op.
- Idempotency: same key + same payload hash → existing row; different hash → `IdempotencyConflict` → STOP.
- STOP = the file `$DATA_DIR/STOP` OR `settings.stop = '1'`.
- Caps come from config and are written to the `budgets` table at startup.

## Vendors (`adapters/registry.ts`)
The registry hands out ONLY `guarded(adapter, { isStopped, dryRun, worldCategories })` adapters. The guard refuses
`place()` (throwing `GuardRefused`, so nothing reached the vendor) when the quote exceeds the hard cap, the adapter is
paused, STOP is set (or unreadable), or `DRY_RUN` is on and the adapter isn't `simulated`. It raises reach to
`others` for any `shipTo` other than `"owner-home"` and to `world` for a world category. Adapters keep their own
checks too. Hard cap = `min(approval.boundCents, maxTotalCents)`.

## Gate HTTP (server.ts, started by main.ts)
Binds `GATE_HOST:GATE_PORT` (default 127.0.0.1:47400). Refuses anything but loopback or 100.64.0.0/10 unless
`ALLOW_PUBLIC_BIND=1`. Ticks every 60s internally.
- `/api/*` (Bearer `GATE_AGENT_TOKEN`): `POST /api/requests`, `GET /api/requests/:id`, `GET /api/requests?state=`,
  `POST /api/requests/:id/cancel`, `GET /api/budgets`, `GET /api/fund`.
- `/internal/*` (Bearer `GATE_ADMIN_TOKEN`): `POST tick`, `POST reconcile`, `POST fund/entries`, `POST|DELETE stop`,
  `POST rate/:id`, `POST resolve/:id` (`{outcome: "placed"|"failed", vendorOrderId?, chargedCents?}`),
  `POST import-order` (`{vendor, vendorOrderId, cents, note}`): inserts a row directly in `placed` (requester
  `manual-import`, tier/decision auto, reach self, budget general, `final_cents = cents`, event `NULL → placed`),
  counts in the windows, lets reconcile match the charge; idempotent on vendor + vendorOrderId (same pair with a
  different amount → 409). For Zinc, `cents` = `max_price` + the order fee (100).
- `GET /health` → `{ok, stopped}` only.
- Request body: `PurchaseRequest` in types.ts. `reason` ≥ `min_reason_chars`. `shipTo` is `owner_home_label`
  (default `"owner-home"`) or `{name, line1, city, state, zip, phone?}`. Optional `whyNote` (1-500 chars; the
  delivery why-note for silent, sealed and joy purchases). Optional `hint` (1-80 chars; shown in sealed DMs instead
  of the item): 400 if it contains, case-insensitively, any 4+ letter word of an item title (or a 4+ char SKU).
- `Quote.feeCents` (optional): a per-order vendor fee; `subtotal + tax + shipping + fee` must equal `totalCents`.
- `VendorAdapter.status()` may return `"failed"` (the vendor gave up); the gate treats it like `"cancelled"`.

## Approval tokens
- Two SEPARATE tokens per record, 32 random bytes base64url each, stored as sha256 hex only:
  `denyTokenHash` (every record) and `approveTokenHash` (kind `approve` only). Bound to requestId, vendor and
  boundCents; TTL `approval_ttl_hours`; single-use per record.
- Each link also has a public `denyLookupId` / `approveLookupId` (16 random bytes base64url, approve only for kind
  `approve`) that selects the record; it cannot approve or deny. Links are `/a/<lookupId>#<token>`: the token is in
  the fragment, which is never sent in a request.
- Ask DM: `approve (24h): <RELAY_PUBLIC_URL/a/<approveLookupId>#<approveToken>>` and
  `deny: <…/a/<denyLookupId>#<denyToken>>`, plus cap headroom ("if approved: $X left today, $Y this month").
  Veto DMs (auto, fund, joy) carry only the deny link. Joy and sealed DMs and relay summaries never name the item
  (sealed ones show the vendor category; the published record's vendor is `"sealed"`). Sealed ask DMs show
  headroom and the hint instead of items and reason. Silent purchases have no DM and no record.
- The gate accepts an approve verdict only if `verdict.token` hashes to its stored `approveTokenHash`.
  A compromised relay can always deny. It receives an approve token only in the POST body of an Approve tap, so
  prefetchers, link previews and access logs never give it one; only a relay actively serving hostile page code
  when the owner opens an Approve link could read the fragment. Deny verdicts need no token (fail-safe direction).
- Tick pulls verdicts BEFORE retrying DMs. A deny is honoured in every pre-placing state, including
  `dm_pending`. If the relay answers `already_decided` to a republish, the row is cancelled and no DM is sent.
- Quiet hours queue DMs; nothing non-silent is placed before its DM is delivered. Delivery why-notes wait too.

## Relay (relay/, deployed on its own)
- Public. Holds only `RELAY_TOKEN`; storage `RELAY_STORE=sqlite` (default) or `kv` (Deno KV, for Deno Deploy).
- `POST /internal/pending` upserts a record (hashes and lookupIds, no tokens). `GET /internal/verdicts?since=` lists
  verdicts; an approve verdict carries the tapped approve token ONCE (deleted when pulled, or 24h after the tap).
- `GET /a/:lookupId` renders only the form that link can use (approve OR deny) with an empty `token` field and a
  disabled button; zero writes; the HTML never contains a token. One inline script (allowed by its sha256 in the CSP,
  no `'unsafe-inline'` for scripts) copies `location.hash` into the field, enables the button and clears the hash.
  Without JS nothing can be confirmed. Unknown, used and expired lookupIds get one neutral 404.
  `POST /a/:lookupId/approve|deny` needs the form field `token` whose sha256 equals the stored hash for that lookupId
  and action; the wrong action or a wrong token → 403 and nothing is consumed.
- Every response: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`.
  Per-IP limit 10/min via `RELAY_IP_HEADER` (deny taps exempt).

## Notifier
`NOTIFIER=http-dm` (default): `POST NOTIFY_DM_URL` JSON `{userId: NOTIFY_USER_ID, message}`, Bearer `NOTIFY_DM_TOKEN`,
10s timeout, `ok` only on 2xx + a message id.
`NOTIFIER=ntfy`: `POST ${NTFY_URL:-https://ntfy.sh}/${NTFY_TOPIC}` with the plain-text message as the body, headers
`Title: errand-joy-bot`, `Markdown: no`, optional `Authorization: Bearer NTFY_TOKEN`; never `Click`/`Actions`/`Attach`.
`ok` only on 2xx + a JSON `id` (the messageId). On ntfy.sh the topic must be ≥ 24 chars (it is the secret).
`HEALTH_ALERT_CMD` gets two generic infra alerts, never purchase details.
`DRY_RUN` uses an in-memory FakeNotifier and FakeRelayClient.
