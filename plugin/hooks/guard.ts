// errand-joy-bot PreToolUse guard: a SEATBELT, not the boundary.
//
// The real boundary is structural: agents only ever hold the request-only agent token.
// The admin token, vendor keys and approval links live with the gate host and the
// owner's DMs. Approval happens only when a human taps a one-use link on the relay.
// This hook catches an agent that drifts toward those things anyway, and tells it why.
//
// Reads the PreToolUse JSON on stdin. Exit 0 = allow, exit 2 = block (stderr goes to Claude).
// Run directly to self-test: deno run guard.ts --self-test

type HookInput = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Directories that hold a gate install. A .env under one of these is the gate's secrets file. */
const GATE_DIR = String.raw`(errand-joy-bot|purchase-gate)`;

const RULES: { re: RegExp; why: string }[] = [
  {
    re: /(^|[\s;&|()`'"\/])buy\s+(approve|unstop|fund-add|rate)\b/,
    why: "approving, clearing STOP, adding to the fund and rating are the owner's job (admin-only `buy` commands)",
  },
  {
    re: /\b(set-key|keys-from-clipboard)(\.sh)?\b/,
    why: "minting or setting gate keys is done by the owner, never by an agent",
  },
  {
    re: /\/internal\/(tick|reconcile|fund|stop|rate|pending|verdicts)\b/,
    why: "the gate's and relay's /internal/ routes are for cron and the owner (admin or relay token), not agents",
  },
];

/** Shell verbs that read or ship a file's contents. `cp .env.example .env` during setup is fine. */
const READ_VERB =
  /(^|[\s;&|(`])(cat|less|more|head|tail|grep|egrep|rg|ag|sed|awk|source|strings|base64|xxd|od|hexdump|bat|cut|sort|uniq|diff|nl|tee|jq|python3?|node|deno|ruby|perl|scp|rsync|curl|wget|nc|open|code|vim?|nano|emacs)\b|(^|[\s;&|])\.\s+\S*\.env|<\s*\S*\.env/;

/**
 * Relay approval link: /a/<22-char lookupId>#<43-char base64url token> (the token rides in the
 * fragment), or the older /a/<43-char token>. Short paths like /a/b are not links.
 */
const APPROVE_LINK = /\/a\/[A-Za-z0-9_-]{16,64}#[A-Za-z0-9_-]{32,}|\/a\/[A-Za-z0-9_-]{40,}/;

function envPathIsGate(text: string, cwd: string): boolean {
  // a .env (not .env.example) mentioned together with a gate directory, or while working inside one
  const envRef = /(^|[\s"'=\/])\.env(\.bak[\w.-]*)?(?![\w.-])/;
  if (!envRef.test(text)) return false;
  return new RegExp(GATE_DIR + String.raw`[^\s"']*\.env`).test(text) || new RegExp(GATE_DIR).test(cwd) ||
    new RegExp(GATE_DIR + String.raw`[^\s"']*/backups\b`).test(text);
}

export function check(input: HookInput): string | null {
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const cwd = input.cwd ?? "";
  const all = JSON.stringify(ti);

  if (APPROVE_LINK.test(all)) {
    return "that input contains a relay approval link (/a/<id>#<token>). Only the owner opens or taps those; an agent must never fetch, click or forward one.";
  }

  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(ti.command ?? "");
    for (const r of RULES) if (r.re.test(cmd)) return r.why + ".";
    if (READ_VERB.test(cmd) && (envPathIsGate(cmd, cwd) || /\bbackups\/\.env/.test(cmd))) return "that reads the gate's .env (secrets). Agents never need it; use the errand-joy-bot MCP tools.";
  }

  if (tool === "Read" || tool === "Grep" || tool === "Glob") {
    const p = String(ti.file_path ?? ti.path ?? "") + " " + String(ti.pattern ?? "");
    if (envPathIsGate(p, cwd) || /\/backups\/\.env/.test(p)) return "that reads the gate's .env (secrets). Agents never need it; use the errand-joy-bot MCP tools.";
  }

  if (tool === "WebFetch") {
    const url = String(ti.url ?? "");
    if (/\/internal\//.test(url)) return "the gate's and relay's /internal/ routes are for cron and the owner, not agents.";
  }

  return null;
}

function selfTest(): void {
  const cases: [HookInput, boolean][] = [
    [{ tool_name: "Bash", tool_input: { command: "bin/buy approve 123" } }, true],
    [{ tool_name: "Bash", tool_input: { command: "cd ~/x && ./bin/buy unstop" } }, true],
    [{ tool_name: "Bash", tool_input: { command: "buy fund-add 5000 topup gift" } }, true],
    [{ tool_name: "Bash", tool_input: { command: "ops/set-key.sh --generate GATE_ADMIN_TOKEN" } }, true],
    [{ tool_name: "Bash", tool_input: { command: "curl -X DELETE http://127.0.0.1:47400/internal/stop" } }, true],
    [{ tool_name: "Bash", tool_input: { command: "cat ~/errand-joy-bot/.env" } }, true],
    [{ tool_name: "Bash", tool_input: { command: "cat .env" }, cwd: "/srv/errand-joy-bot" }, true],
    [{ tool_name: "Read", tool_input: { file_path: "/opt/errand-joy-bot/.env" } }, true],
    [{ tool_name: "WebFetch", tool_input: { url: "https://approve.example.com/a/" + "A".repeat(43) } }, true],
    [{ tool_name: "mcp__x__y", tool_input: { note: "see https://approve.example.com/a/" + "b_-9".repeat(11) } }, true],
    [{ tool_name: "WebFetch", tool_input: { url: "https://approve.example.com/a/" + "L".repeat(22) + "#" + "T".repeat(43) } }, true],
    [{ tool_name: "Bash", tool_input: { command: "open 'https://approve.example.com/a/" + "x_-Y".repeat(5) + "zz#" + "b_-9".repeat(11) + "'" } }, true],
    [{ tool_name: "Bash", tool_input: { command: "bin/buy status abc && bin/buy budgets" } }, false],
    [{ tool_name: "Bash", tool_input: { command: "bin/buy stop runaway agent" } }, false],
    [{ tool_name: "Bash", tool_input: { command: "bin/buy health" } }, false],
    [{ tool_name: "Bash", tool_input: { command: "cat .env" }, cwd: "/home/me/other-app" } , false],
    [{ tool_name: "Read", tool_input: { file_path: "/opt/errand-joy-bot/.env.example" } }, false],
    [{ tool_name: "Write", tool_input: { file_path: "README.md", content: "never run buy unstop; links look like /a/<token>" } }, false],
    [{ tool_name: "Bash", tool_input: { command: "ls src/internal/utils" } }, false],
    [{ tool_name: "Bash", tool_input: { command: "cp .env.example .env && chmod 600 .env" }, cwd: "/srv/errand-joy-bot" }, false],
    [{ tool_name: "Bash", tool_input: { command: "grep -rn GATE_ADMIN_TOKEN gate/" }, cwd: "/srv/errand-joy-bot" }, false],
    [{ tool_name: "Bash", tool_input: { command: "grep TOKEN .env" }, cwd: "/srv/errand-joy-bot" }, true],
    [{ tool_name: "Bash", tool_input: { command: "source /opt/errand-joy-bot/.env; echo hi" } }, true],
  ];
  let bad = 0;
  for (const [inp, block] of cases) {
    const got = check(inp) !== null;
    if (got !== block) {
      bad++;
      console.error(`FAIL want ${block ? "block" : "allow"}: ${JSON.stringify(inp)}`);
    }
  }
  console.error(bad ? `${bad} failing` : `all ${cases.length} cases pass`);
  Deno.exit(bad ? 1 : 0);
}

if (import.meta.main) {
  if (Deno.args.includes("--self-test")) selfTest();
  let input: HookInput = {};
  try {
    input = JSON.parse(await new Response(Deno.stdin.readable).text());
  } catch {
    Deno.exit(0); // not our business to break tool calls on malformed input
  }
  const why = check(input);
  if (why) {
    console.error(
      `errand-joy-bot guard blocked this: ${why}\n` +
        "Use the errand-joy-bot MCP tools (request_purchase, purchase_status, list_purchases, budget) and let the owner approve from their DM.",
    );
    Deno.exit(2);
  }
  Deno.exit(0);
}
