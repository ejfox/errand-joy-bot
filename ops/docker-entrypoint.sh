#!/usr/bin/env bash
# docker-entrypoint.sh: start the gate inside the container with the same Deno permission
# allowlist ops/install.sh renders for systemd, computed from the environment at start.
set -euo pipefail

die() { echo "entrypoint: $*" >&2; exit 1; }

host_of() {
  local u="$1"
  [[ "$u" == *://* ]] || { printf ''; return; }
  u="${u#*://}"; u="${u%%/*}"; u="${u%%\?*}"; u="${u##*@}"
  printf '%s' "$u"
}

GATE_HOST="${GATE_HOST:-127.0.0.1}"
GATE_PORT="${GATE_PORT:-47400}"
[[ "$GATE_HOST" == "127.0.0.1" || "$GATE_HOST" == "localhost" ]] \
  || die "GATE_HOST must be loopback; use network_mode: host (see compose.yaml)"
[[ -f "${CONFIG_PATH:-/app/config.toml}" ]] || die "no config at ${CONFIG_PATH:-/app/config.toml}; mount your config.toml"

net="$GATE_HOST:$GATE_PORT"
for k in NOTIFY_DM_URL RELAY_URL; do
  h="$(host_of "${!k:-}")"
  [[ -n "$h" ]] || die "$k is not set to an http(s) URL"
  net="$net,$h"
done
if [[ -n "${EXTRA_ALLOW_NET:-}" ]]; then
  [[ "$EXTRA_ALLOW_NET" =~ ^[A-Za-z0-9.:_,-]+$ ]] || die "EXTRA_ALLOW_NET takes host[:port],host[:port]"
  net="$net,$EXTRA_ALLOW_NET"
fi

run_flag="--deny-run"
if [[ -n "${HEALTH_ALERT_CMD:-}" ]]; then
  [[ -x "$HEALTH_ALERT_CMD" ]] || die "HEALTH_ALERT_CMD=$HEALTH_ALERT_CMD is not executable in the container"
  run_flag="--allow-run=$HEALTH_ALERT_CMD"
fi

echo "gate: DRY_RUN=${DRY_RUN:-1} allow-net=$net"
exec deno run --cached-only --no-prompt \
  --allow-net="$net" \
  --allow-read=/app,"${DATA_DIR:-/app/data}","${CONFIG_PATH:-/app/config.toml}" \
  --allow-write="${DATA_DIR:-/app/data}" \
  --allow-env \
  "$run_flag" \
  gate/main.ts
