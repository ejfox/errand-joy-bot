# Security policy

errand-joy-bot moves real money, so security reports are very welcome.

## Reporting a vulnerability

**Please report privately. Do not open a public issue or pull request for a security
problem.**

1. Go to the repository's **Security** tab on GitHub.
2. Click **Report a vulnerability** (GitHub private vulnerability reporting / security
   advisories).
3. Describe the issue, the affected component (gate, relay, plugin, ops scripts) and,
   if you can, steps to reproduce.

You should get an acknowledgement within a few days. We'll work on a fix in a private
advisory, credit you if you'd like, and publish the advisory once a fix is available.

**Never include real secrets** (API keys, gate or relay tokens, live approval links) in a
report. If you found one exposed somewhere, say where, and we'll handle revocation.

## Especially interesting

- Any way for an agent holding only `GATE_AGENT_TOKEN` to approve, place, or exceed
  the configured tiers and caps.
- Any way for the relay (or someone holding `RELAY_TOKEN`) to produce an approve the
  owner did not tap.
- Ways to bypass STOP, the velocity limit, REACH floors or `DRY_RUN`.
- Token, key or approval-link leaks through logs, errors, DMs or health alerts.
- Ops scripts that print or pass secrets on command lines.

See [docs/threat-model.md](docs/threat-model.md) for what is in and out of scope.

## Supported versions

Only the latest release on the default branch gets security fixes.
