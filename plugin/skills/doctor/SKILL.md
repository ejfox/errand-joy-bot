---
name: doctor
description: Diagnose a sick or stuck errand-joy-bot purchase gate. Use when request_purchase or budget can't reach the gate, requests sit in dm_pending or pending_approval, approvals don't register, the gate is in STOP, or the user asks "is the purchase gate OK?". Checks health, STOP, the DM path, relay reachability and recent ledger events with bin/buy.
---

# errand-joy-bot doctor

Diagnose read-only first and change nothing until you know what's wrong. Report findings as a short checklist (●  ok, ○  problem) with one recommended fix. **Never** clear STOP, approve, fund, re-mint keys or read `.env` yourself. Those are the owner's commands, and the guard hook blocks them. Hand the user the exact command instead.

Work from the errand-joy-bot checkout on the gate host (ask where it is if unknown). `bin/buy` reads the agent token from the environment or the gate's `.env` itself and never prints it.

## 1. Can this session reach the gate?

Call the `budget` tool.
- Works: the MCP path is fine, go on.
- "agent_token is not set" or 401: the token in plugin config is missing or stale. The user re-copies it (see `/errand-joy-bot:setup` step 7). Never ask them to paste it here.
- "cannot reach the gate": go to step 2. If the gate runs on another machine, check that the SSH port-forward is up (`lsof -iTCP:47400 -sTCP:LISTEN` locally).

## 2. Is the gate alive?

On the gate host:
- `bin/buy health` should print `{"ok":true,"stopped":false}`.
- No answer: `systemctl status errand-joy-bot --no-pager` and `journalctl -u errand-joy-bot -n 60 --no-pager` (or the process they started by hand). Look for config errors (the gate refuses to start on an impossible config, such as a day cap below the auto line), port in use, or permission errors on `DATA_DIR`.
- Check cron: `crontab -l | grep -i buy`. Without the 2-minute `buy tick`, nothing advances. Requests stay in `dm_delivered` or `approved` forever.

## 3. STOP

If `stopped: true`, find out why before anyone clears it. Look in the most recent ledger events (step 5), `cat "$DATA_DIR/STOP"` if the file exists (it holds only a timestamp and a reason), and the gate log. Common causes: velocity (more than 5 requests in 10 minutes, usually a looping agent), the DM path down for 24h, or a manual stop. Explain the cause. If the user decides it's safe, **they** run `bin/buy unstop` and remove the STOP file deliberately.

## 4. DM path

- `bin/buy list dm_pending`: rows here mean the owner hasn't been notified yet. Look at `dmAttempts` and `dmLastError`.
- Quiet hours (22:00 to 07:30 in the configured timezone by default) queue DMs on purpose. That isn't a fault.
- `unknown_transport`: `NOTIFIER` names a transport that doesn't exist (only `http-dm` is implemented).
- `no_message_id`, 401 or timeouts: the DM endpoint is down, rejected the token, or didn't return a message id. Have the user check the endpoint's own health. If the token is wrong, they re-set `NOTIFY_DM_TOKEN` with `ops/set-key.sh`.
- `DRY_RUN=1` means DMs are recorded in memory and never sent. Ask the user whether that's the intent.

## 5. Recent ledger events

Find the SQLite file under `DATA_DIR` (ask the user for the path, or `ls <checkout>/data/*.db`) and read it read-only:

```
sqlite3 -readonly <db> "SELECT e.at, substr(e.request_id,1,8), e.from_state, e.to_state, e.note FROM events e ORDER BY e.id DESC LIMIT 25;"
```

Look for requests stuck in a state, repeated `dm_pending`, `policy_changed` denials, `failed` placements or `expired` approvals. **Joy requests are sealed:** don't print their items or reason. Report them only by id prefix, state and amount.

## 6. Relay

Ask the user for the relay's public origin (it's not a secret). Then:

```
curl -sI <relay>/a/not-a-real-token
```

Expect a neutral 404 with `cache-control: no-store`, `x-robots-tag: noindex, nofollow` and `referrer-policy: no-referrer`. A 5xx, TLS error or timeout means the relay is down. Point to `ops/relay-deploy.md` for their target. If approvals are tapped but nothing moves, the gate can't pull verdicts: check the gate log for relay errors, and check that `RELAY_URL` on the gate and `RELAY_TOKEN` on both sides match. The user verifies the token with set-key's `…last4` output, never by printing it.

## Report

End with: what's healthy, what's broken, the single most likely cause, and one fix. If the fix touches secrets, STOP or approvals, it's a command for the user to run, not you.
