# errand-joy-bot

A Claude Code robot that can run small errands with real money, and occasionally
surprise you.

Your agents already know what you need: the resistor that ran out mid-build, the filter
for the thing that beeps, the book you mentioned twice. errand-joy-bot lets them *ask
for it* through a small private spending gate that you control. Small things (under $40)
just happen, and you hear what and why when the box arrives. Cheap, boring things above
that go through with a heads-up DM and a veto window. Bigger things wait for your tap,
in a sealed DM that shows the amount and a hint, not the item. Anything that reaches
another person always asks, in full. And there is a little weekly **joy budget**: the
robot may pick something it thinks you'd like, say nothing, and explain itself when the
box arrives. The point is not
automation for its own sake. It is the small delight of an errand handled, and the
occasional sealed envelope.

> **What can go wrong**
>
> - **This spends real money.** Bugs, a confused agent or a prompt-injected web page can
>   all cause purchases you didn't want. The gate bounds that damage; it does not make it
>   zero. Set every cap (`config.toml`) and every vendor-side limit to an amount you
>   would shrug off losing.
> - **The example config is generous** (auto under $69, $100/day, $250/month, a $40/week
>   joy budget, a fund tier up to $1,000). Those are one person's numbers, not advice.
>   **If you are unsure, lower them** before going live.
> - **Vendor terms of service.** Many retailers forbid automated or bot ordering, and
>   accounts can be closed for it. Third-party purchasing APIs carry their own terms and
>   risks. Reading and following each vendor's ToS is your responsibility.
> - **Approval links are live credentials** for 24 hours. They sit in your DMs (or your
>   ntfy topic). Access logs in front of the relay see only the public part of the link;
>   the token is in the `#fragment`, which browsers never send.
> - No warranty (MIT). Start with `DRY_RUN=1` and the mock vendor, which moves no money.

## Quickstart (5 minutes, no money)

