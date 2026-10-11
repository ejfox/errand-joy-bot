#!/usr/bin/env bash
# Launch the errand-joy-bot MCP server with net access pinned to the gate's host:port.
# EJB_GATE_URL and EJB_AGENT_TOKEN arrive in the environment from .mcp.json (userConfig).
# The token never goes on argv.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
url="${EJB_GATE_URL:-}"
# Unset userConfig may arrive empty or as a literal ${user_config.gate_url}.
if [[ -z "$url" || "$url" == '${'* ]]; then url="http://127.0.0.1:47400"; export EJB_GATE_URL="$url"; fi

command -v deno >/dev/null 2>&1 || { echo "errand-joy-bot: deno is not installed (https://deno.com). Run /errand-joy-bot:setup" >&2; exit 1; }

# scheme://host[:port][/path] → host:port
if [[ ! "$url" =~ ^(https?)://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:([0-9]{1,5}))?(/.*)?$ ]]; then
  echo "errand-joy-bot: gate_url must look like http://host:port (got something else)" >&2
  exit 1
fi
scheme="${BASH_REMATCH[1]}"
host="${BASH_REMATCH[2]}"
port="${BASH_REMATCH[4]:-}"
if [[ -z "$port" ]]; then [[ "$scheme" == "https" ]] && port=443 || port=80; fi

exec deno run \
  --quiet \
  --no-prompt \
  --config "$here/deno.json" \
  --allow-net="$host:$port" \
  --allow-env=EJB_GATE_URL,EJB_AGENT_TOKEN \
  "$here/server.ts"
