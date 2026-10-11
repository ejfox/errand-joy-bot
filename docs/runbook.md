# errand-joy-bot runbook

How to install, operate and stop the gate. For the why, see the [README](../README.md)
and [threat-model.md](threat-model.md).

Placeholders used below:

| Placeholder | Meaning | Example |
|---|---|---|
| `INSTALL_DIR` | the checkout the gate runs from | `/opt/errand-joy-bot` or `~/errand-joy-bot` |
| `<your-host>` | the machine running the gate | a small VPS, a home server, a spare Mac |
| `approve.example.com` | the relay's public origin | |

## What runs where

- **Gate**: `gate/main.ts`, a Deno service on `127.0.0.1:47400` (systemd unit
  `errand-joy-bot`, or the `gate` service in `compose.yaml`). It holds the vendor keys,
  the policy (`config.toml`), the SQLite ledger and the kill switch, in `DATA_DIR`.
  Agents reach it only with the request-only `GATE_AGENT_TOKEN`.
- **Relay**: `relay/`, the one public piece. Renders single-use approve / veto pages.
  Keyless. See [ops/relay-deploy.md](../ops/relay-deploy.md).
- **Notifier**: your DM transport (`NOTIFIER`, see [notifiers.md](notifiers.md)). Every
  purchase is announced to the owner before any money moves.
- **Cron**: `bin/buy tick` every 2 minutes, `bin/buy reconcile` nightly
  ([ops/crontab.txt](../ops/crontab.txt)).

> **Fail closed.** If the DM path is down, nothing is ordered. If the relay is down,
> nothing in the ask tier is approved. If the config is invalid, the gate does not start.
> If anything is unclear, the gate denies.

## Install (manual path)

The `/errand-joy-bot:setup` command in Claude Code walks through these same steps.

```bash
# 1. get the code onto <your-host>
git clone https://github.com/<owner>/errand-joy-bot.git INSTALL_DIR && cd INSTALL_DIR

# 2. env file (mode 600) and secrets, minted on the box, printed only as ...last4
cp .env.example .env && chmod 600 .env
ops/set-key.sh --generate GATE_AGENT_TOKEN
ops/set-key.sh --generate GATE_ADMIN_TOKEN
ops/set-key.sh --generate RELAY_TOKEN
ops/set-key.sh --generate NTFY_TOPIC      # NOTIFIER=ntfy: random 43-char topic (a secret on ntfy.sh)
#   or, for NOTIFIER=http-dm: ops/set-key.sh NOTIFY_DM_TOKEN   (hidden prompt; paste, Enter)
#    then edit the non-secret lines in .env with an editor:
#    NOTIFIER, NTFY_URL (ntfy) or NOTIFY_DM_URL + NOTIFY_USER_ID (http-dm),
#    RELAY_URL, RELAY_PUBLIC_URL, DATA_DIR, CONFIG_PATH

# 3. policy
cp examples/config.example.toml config.toml && chmod 600 config.toml
#    read every comment; lower the numbers if unsure

# 4. relay: follow ops/relay-deploy.md (one of three targets)

# 5. gate: checks, cache, tests, systemd unit (backs up any old unit)
ops/install.sh --dry          # look first
ops/install.sh --start

# 6. cron: copy ops/crontab.txt, replace INSTALL_DIR, merge into `crontab -e`
```

With Docker instead of step 5: `docker compose up -d --build` (see `compose.yaml`; it
uses host networking so the gate still binds loopback only).

Remote install from a workstation: `EJB_SSH_HOST=<your-host> ops/deploy.sh --dry`, then
without `--dry`. It backs up the remote source, rsyncs (never `.env`, `config.toml` or
`data/`) and runs `ops/install.sh` there.

### Going live, in three stages

1. **`DRY_RUN=1` (default).** No real DMs (an in-memory notifier) and no vendor calls.
   Use it to check the install and run the tests.
2. **Rehearsal: `DRY_RUN=0`, `vendors = ["mock"]`.** Real DMs and real relay links, but the
   only vendor is the mock, which moves no money. Submit a few requests in each tier
   (below) and tap the links. This is where you find out whether your DMs arrive.
   `printf '0\n' | ops/set-key.sh DRY_RUN && sudo systemctl restart errand-joy-bot`
3. **A real vendor.** Add an adapter and its key ([vendors.md](vendors.md)), put it in
   `vendors`, re-run `ops/install.sh --allow-net <vendor-api-host> --start`, and send one
   small auto-tier test.

### A test request

```bash
cat > /tmp/req.json <<'EOF'
{ "idempotencyKey": "test-001", "requester": "me", "taskId": "smoke",
  "vendor": "mock", "items": [{ "sku": "TEST-1", "qty": 1, "title": "test item" }],
  "reason": "Smoke test of the gate with the mock vendor; no money moves, safe to deny.",
  "reach": "self", "maxTotalCents": 12000,
  "shipTo": "owner-home" }
EOF
# The mock prices each SKU from a hash of its name ($1.00-$99.99 plus tax and shipping),
# so try a few SKUs to land in different tiers.
bin/buy request /tmp/req.json
bin/buy list
bin/buy tick
```

