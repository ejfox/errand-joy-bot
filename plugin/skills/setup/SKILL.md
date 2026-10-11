---
name: setup
description: Set up errand-joy-bot end to end. Installs and configures the purchase gate, mints its tokens, picks a notifier, deploys the approval relay, connects this plugin, and runs a mock purchase.
disable-model-invocation: true
argument-hint: "[path to an errand-joy-bot checkout]"
---

# errand-joy-bot setup

You are setting this up **for** the user. Run the commands yourself, explain each step in a sentence, and stop at the real decisions. Go one step at a time and confirm each one worked before moving on.

## Secrets rules (read first)

- **No secret ever appears in this chat.** Not a token, not part of one, not "just to check". Tokens are minted on the gate host and moved by pipe or clipboard straight into the place that needs them.
- The plugin's guard hook blocks you from running `ops/set-key.sh`, `ops/keys-from-clipboard.sh`, `buy fund-add|unstop|rate`, or reading the gate's `.env`. That's intended. For those steps, **print the exact command and have the user run it in their own terminal** on the gate host. Typing `!` followed by the command in this prompt may also work; if the guard blocks it there, use the terminal. Then you continue from its output (which prints only `NAME set (…last4)`).
- The agent token is the only secret this plugin holds. Never put the admin token, the relay token or a vendor key into plugin config.

## 0. Find the gate code

The plugin ships only the client. The gate, relay and ops scripts live in the errand-joy-bot repository. Use `$ARGUMENTS` if a path was given. Otherwise ask where their checkout is, or offer to `git clone` it (ask for the URL of their fork). Work from the repo root from here on. Decide with the user **which machine runs the gate**: an always-on box (home server, VPS) is best. The gate listens on loopback only.

## 1. Prerequisites

Check, and report versions: `deno --version` (2.6 or newer), `curl`, `jq`, `openssl`, `sqlite3` (optional, used by the doctor). If Deno is missing, point to https://deno.com and stop. Then warm the plugin's MCP server so the first session doesn't stall: `deno cache --config "${CLAUDE_PLUGIN_ROOT}/mcp/deno.json" "${CLAUDE_PLUGIN_ROOT}/mcp/server.ts"`.

## 2. Policy file

`cp examples/config.example.toml config.toml`, then walk the user through it. Read the comments aloud in plain words. Recommend **lowering** the numbers for the first weeks (for example auto under $20, $75/day, $150/month, `fund_enabled = false`), and keep `vendors = ["mock"]` until the dry run passes. They decide the numbers; you edit the file. `config.toml` must stay gitignored (`git check-ignore config.toml`).

## 3. Environment and tokens

1. You run: `cp .env.example .env && chmod 600 .env`, and confirm `git check-ignore .env` prints `.env`.
2. The user runs these three lines (they print only `…last4`):
   ```
   ops/set-key.sh --generate GATE_AGENT_TOKEN
   ops/set-key.sh --generate GATE_ADMIN_TOKEN
   ops/set-key.sh --generate RELAY_TOKEN
   ```
3. Non-secret values (`DATA_DIR`, `CONFIG_PATH`, `NOTIFIER`, `NTFY_URL` or `NOTIFY_DM_URL` + `NOTIFY_USER_ID`, `RELAY_URL`, `RELAY_PUBLIC_URL`) also go in through set-key so the file is never opened in chat: give the user `printf '%s\n' '<value>' | ops/set-key.sh NAME` lines with the values filled in.
4. Leave `DRY_RUN=1`.

## 4. Notifier (the DM is the approval channel)

The gate DMs the owner before anything happens and sends approval links there. It fails closed: no delivered DM, no purchase.

**Offer ntfy first.** It needs no bot and no server of their own.

