#!/usr/bin/env bash
# keys-from-clipboard.sh: OPTIONAL macOS helper. Run it in your own Terminal on your Mac.
# For each NAME it says "copy NAME now...", waits for the clipboard to change, pipes the
# new value over ssh into set-key.sh on the gate host, then clears the clipboard.
# Nothing is echoed or logged, and the value never appears on a command line or in an
# AI transcript.
#
#   EJB_SSH_HOST=<your-host> ops/keys-from-clipboard.sh VENDOR_API_KEY NOTIFY_DM_TOKEN
#
# Env:
#   EJB_SSH_HOST        required: ssh host alias or user@host of the gate machine
#   EJB_REMOTE_SET_KEY  path to set-key.sh on that host (default /opt/errand-joy-bot/ops/set-key.sh)
set -euo pipefail

[[ $# -ge 1 ]] || { echo "usage: EJB_SSH_HOST=<host> keys-from-clipboard.sh NAME [NAME...]" >&2; exit 2; }
for n in "$@"; do
  [[ "$n" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "bad NAME: $n" >&2; exit 2; }
done
command -v pbpaste >/dev/null || { echo "needs macOS pbpaste/pbcopy" >&2; exit 1; }

host="${EJB_SSH_HOST:?set EJB_SSH_HOST to the gate host (ssh alias or user@host)}"
remote="${EJB_REMOTE_SET_KEY:-/opt/errand-joy-bot/ops/set-key.sh}"

wait_for_new_clip() {
  local before="$1" now
  while :; do
    now="$(pbpaste)"
    if [[ -n "$now" && "$now" != "$before" ]]; then printf '%s' "$now"; return; fi
    sleep 0.4
  done
}

val=""
trap 'printf "" | pbcopy; unset val prev' EXIT

total=$#
i=0
prev="$(pbpaste)"
for name in "$@"; do
  i=$((i + 1))
  echo "$i/$total  copy $name now... (click the dashboard's COPY button)"
  val="$(wait_for_new_clip "$prev")"
  echo "     got it, sending..."
  printf '%s\n' "$val" | ssh -T "$host" "$remote" "$name"
  printf '' | pbcopy
  prev=""   # clipboard is now empty, so any next copy counts as a change
  val=""
done

echo
echo "(clipboard cleared) Restart the gate so it picks up the new env, on $host:"
echo "  sudo systemctl restart errand-joy-bot     (or: docker compose restart gate)"
