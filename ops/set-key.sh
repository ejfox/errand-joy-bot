#!/usr/bin/env bash
# set-key.sh: write or replace ONE secret in the gate's .env, reading the value from
# stdin. Run it on the host that runs the gate.
#
#   ops/set-key.sh NOTIFY_DM_TOKEN                     hidden prompt (paste, then Enter)
#   printf '%s\n' "$val" | ops/set-key.sh VENDOR_KEY   piped (e.g. from keys-from-clipboard.sh)
#   ops/set-key.sh --generate GATE_ADMIN_TOKEN         mint 32 random bytes, base64url
#
# It never echoes, logs or takes the value as an argument; it prints only
# "NAME set (...last4)". Before rewriting, it copies the old .env into a backups/ dir
# next to the .env (gitignored, never deployed).
#
# Env overrides:
#   PG_ENV_FILE    default: <repo>/.env (the repo this script lives in)
#   PG_BACKUP_DIR  default: <dir of PG_ENV_FILE>/backups
# Local test:  printf 'abcdefghijklmnop\n' | PG_ENV_FILE=/tmp/x.env ops/set-key.sh FOO
# (PG_ENV_FILE must be set on set-key.sh's side of the pipe, not printf's.)
set -euo pipefail
umask 077

usage() { echo "usage: set-key.sh [--generate] NAME   (value on stdin)" >&2; exit 2; }

generate=0
if [[ "${1:-}" == "--generate" ]]; then generate=1; shift; fi
[[ $# -eq 1 ]] || usage
name="$1"
[[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "set-key: NAME must match ^[A-Z][A-Z0-9_]*\$" >&2; exit 2; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${PG_ENV_FILE:-$repo/.env}"
env_dir="$(dirname "$env_file")"
backup_dir="${PG_BACKUP_DIR:-$env_dir/backups}"
[[ -d "$env_dir" ]] || { echo "set-key: $env_dir does not exist (wrong host? set PG_ENV_FILE)" >&2; exit 1; }

# ── read the value (hidden, never echoed) ──────────────────────────────────
value=""
if [[ $generate -eq 1 ]]; then
  command -v openssl >/dev/null || { echo "set-key: --generate needs openssl" >&2; exit 1; }
  value="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
else
  if [[ -t 0 ]]; then
    IFS= read -rsp "value for $name (hidden): " value || true
    echo >&2
  else
    IFS= read -rs value || true
  fi
fi
value="${value%$'\r'}"

if [[ -z "$value" ]]; then echo "set-key: empty value, nothing written" >&2; exit 1; fi
# systemd EnvironmentFile, docker --env-file and bin/buy all read NAME=value literally;
# refuse anything that would need quoting rather than silently mangling it.
if [[ "$value" =~ [[:space:]\"\'\\\`\$#] ]]; then
  echo "set-key: value contains whitespace, a quote, backslash, \$, \` or #; refusing (nothing written)" >&2
  exit 1
fi

# ── back up the existing file (its own step, before any write) ─────────────
if [[ -e "$env_file" ]]; then
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  backup="$backup_dir/$(basename "$env_file").bak-$(date +%Y%m%d-%H%M%S)-$$"
  cp -p "$env_file" "$backup"
  chmod 600 "$backup"
  [[ -s "$backup" || ! -s "$env_file" ]] || { echo "set-key: backup failed, nothing written" >&2; exit 1; }
fi

# ── write: copy every other line, then append NAME=value, then atomic rename ─
tmp="$(mktemp "$env_dir/.env.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if [[ -e "$env_file" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$name="* || "$line" == "export $name="* ]] && continue
    printf '%s\n' "$line"
  done < "$env_file" > "$tmp"
fi
printf '%s=%s\n' "$name" "$value" >> "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$env_file"
trap - EXIT

# ── verify: exactly one line for NAME ──────────────────────────────────────
count=0
while IFS= read -r line; do [[ "$line" == "$name="* ]] && count=$((count + 1)); done < "$env_file"
[[ $count -eq 1 ]] || { echo "set-key: verify failed ($count lines for $name); backup is in $backup_dir" >&2; exit 1; }

if [[ ${#value} -ge 12 ]]; then
  echo "$name set (...${value: -4})"
else
  echo "$name set (${#value} chars, too short to show a tail)"
fi
unset value
