// Prints the --allow-net hosts for the vendors enabled in a config.toml, comma-separated (empty
// line when none). ops/install.sh runs it:
//   deno run --allow-read=<config> gate/vendor_hosts.ts <config.toml>
// Exits non-zero on an unreadable or invalid config (install.sh stops: fail closed).
import { parseConfig } from "./config.ts";
import { vendorHosts } from "./adapters/registry.ts";

if (import.meta.main) {
  const path = Deno.args[0];
  if (!path) {
    console.error("usage: vendor_hosts.ts <config.toml>");
    Deno.exit(2);
  }
  try {
    const { config } = parseConfig(Deno.readTextFileSync(path), path);
    console.log(vendorHosts(config.vendors).join(","));
  } catch (e) {
    console.error(`vendor_hosts: ${e instanceof Error ? e.message : String(e)}`);
    Deno.exit(1);
  }
}
