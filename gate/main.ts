// errand-joy-bot gate: entry point.
//   deno run --allow-read --allow-write --allow-env --allow-net gate/main.ts
// Policy comes from config.toml (CONFIG_PATH); secrets and endpoints from env (.env):
//   GATE_AGENT_TOKEN, GATE_ADMIN_TOKEN    bearer tokens (>= 32 chars, must differ)
//   GATE_HOST (127.0.0.1), GATE_PORT (47400)
//   DATA_DIR (./data)                     gate.db and the manual STOP file live here
//   CONFIG_PATH (./config.toml)
//   DRY_RUN (1)                           only exactly "0" is live
//   NOTIFIER (http-dm), NOTIFY_DM_URL, NOTIFY_DM_TOKEN, NOTIFY_USER_ID, HEALTH_ALERT_CMD
//   RELAY_URL, RELAY_PUBLIC_URL, RELAY_TOKEN
//   ALLOW_PUBLIC_BIND=1                   allow a non-loopback, non-tailnet GATE_HOST (don't)
import { ConfigError, loadConfig } from "./config.ts";
import { buildDeps } from "./wiring.ts";
import { serve } from "./server.ts";

export const TICK_INTERVAL_MS = 60_000;

/** Loopback (127/8, ::1, localhost) or a tailnet CGNAT address (100.64.0.0/10). */
export function isSafeBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return false;
  if (o[0] === 127) return true;
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() ? v.trim() : undefined;
}

function log(event: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export function main(): void {
  let loaded;
  try {
    loaded = loadConfig(env("CONFIG_PATH"));
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : `config: ${e instanceof Error ? e.message : e}`);
    Deno.exit(2);
  }
  for (const n of loaded.notices) log("config_notice", { notice: n });

  const host = env("GATE_HOST") ?? "127.0.0.1";
  const portRaw = env("GATE_PORT") ?? "47400";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`GATE_PORT ${JSON.stringify(portRaw)} is not a valid port`);
    Deno.exit(2);
  }
  if (!isSafeBindHost(host) && env("ALLOW_PUBLIC_BIND") !== "1") {
    console.error(
      `refusing to bind GATE_HOST=${host}: use loopback or a 100.64.0.0/10 tailnet address (ALLOW_PUBLIC_BIND=1 overrides)`,
    );
    Deno.exit(2);
  }
  const agentToken = env("GATE_AGENT_TOKEN") ?? "";
  const adminToken = env("GATE_ADMIN_TOKEN") ?? "";
  if (agentToken.length < 32 || adminToken.length < 32) {
    log("warning", { notice: "GATE_AGENT_TOKEN / GATE_ADMIN_TOKEN unset or < 32 chars: every API call will be refused" });
  }

  const dataDir = env("DATA_DIR") ?? "./data";
  Deno.mkdirSync(dataDir, { recursive: true });
  const deps = buildDeps(loaded.config, { dataDir, log });
  log("start", {
    config: loaded.source,
    dryRun: deps.dryRun,
    vendors: loaded.config.vendors,
    host,
    port,
  });

  const ac = new AbortController();
  serve({ ...deps.server, agentToken, adminToken }, { hostname: host, port, signal: ac.signal });

  // Internal tick loop (also reachable as POST /internal/tick). Orchestrator.tick() is single-flight.
  const timer = setInterval(() => {
    deps.orch.tick().then(
      (r) => {
        if (r.placed || r.denied || r.expired || r.errors || r.dmFailures) log("tick", { ...r });
      },
      (e) => log("tick_error", { error: e instanceof Error ? e.name : "error" }),
    );
  }, TICK_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(timer);
    ac.abort();
    try {
      deps.db.close();
    } catch { /* already closed */ }
    Deno.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, shutdown);
    } catch { /* unsupported platform */ }
  }
}

if (import.meta.main) main();