| Transport | Status | Notes |
|---|---|---|
| `ntfy` | **exists, recommended** | Push to the ntfy phone app. `NOTIFIER=ntfy`. The user runs `ops/set-key.sh --generate NTFY_TOPIC` (random 43 chars, printed only as `…last4`), then copies it to the clipboard without displaying it (`grep '^NTFY_TOPIC=' .env \| cut -d= -f2- \| tr -d '\n' \| pbcopy`, or `xclip -sel c` / `wl-copy`) and subscribes to it in the ntfy app. `NTFY_URL` defaults to `https://ntfy.sh`. |
| `http-dm` | **exists** | POSTs `{userId, message}` with a Bearer token to an endpoint you run (e.g. your own chat bot's DM route) and needs a message id back. Set `NOTIFY_DM_URL`, `NOTIFY_USER_ID`, and `NOTIFY_DM_TOKEN` (user pipes it in with set-key). |
| `discord-bot` | planned | Not implemented yet. |
| `telegram` | planned | Not implemented yet. |

Tell them plainly, for ntfy: **on public ntfy.sh the topic name is the secret.** Anyone who knows it can read the approval links, so it must be long and random (the gate refuses a topic under 24 characters on ntfy.sh), it never goes in chat, and it is never a guessable word. If they want more than that, they can self-host ntfy and set `NTFY_URL` (https, or http on loopback) plus an access token in `NTFY_TOKEN` (piped in with set-key). Never treat the topic as a non-secret value.

If they pick `http-dm` and have no DM endpoint yet, say plainly that the gate can't approve anything live until one exists, and that a dry run still works.

## 5. Approval relay (the only public piece)

The relay renders the one-tap Approve/Deny page. It holds no gate or vendor keys, only `RELAY_TOKEN`. Deploy **only the `relay/` folder**, never the repo root. Follow `ops/relay-deploy.md`, and help them choose:

- **Cloudflare Tunnel to a local Deno process** (recommended there): runs on a box they control, no inbound ports, SQLite on local disk. Needs a Cloudflare account and a domain on it.
- **smallweb**: easiest if they already run smallweb. Drop the folder in and it's live. Make sure the relay's `data/` is gitignored in the smallweb workspace.
- **Deno Deploy**: no server to run, but no persistent disk, so set `RELAY_STORE=kv`. Paste `RELAY_TOKEN` into its secrets UI from the clipboard.

All three log request paths. Those hold only the public lookupId of each link (`/a/<lookupId>#<token>`; the token is in the `#fragment`, which is never sent), so path logs are harmless; tell them not to enable request-body logging in front of the relay, since a tap carries the token in its POST body. The user moves `RELAY_TOKEN` to the relay host (clipboard or pipe, never chat). Verify with the doc's `curl -sI <relay>/a/not-a-real-link` check: a neutral 404 with `cache-control: no-store`.

## 6. Install and start the gate

On the gate host: `ops/install.sh --dry`, show the user the summary, then `ops/install.sh --start` once they agree. Without systemd it prints the command to run the gate by hand. Then `bin/buy health` should return `{"ok":true,"stopped":false}`.

## 7. Connect this plugin

1. The user copies the agent token to the clipboard on the gate host without displaying it, e.g. `grep '^GATE_AGENT_TOKEN=' .env | cut -d= -f2- | tr -d '\n' | pbcopy` on macOS (`xclip -sel c` / `wl-copy` on Linux). Over SSH they can pipe it into their local clipboard instead.
2. They open `/plugin`, choose errand-joy-bot, configure, and paste into **Gate agent token** (masked, stored in the OS keychain). They set **Gate URL** if the gate isn't on this machine. The gate must stay on loopback, so from another machine use `ssh -N -L 47400:127.0.0.1:47400 <gatehost>` and keep the default URL.
3. Optional: the three joy paths (to-do file, notes folder, owned-items file).
4. They run `/reload-plugins` or restart the session. Then call the `budget` tool: it should list `global/day`, `global/month` and `joy/week`.

## 8. Mock purchase, end to end

1. **Dry run** (`DRY_RUN=1`): call `request_purchase` with `vendor: "mock"`, one item (`sku: "mock-widget"`, qty 1), an honest test reason, `reach: "self"`, `maxTotalCents: 1500`. Then follow it with `purchase_status` as cron ticks (every 2 minutes) until it reaches `placed`. In dry run the DM is recorded in memory, not sent.
2. **Live DM, fake vendor**: this is the owner's call, so ask before you do it. With `vendors = ["mock"]` still the only vendor, setting `DRY_RUN=0` sends real DMs while the mock vendor still moves no money. Restart the gate, submit one ask-tier mock request (`maxTotalCents` around 8000), and have the owner tap Approve in their DM. Confirm with `purchase_status` that it moves to `approved` and then `placed`. Then put `DRY_RUN` back, or leave it at 0 only if mock is still the sole vendor.
3. Show them `bin/buy stop "setup test"` and `bin/buy health` (shows `stopped: true`). The **user** clears it with `bin/buy unstop`.

Finish with a short summary of what's running where, and one next step: watch a week of DMs before adding a real vendor (`docs/` has the vendor guide).
