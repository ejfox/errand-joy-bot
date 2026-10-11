#!/usr/bin/env bash
# deploy.sh: OPTIONAL. Ship the gate SOURCE from your workstation to a remote host over
# ssh, then run ops/install.sh there. Never ships .env, config.toml or data/.
# (If you develop on the gate host itself, skip this and run ops/install.sh directly.)
#
#   EJB_SSH_HOST=<your-host> ops/deploy.sh --dry     inspect + rsync --dry-run; changes nothing
#   EJB_SSH_HOST=<your-host> ops/deploy.sh           inspect → back up → copy → install.sh
#   EJB_SSH_HOST=<your-host> ops/deploy.sh --start   ...and restart + /health
#   Any other flags (--allow-net, --user, --skip-tests) are passed to the remote install.sh.
#
# Env:
#   EJB_SSH_HOST     required: ssh alias or user@host
#   EJB_REMOTE_DIR   install dir on the host (default /opt/errand-joy-bot)
#
# Every step is its own ssh call and set -e stops at the first failure, so a failed
# test never reaches the unit install or restart.
set -euo pipefail

REMOTE_DIR="${EJB_REMOTE_DIR:-/opt/errand-joy-bot}"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY=0
PASS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry) DRY=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --allow-net|--user) [[ $# -ge 2 ]] || { echo "$1 needs a value" >&2; exit 2; }; PASS+=("$1" "$2"); shift ;;
    --start|--skip-tests) PASS+=("$1") ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

HOST="${EJB_SSH_HOST:?set EJB_SSH_HOST to the gate host (ssh alias or user@host)}"
[[ "$REMOTE_DIR" == /*&& "$REMOTE_DIR" != "/" ]] || { echo "EJB_REMOTE_DIR must be an absolute path, not /" >&2; exit 2; }

# Excluded paths are also PROTECTED from rsync --delete on the remote side.
# rsync uses the first matching rule, so the .env.example include comes first.
EXCLUDES=(
  --include=.env.example
  --exclude=.git/ --exclude=.env --exclude='.env.*'
  --exclude=/config.toml --exclude=data/ --exclude=relay/data/ --exclude=backups/
  --exclude=.deno-cache/ --exclude='*.db' --exclude='*.db-*' --exclude=STOP
  --exclude=.DS_Store --exclude=node_modules/ --exclude='*.bak-*'
  --exclude=overlays/ --exclude=local/
)

step() { printf '\n◆ %s\n' "$*"; }
run_remote() { ssh -T "$HOST" bash -s -- "$@"; }   # script on stdin, args after --

echo "errand-joy-bot deploy → $HOST:$REMOTE_DIR"

# ── 1. local preflight ─────────────────────────────────────────────────────
step "1. local preflight: secret-pattern scan of what would ship"
[[ -f "$REPO/gate/main.ts" ]] || { echo "no gate/main.ts in $REPO; nothing to deploy" >&2; exit 1; }
# OpenRouter, Anthropic, OpenAI, Stripe live, AWS, GitHub and Slack key prefixes.
# Split with '' so this script doesn't match its own pattern.
PATTERN='sk-''or-v1-|sk-''ant-|sk-''proj-|sk_''live_|AKIA[0-9A-Z]{16}|gh''p_|xo''x[bp]-'
if command -v rg >/dev/null; then
  hits="$(rg -l -e "$PATTERN" --hidden --glob '!.git' --glob '!.env' --glob '!.env.*' \
           --glob '!data/**' --glob '!relay/data/**' --glob '!backups/**' --glob '!.deno-cache/**' "$REPO" || true)"
else
  hits="$(grep -rlE "$PATTERN" --exclude-dir=.git --exclude-dir=data --exclude-dir=backups \
           --exclude-dir=.deno-cache --exclude='.env*' "$REPO" || true)"
fi
if [[ -n "$hits" ]]; then
  echo "secret-looking strings in files that would ship (values not shown):" >&2
  echo "$hits" >&2
  exit 1
fi
echo "clean"

# ── 2. inspect ─────────────────────────────────────────────────────────────
step "2. inspect $HOST"
run_remote "$REMOTE_DIR" <<'EOF'
set -uo pipefail
dir="$1"
echo "host: $(hostname)  user: $(id -un)"
if [[ -d "$dir" ]]; then
  echo "dir exists:"; ls -la "$dir"
  [[ -f "$dir/.env" ]] && echo ".env present" || echo ".env MISSING (create it before install; see docs/runbook.md)"
else
  echo "dir $dir does not exist yet (first deploy; create it and chown it to the service user)"
fi
command -v deno >/dev/null && echo "deno: $(deno --version | head -1)" || echo "deno: not on PATH (install.sh also checks ~/.deno/bin)"
echo "service: $(systemctl is-active errand-joy-bot 2>/dev/null || true)"
ls -d "$dir".bak-* 2>/dev/null | tail -n 5 | sed 's/^/backup: /' || true
EOF

if [[ $DRY -eq 1 ]]; then
  step "3. rsync --dry-run (nothing written)"
  rsync -azn --delete --itemize-changes "${EXCLUDES[@]}" "$REPO/" "$HOST:$REMOTE_DIR/"
  echo; echo "dry run done; nothing changed."
  exit 0
fi

# ── 3. back up existing source ─────────────────────────────────────────────
step "3. back up $REMOTE_DIR → $REMOTE_DIR.bak-$STAMP (source only)"
run_remote "$REMOTE_DIR" "$STAMP" <<'EOF'
set -euo pipefail
dir="$1"; stamp="$2"; bak="$dir.bak-$stamp"
if [[ ! -d "$dir" ]]; then echo "nothing to back up (first deploy)"; exit 0; fi
[[ -e "$bak" ]] && { echo "$bak already exists; refusing" >&2; exit 1; }
# Source only: deploy never touches .env, config.toml, data/ or backups/.
rsync -a --exclude=.env --exclude='.env.*' --exclude=/config.toml --exclude=data/ \
  --exclude=backups/ --exclude=.deno-cache/ "$dir/" "$bak/"
echo "backed up $(find "$bak" -type f | wc -l | tr -d ' ') files → $bak"
EOF

# ── 4. copy ────────────────────────────────────────────────────────────────
step "4. rsync source"
rsync -az --delete --itemize-changes "${EXCLUDES[@]}" "$REPO/" "$HOST:$REMOTE_DIR/"

# ── 5. install on the host (cache, check, test, unit; restart only with --start) ─
step "5. ops/install.sh on $HOST"
args=""
if [[ ${#PASS[@]} -gt 0 ]]; then args="$(printf ' %q' "${PASS[@]}")"; fi
# shellcheck disable=SC2029  # REMOTE_DIR and flags are meant to expand locally
ssh -T "$HOST" "cd $(printf '%q' "$REMOTE_DIR") && ops/install.sh$args"

echo; echo "done. backup: $REMOTE_DIR.bak-$STAMP (prune old ones by hand)"
