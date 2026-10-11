# Threat model

errand-joy-bot lets an AI agent spend real money. The design assumes the agent will,
at some point, be wrong, confused or hostile (prompt injection is the normal case, not
the edge case), and that any single component can be compromised. The goal is that no
single failure can spend more than the caps allow, and that most failures spend nothing.

## Assets and boundaries

| Component | Holds | Exposure |
|---|---|---|
| Agent (Claude Code + plugin) | `GATE_AGENT_TOKEN` only | runs untrusted content all day |
| Gate (`gate/`) | vendor keys, `GATE_ADMIN_TOKEN`, `RELAY_TOKEN`, notifier token, policy, ledger | loopback only |
| Relay (`relay/`) | `RELAY_TOKEN`, token **hashes**, public link ids, verdicts | public HTTPS |
| Notifier endpoint | its DM token; sees DM text, which contains approval links | private |
| Owner's chat client | DM history with links | owner's devices |
| Vendors | the actual money (wallet / card) | third party |

Policy is code plus `config.toml` on the gate host. Nothing an agent sends can change it.

## Scenarios

### 1. Prompt injection → the agent wants to buy things

A web page, issue or email tells the agent to buy something, or many things.

- The agent can only *request*. Every request is quoted by the vendor and decided by
  code on the **quoted** total, not the agent's number.
- Tiers: above the auto threshold, a human taps Approve. Above the top tier, refused.
- Rolling caps (day, month, per-vendor month, joy week) bound total auto spend, and
  in-flight requests count against them.
- **Velocity**: more than N requests in 10 minutes trips STOP for everything.
- **REACH**: anything reaching other people (shipping elsewhere, mail, gifts) always asks.
  The adapter sets the floor; the agent cannot declare its way below it.
- Every auto purchase from the silent ceiling ($40 by default) up is DMed with a veto link
  *before* a cancel window, and none of those is placed until the DM is delivered.
  Purchases below it are **silent** (scenario 9).
- Idempotency: reusing a key with a different payload trips STOP.

Worst case: auto-tier spend up to the caps; the part under the silent ceiling with no
pre-order DM at all. Set the caps to an amount you would shrug off losing.

### 2. Leaked agent token

Someone outside gets `GATE_AGENT_TOKEN`.

- The gate binds loopback, so they also need a foothold on the gate host.
- The token is **request-only**: it cannot approve, change policy, clear STOP, add fund
  money, read keys or call `/internal/*`. With it you get scenario 1, nothing more.
- Fix: `ops/set-key.sh --generate GATE_AGENT_TOKEN`, restart, update the agents.

### 3. Relay compromise (or leaked `RELAY_TOKEN`)

The relay is the public piece, so assume it can be taken over.

- It holds no vendor keys and no gate tokens, and it never calls the gate. The gate
  pulls verdicts from it.
- **It can deny, but it cannot forge an approve.** The gate stores only `sha256(token)`
  and pushes only the hash. An approve verdict is accepted only if it carries the
  plaintext approve token and that token hashes to the record the gate minted. The
  plaintext exists only in the owner's DM until the owner taps Approve. A forged or
  replayed approve is dropped and logged.
- **Opening a link gives the relay nothing.** Links are `/a/<lookupId>#<token>`. The
  lookupId is a random public id that only selects the record; the token is in the URL
  fragment, which browsers and HTTP clients never send. So Discord's unfurler, iOS link
  previews, mail scanners and any other prefetcher that GETs the link the moment the DM
  lands hand the relay only the lookupId. (Before this, the token was in the path, and a
  compromised relay could harvest approve tokens from previews before the owner tapped
  anything.) The page's one inline script, pinned by its sha256 in the CSP, copies the
  token from the fragment into the form and clears the fragment from the address bar; the
  token reaches the relay only in the POST body of an Approve or Deny tap. Without
  JavaScript the button stays disabled and nothing can be confirmed.
- **Separate Approve and Deny links (the fix for deny-to-approve).** An earlier design
  used one token for both buttons, so a relay compromised at the moment the owner tapped
  Deny could have replayed that token as an approve. Now each ask-tier DM carries two
  links with independent tokens, `approve (24h): <url>` and `deny: <url>`. The gate
  accepts an approve only with the approve token, so tapping Deny never hands the relay
  anything it can turn into an approve. Veto DMs (auto, fund, joy) carry only a deny link.
- Approves are bound to the request, vendor and quoted amount; a re-quote invalidates
  them. Caps are absolute: even an approved request is denied if it would cross a cap.
- **Residual risk:** two cases remain.
  1. When the owner taps *Approve*, the approve token passes through the relay in the
     POST body. A relay compromised at that moment can only do what the owner asked for
     anyway (approve that one request at its quoted amount, within the caps).
  2. A relay that is compromised and *actively serving its own HTML* when the owner merely
     opens an Approve link can ship a different script that reads the fragment and keeps
     the token, so it could approve without the tap. The fragment protects against
     prefetchers, logs and a relay compromised at rest (its database and logs hold no
     tokens); it cannot protect against hostile code running in the owner's browser.
     The approve is still bound to that one request, vendor and quoted amount, within
     the caps. Read the amount in the DM, not only on the page, and only open an Approve
     link you intend to tap.

  Taking the relay offline fails closed: nothing in the ask tier is approved.

