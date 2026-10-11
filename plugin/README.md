# errand-joy-bot (Claude Code plugin)

Gives your Claude Code agents a **capped, ledgered way to ask for purchases**. Agents request. A self-hosted gate enforces tiers, caps and a weekly joy budget in code. Only you approve, from a one-tap private link in your DM.

This directory is the client side: an MCP server, four skills and a guard hook. The gate, relay and ops scripts live in the rest of this repository, and `/errand-joy-bot:setup` walks you through them.

## Install

```bash
claude plugin marketplace add <owner>/errand-joy-bot     # your fork, e.g. on GitHub
claude plugin install errand-joy-bot@errand-joy-bot
```

Then, inside a session, run `/errand-joy-bot:setup`. Claude sets up the gate with you, mints the tokens, deploys the relay, connects the plugin and runs a mock purchase. You'll be asked for:

| Setting | What it is |
|---|---|
| **Gate URL** | Default `http://127.0.0.1:47400`. The gate binds to loopback only. From another machine use `ssh -N -L 47400:127.0.0.1:47400 <gatehost>`; never publish the gate. |
| **Gate agent token** | `GATE_AGENT_TOKEN`. Marked `sensitive`, so Claude Code keeps it in the OS credential store, not `settings.json`. It's request-only. |
| Joy paths (optional) | To-do file, notes folder, owned-items file, and whether shared household spaces are OK for joy picks (off by default). |

Requires [Deno](https://deno.com) 2.6+ on the machine running Claude Code.

## What's in here

| Piece | What it does |
|---|---|
| `.claude-plugin/plugin.json` | Manifest and `userConfig` (gate URL, agent token, joy paths). |
| `.mcp.json` → `mcp/run.sh` → `mcp/server.ts` | Stdio MCP server `gate` (Deno, official MCP TypeScript SDK pinned with a frozen `deno.lock`). `run.sh` derives `host:port` from the gate URL and starts Deno with `--allow-net=<that host:port>`, `--allow-env=EJB_GATE_URL,EJB_AGENT_TOKEN` and `--no-prompt`. Nothing else. |
| Tool `request_purchase` | Submits a `PurchaseRequest`. Fills in `idempotencyKey`, `requester` and `taskId` if missing. Its description explains tiers, reach and the joy budget. A policy denial comes back as a normal result with plain-English reasons; transport and auth failures come back as tool errors. `shipTo` isn't exposed: requests ship to the owner's configured home. |
| Tools `purchase_status`, `list_purchases`, `budget` | Read-only. `list_purchases` with no state lists open requests. `budget` shows every window and the robot fund. Joy rows come back **sealed**, with items and note removed. |
| `skills/request-purchase` | When and how an agent asks to buy, and the hard rules. |
| `skills/quiet-joy` | The weekly joy routine: 1 to 3 small things, `budget: "joy"`, `reach: "self"`, a why-note, and picks kept secret. |
| `skills/setup` | `/errand-joy-bot:setup`, user-invoked only. End-to-end install with secrets moved by pipe or clipboard. |
| `skills/doctor` | Diagnoses health, STOP, the DM path, the relay and recent ledger events with `bin/buy`. |
| `hooks/hooks.json` + `hooks/guard.ts` | PreToolUse seatbelt (see below). Self-test: `deno run --no-config hooks/guard.ts --self-test`. |
| `evals/` | `claude plugin eval` suite with mocked gate tools. |

There is deliberately **no** approve, deny, stop, unstop, fund or rate tool. `rate` exists on the gate, but only as an admin route (`/internal/rate/:id`), so it isn't exposed. `cancel` is on the agent API but isn't exposed in 0.1.

## Security model

**The real boundary is structural.** The agent and this plugin only ever hold `GATE_AGENT_TOKEN`, which can submit requests and read status. The admin token (`tick`, `fund-add`, `stop`/`unstop`, `rate`), vendor keys and `RELAY_TOKEN` stay in the gate host's `.env`. Approval is a human tapping a single-use, 24-hour link that arrives in the owner's DM. The gate stores only the link's hash, and the agent never sees it. Policy runs in code on the vendor's quoted total, and STOP blocks every transition except into denied, cancelled or expired.

**The hook is only a seatbelt.** `guard.ts` runs before every tool call and exits 2 (blocking the call, with the reason sent back to Claude) when it sees:

- a Bash command running `buy approve|unstop|fund-add|rate`, or `set-key` / `keys-from-clipboard`
- a Bash command or `Read` that reads the gate's `.env` (or its `backups/`)
- a Bash command or `WebFetch` that hits the gate's or relay's `/internal/` routes
- **any** tool input containing a relay approval link (`/a/<id>#<token>`, or the older `/a/<40+ char token>`)

It's pattern matching. A determined or compromised agent could evade it, which is why nothing depends on it. (`buy approve` isn't even a `bin/buy` subcommand, since approval is relay-only; the pattern is there in case someone adds one.) If `deno` is missing, the hook errors non-blockingly and the structural boundary still holds. The setup skill asks *you* to run the secret-touching commands in your own terminal, because the guard blocks Claude from running them. Maintainers: editing `evals/refuses-self-approval/prompt.md` while the plugin is enabled trips the guard too, since it contains a fake approval link. Disable the plugin for that edit.

Keep the gate on loopback, deploy only `relay/` publicly, and don't enable request-body logging in front of it: link tokens travel only in the `#fragment` (never sent) and in the POST body of a tap, so access logs see just the public lookupId.

## Develop and validate

```bash
deno check --config plugin/mcp/deno.json plugin/mcp/server.ts
deno run --no-config --no-lock plugin/hooks/guard.ts --self-test
claude plugin validate ./plugin && claude plugin validate .
claude plugin eval ./plugin            # runs evals/ against mocked gate tools
```

Always pass `--config plugin/mcp/deno.json` for the MCP server. A bare `deno check plugin/mcp/server.ts` from the repo root picks up the root `deno.json` and writes the SDK into the gate's lockfile. After changing an npm import, refresh the plugin's own lock: `deno cache --frozen=false --config plugin/mcp/deno.json plugin/mcp/server.ts`.

## Docs this follows (checked 2026-10-11)

- Plugins overview: https://code.claude.com/docs/en/plugins
- Manifest, `userConfig`, `sensitive` storage, `${user_config.KEY}`, `${CLAUDE_PLUGIN_ROOT}`, layout: https://code.claude.com/docs/en/plugins-reference
- Plugin MCP servers (`.mcp.json`, scoped tool names `mcp__plugin_<plugin>_<server>__<tool>`): https://code.claude.com/docs/en/mcp
- Hooks (`hooks/hooks.json`, exec form `args`, PreToolUse input, exit 2): https://code.claude.com/docs/en/hooks
- Skills (frontmatter, `disable-model-invocation`, plugin namespacing): https://code.claude.com/docs/en/skills
- Marketplaces (`marketplace.json`, relative `source`, `marketplace add owner/repo`): https://code.claude.com/docs/en/plugin-marketplaces
- Plugin evals (`prompt.md`, graders, `mocks/<server>/<tool>.md`): https://code.claude.com/docs/en/plugin-evals
