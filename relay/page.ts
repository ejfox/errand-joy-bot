// relay/page.ts — pure HTML renderers. No external assets, inline CSS only, and exactly ONE
// inline script (TOKEN_SCRIPT, allowed by its sha256 in the CSP; see main.ts). Every value that
// came from a record or a URL goes through esc().
import type { StoredApproval } from "./store.ts";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function dollars(cents: number): string {
  const c = Math.max(0, Math.trunc(cents));
  const whole = Math.floor(c / 100).toLocaleString("en-US");
  return `$${whole}.${String(c % 100).padStart(2, "0")}`;
}

/** RELAY_TIMEZONE (IANA zone) if valid, else "UTC". */
export function displayTimeZone(): string {
  let tz: string | undefined;
  try {
    tz = Deno.env.get("RELAY_TIMEZONE")?.trim();
  } catch {
    tz = undefined;
  }
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function fmtExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: displayTimeZone(),
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0d10;color:#eef1f4;font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px 16px}
main{max-width:440px;margin:0 auto}
h1{font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:#7bf0f9;margin:0 0 20px;font-weight:600}
.amt{font-size:44px;font-weight:700;margin:0;color:#fff;font-variant-numeric:tabular-nums}
.sum{font-size:18px;margin:12px 0 20px;white-space:pre-wrap;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0 0 28px;font-size:15px}
dt{color:#9aa4ad}dd{margin:0;overflow-wrap:anywhere}
form{margin:0 0 12px}
button{width:100%;min-height:56px;font:inherit;font-size:18px;font-weight:700;border-radius:12px;border:2px solid;cursor:pointer}
.ok{background:#7bf0f9;color:#0b0d10;border-color:#7bf0f9}
.no{background:transparent;color:#ff4d8d;border-color:#ff4d8d}
button:disabled{opacity:.35;cursor:not-allowed}
.need{color:#ff4d8d;font-size:15px;margin:0 0 12px}
.note{color:#9aa4ad;font-size:14px;margin-top:20px}
.msg{font-size:22px;margin:8px 0}
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body><main>
${body}
</main></body></html>`;
}

/** The single neutral page for unknown / expired / used / malformed. Byte-identical every time. */
export const NEUTRAL_HTML = shell(
  "Not found",
  `<h1>purchase gate</h1><p class="msg">This link is no longer valid.</p>`,
);

/**
 * The page's only script. The link is /a/<lookupId>#<token>; the fragment never reaches the
 * server, so the server-rendered page has an EMPTY token field and a disabled button. This reads
 * the token from location.hash, fills the field, enables the button, and clears the fragment from
 * the address bar (history.replaceState) so it doesn't linger in history or get copied along.
 * Without JS, or without a well-formed fragment, the button stays disabled: fail closed.
 * main.ts allows exactly this string by its sha256 in the CSP, so keep it byte-for-byte static.
 */
export const TOKEN_SCRIPT =
  `(function(){var t=location.hash.slice(1);try{history.replaceState(null,"",location.pathname)}catch(e){}` +
  `var m=document.getElementById("need");if(!/^[A-Za-z0-9_-]{32,128}$/.test(t)){` +
  `if(m)m.textContent="This link is incomplete. Open it again from your message.";return}` +
  `var i,f=document.querySelectorAll("input[name=token]");for(i=0;i<f.length;i++)f[i].value=t;` +
  `var b=document.querySelectorAll("button[type=submit]");for(i=0;i<b.length;i++)b[i].disabled=false;` +
  `if(m)m.hidden=true})();`;

/**
 * The page for one link. Each link does exactly one thing, so the page shows exactly one
 * form: an approve link renders only Approve, a deny link renders only Deny / Veto.
 * The page carries the public lookupId only; the token is filled in client-side by TOKEN_SCRIPT.
 */
export function approvalPage(a: StoredApproval, lookupId: string, role: "approve" | "deny"): string {
  const id = esc(lookupId);
  const isVeto = a.kind === "veto";
  const amount = esc(dollars(a.boundCents));
  const field = `<input type="hidden" name="token" value="">`;
  let form: string;
  let note: string;
  if (role === "approve") {
    form = `<form method="post" action="/a/${id}/approve" autocomplete="off">
${field}
<button class="ok" type="submit" disabled>Approve ${amount}</button>
</form>`;
    note = "Nothing is bought unless you approve. One tap, single use. " +
      "To decline, use the Deny link from your message instead.";
  } else {
    form = `<form method="post" action="/a/${id}/deny" autocomplete="off">
${field}
<button class="no" type="submit" disabled>${isVeto ? "Veto this purchase" : "Deny"}</button>
</form>`;
    note = isVeto
      ? "This goes ahead unless you veto it. One tap, single use."
      : "Denying cancels this request. One tap, single use. " +
        "To approve, use the Approve link from your message instead.";
  }
  const title = role === "approve" ? "Approve purchase" : isVeto ? "Veto purchase" : "Deny purchase";
  const h1 = role === "approve"
    ? "purchase gate &middot; approve"
    : isVeto
    ? "purchase gate &middot; veto"
    : "purchase gate &middot; deny";
  return shell(
    title,
    `<h1>${h1}</h1>
<p class="amt">${amount}</p>
<p class="sum">${esc(a.summary)}</p>
<dl>
<dt>Vendor</dt><dd>${esc(a.vendor)}</dd>
<dt>Expires</dt><dd>${esc(fmtExpiry(a.expiresAt))}</dd>
</dl>
<p class="need" id="need">To confirm, this page needs JavaScript turned on. Nothing has been done yet.</p>
${form}
<p class="note">${esc(note)}</p>
<script>${TOKEN_SCRIPT}</script>`,
  );
}

export function donePage(verdict: "approve" | "deny"): string {
  const msg = verdict === "approve"
    ? "Approved. The gate picks this up on its next tick."
    : "Denied. Nothing will be bought.";
  return shell("Done", `<h1>purchase gate</h1><p class="msg">${esc(msg)}</p>`);
}

export function messagePage(title: string, msg: string): string {
  return shell(title, `<h1>purchase gate</h1><p class="msg">${esc(msg)}</p>`);
}
