#!/usr/bin/env bash
# install.sh: set up the gate on THIS machine, from the checkout it lives in.
#
#   ops/install.sh --dry                     checks + print the rendered unit; writes nothing
#   ops/install.sh                           checks → data dir → deno cache/check/test → unit
#   ops/install.sh --start                   ...then (re)start the service and hit /health
#   ops/install.sh --allow-net api.vendor.example,other.example
#                                            extra hosts for --allow-net (live vendor APIs)
#   ops/install.sh --user NAME               service user (default: you; required as root)
#   ops/install.sh --skip-tests              skip `deno test` (not recommended)
#
# INSTALL_DIR is the repo root this script lives in (e.g. /opt/errand-joy-bot or
# ~/errand-joy-bot). Each step stops on failure, so a failed test never reaches the
# unit install, and the old unit is backed up before it is replaced.
# Without systemd (macOS, containers) it stops after the tests and prints the command
# to run the gate by hand. Docker users: see compose.yaml instead.
#
# Secrets are read from .env without sourcing it, and never printed.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="errand-joy-bot.service"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
TEMPLATE="$INSTALL_DIR/ops/errand-joy-bot.service.in"
ENV_FILE="$INSTALL_DIR/.env"
STAMP="$(date +%Y%m%d-%H%M%S)"