You need [Claude Code](https://claude.com/claude-code), [Deno 2.x](https://deno.com)
and a Linux or macOS machine to run the gate.

```bash
claude plugin marketplace add <owner>/errand-joy-bot
claude plugin install errand-joy-bot@errand-joy-bot
```

Then, inside Claude Code:

```
/errand-joy-bot:setup
```

Setup does the rest: it gets the gate onto your machine, creates `.env` and
`config.toml` (tokens minted locally, shown only as `...last4`), runs the tests, starts
the gate with `DRY_RUN=1` and the `mock` vendor, and walks you through a first fake
purchase. It stops and asks before anything that touches the network or money: relay
hosting, your DM transport, and going live.

**Notifications without running a bot:** use `NOTIFIER=ntfy`. Install the
[ntfy](https://ntfy.sh) app, mint a random topic (`ops/set-key.sh --generate NTFY_TOPIC`)
and subscribe to it. On public ntfy.sh the topic name is the only secret, so keep it long
and random, or self-host ntfy ([docs/notifiers.md](docs/notifiers.md#ntfy-shipped-recommended-zero-infra-option)).

### Manual path

```bash
git clone https://github.com/<owner>/errand-joy-bot.git ~/errand-joy-bot && cd ~/errand-joy-bot
cp .env.example .env && chmod 600 .env
ops/set-key.sh --generate GATE_AGENT_TOKEN
ops/set-key.sh --generate GATE_ADMIN_TOKEN
ops/set-key.sh --generate RELAY_TOKEN
ops/set-key.sh --generate NTFY_TOPIC                # then set NOTIFIER=ntfy in .env
cp examples/config.example.toml config.toml      # read every comment
ops/install.sh --dry && ops/install.sh --start  # tests, then a systemd unit (Linux)
bin/buy health
```

Then deploy the relay ([ops/relay-deploy.md](ops/relay-deploy.md)), subscribe to your
ntfy topic or wire up another DM transport ([docs/notifiers.md](docs/notifiers.md)), add the cron lines
([ops/crontab.txt](ops/crontab.txt)), and follow the three-stage go-live in
[docs/runbook.md](docs/runbook.md). Docker on Linux: `docker compose up -d --build`.

## Architecture

```
  your machine / server (private)                               the internet
 ┌──────────────────────────────────────────────────────┐
 │                                                      │
 │  Claude Code agent ──(GATE_AGENT_TOKEN: request only)──┐
 │                                                      │ │
 │  ┌───────────────────────── gate (127.0.0.1:47400) ──▼─┴──┐
 │  │ policy (config.toml)   tiers · caps · REACH · velocity │       ┌──────────────┐
 │  │ SQLite ledger          every state change is an event  │──────▶│ vendor APIs  │
 │  │ kill switch (STOP)     vendor keys live ONLY here      │ quote │ (via adapter │
 │  └──┬───────────────────────────┬─────────────────────────┘ place │  + guarded())│
 │     │ DM text + links           │ push hash / pull verdicts       └──────────────┘
 │     ▼                           │
 │  notifier (ntfy / http-dm) ──────────────────────────────────▶ owner's DMs
 │                                 │                                   │ tap
 └─────────────────────────────────┼───────────────────────────────────┼──────────
                                   ▼                                   ▼
                          ┌───────────────────────────────────────────────┐
                          │ relay (public, keyless): approve.example.com  │
                          │ single-use pages, token hashes, verdicts      │
                          └───────────────────────────────────────────────┘
```

The relay never calls the gate. The gate pushes approval records (token hashes only) and
pulls verdicts. Only the relay is reachable from the internet.

A request's life: **received → quoted → decided → DM delivered →** (auto: veto window /
ask: owner taps Approve / fund: veto window) **→ approved → re-decided → placed →
delivered → closed**. Silent purchases (below) skip the DM: **decided → approved →
re-decided → placed → delivered → why-note DM → closed**. Nothing *else* reaches
`placing` without a delivered DM.

## Tiers, REACH, caps and the joy budget

All numbers below are the example config; yours live in `config.toml`.

**Tiers** are computed on the vendor's *quoted* total (tax and shipping in), never the
agent's estimate:

| Quoted total | Tier | What happens |
|---|---|---|
| under $40 | auto, **silent** | no pre-order DM, no cancel window: placed on the next tick. You get a why-note DM on delivery (what it is, why the robot picked it, a link). Reach `self`/`world` only |
| $40 to $69 | auto | DM with a veto link, 10-minute cancel window, then placed |
| $69 to $500 | ask | **sealed** DM: the amount, your remaining cap headroom, the vendor category and the agent's hint, with separate Approve and Deny links. No item name. Nothing happens until you tap. Expires in 24h. Still limited by the caps below |
| $500 to $1,000 | fund | automatic only if the robot fund covers all of it; **sealed** 2-hour veto DM; paid from the fund. The fund starts at $0, so this tier is inert until you add money |
| over $1,000 | refuse | always denied |

**Silent and sealed** (`[notify]` in `config.toml`): `silent_below_cents = 4000` sets the
silent slice of the auto tier (0 turns it off) and `sealed = true` keeps item names out of
ask and fund DMs and the relay page; the agent writes a short `hint` instead ("for clear
nights"), which the gate rejects if it contains a word of the item's title. Every silent
or sealed purchase ends with a why-note DM on delivery and does not close until that DM
is delivered. Caps, velocity, STOP, REACH and the ledger apply to all of them unchanged.
Anything with reach `others` is never silent and never sealed: the DM always shows the
item, the recipient and the reason.

**REACH** is who an action touches: `self` < `world` < `others`. The effective reach is
the higher of what the agent declares and the vendor adapter's floor, so an agent can't
talk it down. **`others` always asks**, at any price and in any tier: shipping anywhere
but your own address, mailing a letter, a gift, anything involving another person.

**Rolling caps** for auto and ask purchases: $100/day, $250/month, $100/month per vendor.
In-flight money counts. Caps are **absolute**: a request that would cross any cap is
denied, and not even your approval overrides that. So the effective ask ceiling is
min(ask max, day cap), and the gate logs it at startup
(`effective ask ceiling = $100.00 (limited by caps.day_cents)` with the example config).
Fund-tier purchases are exempt from the caps because they are paid from the fund.

Config values can only tighten policy: every number in `config.toml` is capped at the
built-in ceiling unless you set `i_understand_the_risk = true`, and unknown keys are
errors.

**Velocity:** more than 5 requests in 10 minutes trips the kill switch.

**Joy budget:** $40/week, counted *inside* the monthly cap. Auto tier only, reach `self`
only. Picks under $40 are silent; picks from $40 get a sealed pre-order DM ("robot spent
$55 on something, tap to veto"), which only happens if you raise the weekly joy cap past
$40. The why-note arrives on delivery, and you can rate it 1 to 5 so the robot learns
your taste.

**Quiet hours** (22:00 to 07:30 in your time zone by default): DMs are queued, and since
nothing non-silent is placed before its DM is delivered, those purchases wait too.
Delivery why-notes wait for the morning.

## For agents: making a request

Agents hold only `GATE_AGENT_TOKEN` and submit a `PurchaseRequest` (`gate/types.ts`) with
`bin/buy request FILE.json` or `POST /api/requests`:

```json
{ "idempotencyKey": "task-42-filter", "requester": "home-agent", "taskId": "task-42",
  "vendor": "mock", "items": [{ "sku": "FILTER-20x25", "qty": 1, "title": "furnace filter" }],
  "reason": "The furnace filter is three months old and the maintenance note says replace it now.",
  "reach": "self", "maxTotalCents": 4000, "shipTo": "owner-home",
  "budget": "general" }
```

- `reason` must be at least `min_reason_chars` long (60 by default), or the gate returns 400.
- `shipTo` is `"owner-home"` (or your `owner_home_label`) for your own address, or an
  address object, which makes the reach `others` and always asks.
- `whyNote` (optional, 1 to 500 chars) is the note delivered with every silent, sealed or
  joy purchase when it arrives: what it is and why the robot picked it (falls back to
  `reason`).
- `hint` (optional, 1 to 80 chars) is the teaser a sealed DM shows instead of the item
  ("for clear nights"). It must not contain any 4+ letter word from an item title, or the
  gate returns 400. Without one, sealed DMs say "something for you".
- Orders placed outside the gate can be recorded with
  `bin/buy import-order --vendor zinc --order-id <id> --cents <n> --note "<text>"`
  (admin): they count against the caps and reconcile matches their charge. For Zinc,
  `--cents` is the order's `max_price` + 100 (the $1 fee).
- The same `idempotencyKey` with a different payload trips STOP; reuse keys only for
  true retries.

## Security model

- **The agent token is request-only.** It can submit requests and read status and budgets.
  It cannot approve, change policy, clear STOP, add fund money or see keys.
- **Vendor keys live only on the gate**, in a mode-600 `.env`, moved there by
  `ops/set-key.sh` (hidden prompt or pipe, printed only as `...last4`). Each key also has
  a vendor-side spend limit, because that is the control that still holds if the gate
  host is compromised.
- **The gate is private.** Loopback only, systemd-hardened, with a Deno `--allow-net`
  allowlist of exactly the notifier, the relay and your vendors' API hosts.
- **The relay is keyless.** It stores token hashes, public link ids and verdicts, and
  never calls the gate. A compromised relay can always deny, but it cannot forge an
  approve: it can only pass along an approve token you yourself tapped.
- **Approve needs the tapped token.** The gate accepts an approve only if it carries the
  plaintext token from your DM and that token hashes to the record the gate minted.
  Approve and Deny are separate links with separate tokens; Deny and veto tokens can never
  approve.
- **Tokens never travel in a URL request.** A link is `/a/<lookupId>#<token>`. Browsers
  don't send the `#fragment`, so link unfurlers, phone previews and access logs see only
  the lookupId, which can't approve anything. Opening a link does nothing; a small script
  on the page moves the token into the form, and only the button sends it (POST body).
  Without JavaScript the page refuses to confirm. Residual: a relay that is compromised
  *and actively serving a modified page* when you open an Approve link could read the
  token from the fragment, so read the amount in your DM before tapping (see the
  [threat model](docs/threat-model.md#3-relay-compromise-or-leaked-relay_token)).
- **Fail closed.** No delivered DM, no purchase. Relay down, no approvals. Invalid
  config, no start. Nightly reconcile against the vendor's charge list trips STOP on any
  charge the ledger doesn't know.
- **Kill levels**, lightest first: `touch data/STOP` (works even if the API is wedged) →
  `bin/buy stop` → pause cards / wallets at the vendor → disable the keys.

Details: [docs/threat-model.md](docs/threat-model.md). Reporting: [SECURITY.md](SECURITY.md).

## Adding a vendor adapter

A vendor is reviewed code, not a config flip. Implement `VendorAdapter` (`gate/types.ts`):
`quote` (dry run), `place` (with a hard cap), `status`, `cancel`, `listCharges` (for the
nightly reconcile), `pause` (kill switch), plus `maxReach` and `reachFor(req)`, the reach
floor. Register it in `gate/adapters/registry.ts`, which wraps every adapter in
**`guarded()`**: DRY_RUN, STOP, pause and the hard cap are enforced around your adapter,
not by it, and effective reach is always max(declared, `reachFor`). Then list it in
`vendors`, allow its API host (`ops/install.sh --allow-net api.vendor.example`), and
create its key named `<app>-<host>-<yyyy-mm>` with a vendor-side cap.
Full guide: [docs/vendors.md](docs/vendors.md).

## Roadmap

◆ **Vendor adapters:** Zinc (retail), Mouser (electronics), Lob and Stannp (physical
mail; always `others`), Tree-Nation (trees; `world`), SkyFi (satellite imagery; `world`).
◆ **Notifiers:** `discord-bot`, `telegram`, alongside the shipped `ntfy` and generic `http-dm`.
◇ Joy-budget taste learning from delivery ratings.
◇ A spend dashboard read from the ledger.

## Repository layout

| Path | What |
|---|---|
| `gate/` | the private spending gate (Deno, Hono, `node:sqlite`) |
| `relay/` | the public, keyless approval page |
| `plugin/` | the Claude Code plugin (`/errand-joy-bot:setup` and the agent-side skill) |
| `bin/buy` | CLI for agents and admins (tokens never on the command line) |
| `ops/` | install, deploy, unit template, cron, key helpers, relay deploy guide |
| `docs/` | runbook, vendors, notifiers, threat model |
| `examples/` | `config.example.toml` |

## Credits and inspiration

Built by EJ Fox and contributors, with Claude Code. Ideas borrowed from:
the principle of least authority and capability-style tokens (the agent can ask, never
approve); two-person rules for spending; prepaid and single-merchant virtual cards as
hard outer limits; Simon Willison's writing on prompt injection and the "lethal
trifecta", which is why the agent never holds anything but a request token; and every
"tap to approve" bank notification that made a two-second human check feel normal.

License: [MIT](LICENSE).
