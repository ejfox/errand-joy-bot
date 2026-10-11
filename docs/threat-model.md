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
- Every auto purchase is DMed with a veto link *before* a cancel window, and nothing is
  placed until the DM is delivered.
- Idempotency: reusing a key with a different payload trips STOP.

Worst case: auto-tier spend up to the caps, each with a veto DM. Set the caps to an
amount you would shrug off losing.

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

- Down: nothing is placed (no message id, no purchase); STOP at 24h; optional health
  alert at 2h.
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
  after a delivered DM. Every transition writes an event row.
- A re-decide runs right before placing; if policy now says deny (caps filled, STOP set),
  the request is denied.
- STOP blocks every transition except into denied, cancelled or expired.
- `DRY_RUN=1` is the default everywhere; `guarded()` keeps `place()` away from real
  vendors unless `DRY_RUN=0`.

## Out of scope

- A malicious owner, or an owner who approves without reading.
- Vendor fraud, delivery theft, and chargebacks.
- Whether a given vendor's terms of service allow automated ordering. That is on you;
  see the README.

## Reporting

See [SECURITY.md](../SECURITY.md).