## Tiers, caps, REACH

All numbers live in `config.toml` (`CONFIG_PATH`); see the comments in
[examples/config.example.toml](../examples/config.example.toml). Tiers are computed on the
vendor's quoted total. Effective reach = max(declared, adapter floor); `others` always
asks. More than `velocity.max_requests_per_10m` requests in 10 minutes trips STOP.

## Kill levels

Use the lightest level that works. Each includes the ones above it.

1. **STOP file.** `touch DATA_DIR/STOP`. The gate checks it on every step and it works
   even if the HTTP API is wedged. Nothing moves except into denied, cancelled or expired.
2. **`bin/buy stop [reason]`.** Sets STOP through the gate. If the gate is unreachable,
   `buy stop` writes the STOP file itself. Clear with `bin/buy unstop`; a STOP *file* must
   be removed by hand, on purpose.
3. **Pause payment.** On each vendor or card dashboard, pause (don't close) the card or
   turn off wallet auto-reload. Adapters implement `pause()` where the vendor supports it.
4. **Revoke keys.** Disable (don't delete) each vendor key on its dashboard, then remove it
   from `.env` (`set-key.sh` keeps a backup). Stop the service:
   `sudo systemctl stop errand-joy-bot`.

STOP trips automatically on a velocity burst, an idempotency-key conflict, a nightly
reconcile mismatch (a vendor charge with no ledger row), or 24h of the DM path being down.

### Health alerts (optional)

Set `HEALTH_ALERT_CMD` to an executable (absolute path) and the gate runs it as
`<cmd> purchase-gate critical "<fixed text>"` for two conditions, at most once per 6h each.
The text never contains amounts, items or links.

| Alert | Fires when | What to do |
|---|---|---|
| DM path down >2h | every DM has failed for 2h. Orders are already held, because nothing moves without a delivered DM | check the notifier endpoint and `NOTIFY_DM_TOKEN`. At 24h down the gate trips STOP itself |
| STOP tripped | STOP was set, automatically or by hand | read the reason in the log, fix the cause, then `bin/buy unstop` |

The command runs inside the unit's sandbox (`ProtectSystem=strict`). If it needs to write
somewhere, add that path to `ReadWritePaths` in `ops/errand-joy-bot.service.in` and re-run
`ops/install.sh`, rather than loosening the sandbox. `ops/install.sh` adds `--allow-run=<cmd>` only when it is set.

## Robot fund

The fund balance is the sum of ledger entries, never a stored number. It starts at $0, so
the fund tier does nothing until you add money:

```bash
bin/buy fund-add 2500 topup "manual top-up"          # $25.00 (amounts are cents)
bin/buy fund-add 15000 income "sponsor: <name>"      # tagged income
bin/buy fund
```

The fund is an accounting ledger, not a bank: also move real money into the vendor
wallet or card.

## Rotating a key

Create the new key (named `<app>-<host>-<yyyy-mm>`, with a vendor-side cap), swap it in
with `ops/set-key.sh NAME` (backs up `.env` first), restart, verify with a small test,
*then* disable (not delete) the old key on the vendor dashboard. For gate tokens:
`ops/set-key.sh --generate GATE_AGENT_TOKEN`, restart, and update the agents' copy.

## Daily checks

- `bin/buy health` shows `{"ok": true, "stopped": false}`.
- `bin/buy budgets` matches the DMs you received.
- `bin/buy list pending_approval` and `bin/buy list dm_pending`: anything stuck?
- `tail -50 INSTALL_DIR/data/cron.log`: no auth errors or repeated tick failures.
- After the nightly reconcile, no STOP (a mismatch would have tripped it).
- `journalctl -u errand-joy-bot --since today` (or `docker compose logs gate`).
- Old backups (`INSTALL_DIR.bak-*`, `backups/.env.bak-*`, unit `.bak-*`): prune a few.

## Things only the owner does

The robot and Claude can't create accounts, enter payment details or see secrets.

- Sign up with vendors, fund wallets, create capped cards.
- Create each API key with a vendor-side cap and the `<app>-<host>-<yyyy-mm>` name.
- Paste keys with `ops/set-key.sh` (or `ops/keys-from-clipboard.sh` from a Mac).
- Tap Approve or Deny on ask-tier DMs (opening the link does nothing; the button does).
- Tap the veto link if an auto, fund or joy buy looks wrong.
- Rate deliveries 1 to 5 (`bin/buy rate ID N`).
- Review and merge any new vendor adapter.
- `bin/buy unstop` after a STOP, once the cause is understood.