### 4. Leaked approval link

DMs, chat history, notifier logs and an ntfy topic contain live links (the full link,
fragment included).

- Single-use, 24h TTL, bound to one request, vendor and amount. A leaked Deny or veto
  link can only cancel.
- Opening the link (GET) does nothing; only the POSTed button acts, and the token must be
  in the form body. Link-preview crawlers never see the token at all (it is in the
  `#fragment`).
- **Access logs no longer capture tokens.** Proxy, CDN, tunnel and platform access logs
  record request paths, and the path holds only the lookupId, which can neither approve
  nor deny. Tokens appear only in POST bodies, so don't enable request-body logging in
  front of the relay (see `ops/relay-deploy.md`).

### 5. Leaked vendor key

The gate host's `.env` leaks, or the vendor is breached.

- The attacker bypasses the gate entirely, so the gate's caps don't help. The
  **vendor-side cap** is the control here: every key has a monthly limit (2-3x expected
  use), prepaid wallets stay small with auto-reload off, card billing uses a
  single-merchant virtual card with a limit.
- **Nightly reconcile** pulls the vendor's charge list and trips STOP on any charge with
  no ledger row, so out-of-band spending is noticed within a day.
- Fix: disable the key on the vendor dashboard, pause the card, rotate (runbook).

### 6. Notifier compromise or outage

- Down: nothing non-silent is placed (no message id, no purchase); STOP at 24h; optional
  health alert at 2h. Silent purchases do not need the DM path, so they continue; their
  delivery why-notes queue and the rows stay `delivered` until the path is back. If the
  only traffic is silent, a dead notifier raises no DM-down alarm at all, and the first
  human signal is a cap denial, the nightly reconcile, or the missing why-notes.
- Compromised: it sees approval links and could tap them itself (scenario 4 applies),
  or swallow DMs while returning fake message ids, so auto-tier buys proceed without the
  owner seeing them. Caps still bound the damage, and the reconcile still runs. Use an
  endpoint you control, on loopback or over https.
- ntfy: the server operator, and on public ntfy.sh anyone who knows or guesses the
  topic, can read the links. Use a long random topic (the gate refuses fewer than 24
  characters on ntfy.sh), or a self-hosted ntfy with an access token.

### 7. Gate host compromise

Root on the gate host is game over for that host's keys: the attacker has everything in
`.env`. The remaining controls are the vendor-side caps (scenario 5) and your own
monitoring. Keep the host patched, run the gate as an unprivileged user under the
hardened systemd unit (`ProtectSystem=strict`, Deno `--allow-net` allowlist, no
`--allow-run` unless you set a health command), and don't run other internet-facing
services as the same user.

### 8. Bugs in the gate

- The state machine only reaches `placing` through `approved`, which is only reachable
  after a delivered DM, except for a row the ledger has stored as silent
  (`decided → approved` refuses anything else, and `approved → placing` needs a DM
  message id unless the stored row is silent). Every transition writes an event row.
- A re-decide runs right before placing; if policy now says deny (caps filled, STOP set),
  the request is denied.
- STOP blocks every transition except into denied, cancelled or expired.
- `DRY_RUN=1` is the default everywhere; `guarded()` keeps `place()` away from real
  vendors unless `DRY_RUN=0`.

### 9. Silent purchases (no human signal before the money moves)

By design, auto-tier purchases below `notify.silent_below_cents` ($40 by default, reach
`self` or `world` only) are placed with no pre-order DM and no veto link. The owner
hears about them only when the delivery why-note arrives.

- **Risk:** a confused or compromised agent can buy many small things with nobody
  watching. Up to the caps, every one of them can be silent: with the defaults that is
  $100/day and $250/month (and $100/month per vendor) of sub-$40 purchases before
  anything stops it.
- **Mitigations:**
  - The tier itself: silent ends at $40 and can't be raised past it without
    `i_understand_the_risk`, nor past the auto tier at all. Reach `others` is never silent.
  - Caps are unchanged and absolute; in-flight silent purchases count against them.
  - Velocity: more than 5 requests in 10 minutes trips STOP, so a burst of silent buys
    halts after a handful.
  - The ledger records every one; the nightly reconcile compares vendor charges with it
    and trips STOP on anything unexplained.
  - The delivery why-note: every silent purchase must DM the owner before it can close,
    so silent spend always becomes visible, just after the fact.
  - A silent row is bound to the quote it was judged on; a changed re-quote or a
    re-decide that is no longer silent denies it instead of placing.
- If that trade is wrong for you, set `[notify] silent_below_cents = 0`.

### 10. Sealed approvals

Ask and fund DMs (reach `self`/`world`) and the relay page show the amount, cap
headroom, vendor category and an agent-written hint, not the item. The owner approves
partly on trust; the amount, the caps and the binding to that quote are what limit it.
The hint is agent text: intake rejects one that contains any 4+ letter word of an item
title, and it is cleaned like all agent text (no links). A hostile hint can still be
misleading ("the filter you asked for"); the why-note on delivery is the check. Purchases
that reach other people are never sealed.

## Out of scope

- A malicious owner, or an owner who approves without reading.
- Vendor fraud, delivery theft, and chargebacks.
- Whether a given vendor's terms of service allow automated ordering. That is on you;
  see the README.

## Reporting

See [SECURITY.md](../SECURITY.md).