DRY=0 START=0 SKIP_TESTS=0 EXTRA_NET="" SVC_USER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry) DRY=1 ;;
    --start) START=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --allow-net) [[ $# -ge 2 ]] || { echo "--allow-net needs a value" >&2; exit 2; }; EXTRA_NET="$2"; shift ;;
    --user) [[ $# -ge 2 ]] || { echo "--user needs a value" >&2; exit 2; }; SVC_USER="$2"; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n◆ %s\n' "$*"; }
die() { echo "install: $*" >&2; exit 1; }

# Read NAME from .env without sourcing it (no code execution, no export).
env_get() {
  local name="$1" line
  [[ -r "$ENV_FILE" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#export }"
    if [[ "$line" == "$name="* ]]; then
      line="${line#"$name"=}"; line="${line%\"}"; line="${line#\"}"
      printf '%s' "$line"; return 0
    fi
  done < "$ENV_FILE"
  return 1
}

# host[:port] of a URL, or empty.
host_of() {
  local u="$1"
  [[ "$u" == *://* ]] || { printf ''; return; }
  u="${u#*://}"; u="${u%%/*}"; u="${u%%\?*}"; u="${u##*@}"
  printf '%s' "$u"
}

abs_path() {  # relative paths resolve against INSTALL_DIR (the service's WorkingDirectory)
  case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$INSTALL_DIR" "${1#./}" ;; esac
}

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

find_deno() {
  local c
  for c in "$(command -v deno 2>/dev/null || true)" "$HOME/.deno/bin/deno" /usr/local/bin/deno /usr/bin/deno; do
    if [[ -n "$c" && -x "$c" ]]; then
      readlink -f "$c" 2>/dev/null || printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

echo "errand-joy-bot install → $INSTALL_DIR"

# ── 1. preflight (read-only) ───────────────────────────────────────────────
step "1. preflight"
DENO="$(find_deno)" || die "deno not found. Install Deno 2.x: https://docs.deno.com/runtime/getting_started/installation/"
echo "deno: $DENO ($("$DENO" --version | head -1))"
[[ -f "$INSTALL_DIR/gate/main.ts" ]] || die "no gate/main.ts in $INSTALL_DIR; is this a full checkout?"
[[ -f "$TEMPLATE" ]] || die "missing $TEMPLATE"

[[ -f "$ENV_FILE" ]] || die ".env missing. Run: cp .env.example .env && chmod 600 .env, then fill it with ops/set-key.sh (see docs/runbook.md)"
mode="$(file_mode "$ENV_FILE")"
[[ "$mode" == "600" || "$mode" == "400" ]] || die ".env is mode $mode; run: chmod 600 $ENV_FILE"
NOTIFIER_NAME="$(env_get NOTIFIER || true)"; NOTIFIER_NAME="${NOTIFIER_NAME:-http-dm}"
case "$NOTIFIER_NAME" in
  http-dm) NOTIFY_KEYS="NOTIFY_DM_URL" ;;
  ntfy)    NOTIFY_KEYS="NTFY_TOPIC" ;;
  *) die "NOTIFIER=$NOTIFIER_NAME is not a known transport (http-dm, ntfy)" ;;
esac
for k in GATE_AGENT_TOKEN GATE_ADMIN_TOKEN RELAY_TOKEN RELAY_URL RELAY_PUBLIC_URL $NOTIFY_KEYS; do
  v="$(env_get "$k" || true)"
  [[ -n "$v" ]] || die "$k is empty in .env"
done
unset v
agent_tok="$(env_get GATE_AGENT_TOKEN)"; admin_tok="$(env_get GATE_ADMIN_TOKEN)"
[[ "$agent_tok" != "$admin_tok" ]] || die "GATE_AGENT_TOKEN and GATE_ADMIN_TOKEN must differ"
unset agent_tok admin_tok

GATE_HOST="$(env_get GATE_HOST || true)"; GATE_HOST="${GATE_HOST:-127.0.0.1}"
GATE_PORT="$(env_get GATE_PORT || true)"; GATE_PORT="${GATE_PORT:-47400}"
[[ "$GATE_HOST" == "127.0.0.1" || "$GATE_HOST" == "localhost" ]] \
  || die "GATE_HOST=$GATE_HOST: the gate must bind loopback (127.0.0.1). Only the relay is public."
[[ "$GATE_PORT" =~ ^[0-9]{1,5}$ ]] || die "GATE_PORT=$GATE_PORT is not a port number"
DRY_RUN_VAL="$(env_get DRY_RUN || true)"; DRY_RUN_VAL="${DRY_RUN_VAL:-1}"
DATA_DIR="$(abs_path "$(env_get DATA_DIR || echo ./data)")"
CONFIG_PATH="$(abs_path "$(env_get CONFIG_PATH || echo ./config.toml)")"
ALERT_CMD="$(env_get HEALTH_ALERT_CMD || true)"

for p in "$INSTALL_DIR" "$DATA_DIR" "$CONFIG_PATH" "$ALERT_CMD"; do
  [[ "$p" != *[,\|\&]* ]] || die "path '$p' contains a comma, | or &; pick a plainer path"
done

if [[ -f "$CONFIG_PATH" ]]; then
  echo "config: $CONFIG_PATH"
else
  echo "config: $CONFIG_PATH MISSING (step 2 copies examples/config.example.toml there; review it)"
fi

ALLOW_NET="$GATE_HOST:$GATE_PORT"
# The notifier's host (NOTIFY_DM_URL for http-dm; NTFY_URL, default https://ntfy.sh, for ntfy) and the relay.
if [[ "$NOTIFIER_NAME" == "ntfy" ]]; then
  NTFY_URL_VAL="$(env_get NTFY_URL || true)"; NTFY_URL_VAL="${NTFY_URL_VAL:-https://ntfy.sh}"
  NET_URLS=("NTFY_URL=$NTFY_URL_VAL" "RELAY_URL=$(env_get RELAY_URL)")
else
  NET_URLS=("NOTIFY_DM_URL=$(env_get NOTIFY_DM_URL)" "RELAY_URL=$(env_get RELAY_URL)")
fi
for kv in "${NET_URLS[@]}"; do
  k="${kv%%=*}"
  h="$(host_of "${kv#*=}")"
  [[ "$h" =~ ^[A-Za-z0-9.:_-]+$|^\[[0-9a-fA-F:]+\](:[0-9]+)?$ ]] || die "$k does not look like an http(s) URL"
  ALLOW_NET="$ALLOW_NET,$h"
done
if [[ -n "$EXTRA_NET" ]]; then
  [[ "$EXTRA_NET" =~ ^[A-Za-z0-9.:_,-]+$ ]] || die "--allow-net takes host[:port],host[:port]"
  ALLOW_NET="$ALLOW_NET,$EXTRA_NET"
fi

ALLOW_READ="$INSTALL_DIR,$DATA_DIR,$CONFIG_PATH"
READ_WRITE_PATHS="$DATA_DIR $INSTALL_DIR/.deno-cache"
if [[ -n "$ALERT_CMD" ]]; then
  [[ -x "$ALERT_CMD" ]] || die "HEALTH_ALERT_CMD=$ALERT_CMD is not executable"
  RUN_FLAG="--allow-run=$ALERT_CMD"
else
  RUN_FLAG="--deny-run"
fi

if [[ -z "$SVC_USER" ]]; then
  SVC_USER="$(id -un)"
  [[ "$SVC_USER" != "root" ]] || die "don't run the gate as root; pass --user NAME"
fi
id "$SVC_USER" >/dev/null 2>&1 || die "user $SVC_USER does not exist"
SVC_GROUP="$(id -gn "$SVC_USER")"

echo "user: $SVC_USER:$SVC_GROUP   data: $DATA_DIR   DRY_RUN=$DRY_RUN_VAL"
echo "allow-net: $ALLOW_NET"
echo "run: $RUN_FLAG"

# OpenRouter, Anthropic, OpenAI, Stripe live, AWS, GitHub and Slack key prefixes.
# Split with '' so this script doesn't match its own pattern.
PATTERN='sk-''or-v1-|sk-''ant-|sk-''proj-|sk_''live_|AKIA[0-9A-Z]{16}|gh''p_|xo''x[bp]-'
if command -v rg >/dev/null; then
  hits="$(rg -l -e "$PATTERN" --hidden --glob '!.git' --glob '!.env' --glob '!.env.*' \
           --glob '!data/**' --glob '!backups/**' --glob '!.deno-cache/**' "$INSTALL_DIR" || true)"
else
  hits="$(grep -rlE "$PATTERN" --exclude-dir=.git --exclude-dir=data --exclude-dir=backups \
           --exclude-dir=.deno-cache --exclude='.env*' "$INSTALL_DIR" || true)"
fi
[[ -z "$hits" ]] || { echo "secret-looking strings in source files (values not shown):" >&2; echo "$hits" >&2; exit 1; }
echo "secret scan: clean"

render() {
  sed -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
      -e "s|@USER@|$SVC_USER|g" -e "s|@GROUP@|$SVC_GROUP|g" \
      -e "s|@DENO@|$DENO|g" \
      -e "s|@ALLOW_NET@|$ALLOW_NET|g" -e "s|@ALLOW_READ@|$ALLOW_READ|g" \
      -e "s|@DATA_DIR@|$DATA_DIR|g" -e "s|@RUN_FLAG@|$RUN_FLAG|g" \
      -e "s|@READ_WRITE_PATHS@|$READ_WRITE_PATHS|g" \
      "$TEMPLATE"
}

if [[ $DRY -eq 1 ]]; then
  step "rendered unit (dry run; nothing written)"
  render
  exit 0
fi

# ── 2. data dir + config (create only; never overwrites) ──────────────────
step "2. data dir and config"
mkdir -p "$DATA_DIR" "$INSTALL_DIR/.deno-cache"
chmod 700 "$DATA_DIR"
if [[ ! -e "$CONFIG_PATH" ]]; then
  cp "$INSTALL_DIR/examples/config.example.toml" "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
  echo "copied examples/config.example.toml → $CONFIG_PATH. Review the tiers and caps before going live."
else
  echo "config exists; left untouched"
fi

# ── 3. cache + check + test ────────────────────────────────────────────────
step "3. deno cache / check / test"
(
  cd "$INSTALL_DIR"
  export DENO_DIR="$INSTALL_DIR/.deno-cache" NO_COLOR=1
  "$DENO" cache gate/main.ts
  "$DENO" check gate/main.ts
  if [[ $SKIP_TESTS -eq 0 ]]; then
    tmpdata="$(mktemp -d /tmp/ejb-test.XXXXXX)"
    # Tests never touch the network beyond loopback, never DM, never spend.
    env -u GATE_AGENT_TOKEN -u GATE_ADMIN_TOKEN DRY_RUN=1 DATA_DIR="$tmpdata" \
      "$DENO" test --allow-read --allow-write=/tmp --allow-env --allow-net=127.0.0.1
    rm -rf "$tmpdata"
  fi
)
echo "check passed"

# ── 4. unit ────────────────────────────────────────────────────────────────
if ! command -v systemctl >/dev/null || [[ ! -d /run/systemd/system ]]; then
  step "4. no systemd here; run the gate by hand (or use compose.yaml)"
  cat <<EOF
  cd $INSTALL_DIR && set -a && . ./.env && set +a && \\
  DENO_DIR=$INSTALL_DIR/.deno-cache $DENO run --cached-only --no-prompt \\
    --allow-net=$ALLOW_NET --allow-read=$ALLOW_READ --allow-write=$DATA_DIR \\
    --allow-env $RUN_FLAG gate/main.ts
EOF
  exit 0
fi

step "4. install $UNIT_PATH"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
render > "$rendered"
! grep -q '@[A-Z_]*@' "$rendered" || die "render failed: placeholder left in unit"
changed=1
if [[ -f "$UNIT_PATH" ]]; then
  if cmp -s "$rendered" "$UNIT_PATH"; then
    echo "unit unchanged"; changed=0
  else
    diff -u "$UNIT_PATH" "$rendered" || true
    sudo cp -p "$UNIT_PATH" "$UNIT_PATH.bak-$STAMP"
    echo "old unit backed up → $UNIT_PATH.bak-$STAMP"
  fi
fi
if [[ $changed -eq 1 ]]; then
  sudo install -m 644 -o root -g root "$rendered" "$UNIT_PATH"
  if command -v systemd-analyze >/dev/null; then sudo systemd-analyze verify "$UNIT_PATH" || true; fi
  sudo systemctl daemon-reload
  sudo systemctl enable "$UNIT_NAME"
  echo "unit installed (deno = $DENO)"
fi

# ── 5. start (only with --start) ───────────────────────────────────────────
if [[ $START -eq 1 ]]; then
  step "5. restart ${UNIT_NAME%.service}"
  sudo systemctl restart "$UNIT_NAME"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if out="$(curl -fsS --max-time 2 "http://$GATE_HOST:$GATE_PORT/health")"; then
      echo "health: $out"
      echo; echo "next: add the cron lines from ops/crontab.txt, then run a mock buy (docs/runbook.md)."
      exit 0
    fi
    sleep 1
  done
  echo "gate did not answer /health; recent log:" >&2
  sudo journalctl -u "$UNIT_NAME" -n 30 --no-pager >&2 || true
  exit 1
else
  echo; echo "not started (pass --start, or: sudo systemctl restart ${UNIT_NAME%.service})"
fi
