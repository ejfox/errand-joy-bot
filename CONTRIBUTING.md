# Contributing

This project moves real money, so the rules about secrets are strict.

## Before your first commit

```sh
brew install gitleaks        # or see https://github.com/gitleaks/gitleaks
deno task hooks              # turns on .githooks/pre-commit and pre-push
```

The **pre-commit** hook refuses a commit when:
- a staged file is an env, config, database, key or backup file (`.env*` except `.env.example`, `config.toml`, `*.db`, `data/`, `*.pem`, `id_*`, `*.bak-*`)
- gitleaks finds anything secret-shaped in the staged diff, using the repo's `.gitleaks.toml` (gitleaks defaults plus OpenRouter, Discord, Privacy.com, this project's own token variables, and long high-entropy values)
- a well-known key prefix appears anywhere in the diff (`sk-or-v1-`, `sk-ant-`, `sk_live_`, `AKIA`, `ghp_`, `xoxb-` and others)
- gitleaks isn't installed: the hook fails closed

The **pre-push** hook scans every commit you're about to push. **CI** (`.github/workflows/secrets.yml`) scans the full history on every push and PR. GitHub push protection is also on. `--no-verify` only moves the failure to CI.

## If a real key slips through

1. Revoke it at the vendor **first**. Treat a pushed key as compromised, even if it was only up for seconds.
2. Then remove it from history and force-push only after a maintainer agrees.
3. Open a private security advisory (see SECURITY.md) so maintainers know.

## Tests

`deno task test`, `deno task check`, `deno task lint`. New vendor adapters must go through `guarded()` in `gate/adapters/registry.ts` and ship with a mock-mode test.
