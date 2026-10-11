// WP3 · notifications. Purchase messages go to the owner through ONE private DM transport, and fail
// closed: a send only counts when the transport returns a message id.
// The one exception is HealthAlerter: two generic infra alerts (DM path down, STOP tripped) through an
// optional local command. Purchase details and links NEVER go that way.
//
// Transport settings come from env (secrets live in .env), so a fork configures rather than edits:
//   NOTIFIER          transport name: "http-dm" (default) or "ntfy" (see NOTIFY_TRANSPORTS)
//   NOTIFY_DM_URL     http-dm endpoint (https, or http on loopback only)
//   NOTIFY_DM_TOKEN   http-dm bearer token
//   NOTIFY_USER_ID    recipient id passed as `userId`
//   NTFY_URL          ntfy server (default https://ntfy.sh; https, or http on loopback only)
//   NTFY_TOPIC        ntfy topic. On a public server the topic name IS the secret: long and random.
//   NTFY_TOKEN        optional ntfy access token (Bearer)
//   HEALTH_ALERT_CMD  optional executable for infra alerts (no-op when unset)
// Timezone and quiet hours are POLICY: they come from config.toml (config.ts), never env.
import type { DmResult, Notifier, Quote, RequestRow, ShipTo } from "./types.ts";
import { DEFAULT_HINT, HINT_MAX_CHARS, OWNER_HOME, QUIET_HOURS } from "./types.ts";

const DM_TIMEOUT_MS = 10_000;

function env(k: string): string | undefined {
  try {
    const v = Deno.env.get(k);
    return v && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** https anywhere, plain http only to a loopback host (the token must never cross a network in clear). */
export function isSafeEndpoint(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

// ── Transport: generic HTTP DM ────────────────────────────────────────────
/**
 * Generic "POST JSON, expect a message id" DM transport:
 *   POST <NOTIFY_DM_URL>  Content-Type: application/json, Authorization: Bearer <NOTIFY_DM_TOKEN>
 *   body {"userId": <NOTIFY_USER_ID>, "message": <text>}, 10s timeout, no redirects.
 * `ok` only when res.ok AND the JSON body carries a message id. Accepted id fields, in order:
 * `messageId`, `message_id`, `id` (string or number; coerced to string).
 * `error` is only ever a status code or an error class name — never the message text, because the
 * message carries the plaintext approval token and `error` gets persisted as `dmLastError`.
 */
export class HttpDmNotifier implements Notifier {
  constructor(
    private readonly url = env("NOTIFY_DM_URL") ?? "",
    private readonly token = env("NOTIFY_DM_TOKEN") ?? "",
    private readonly userId = env("NOTIFY_USER_ID") ?? "",
  ) {}

  async send(text: string): Promise<DmResult> {
    if (!this.token || !this.userId || !this.url) return { ok: false, error: "notifier_unconfigured" };
    if (!isSafeEndpoint(this.url)) return { ok: false, error: "notifier_unsafe_url" };
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.token}` },
        body: JSON.stringify({ userId: this.userId, message: text }),
        signal: AbortSignal.timeout(DM_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      return { ok: false, error: `fetch_${err instanceof Error ? err.name : "error"}` };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, error: `http_${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: "bad_json" };
    }
    const id = extractMessageId(body);
    if (!id) return { ok: false, error: "no_message_id" };
    return { ok: true, messageId: id };
  }
}

export function extractMessageId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  for (const k of ["messageId", "message_id", "id"]) {
    const v = b[k];
    if (typeof v === "string" && v.length > 0 && v.length <= 64) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

// ── Transport: ntfy ───────────────────────────────────────────────────────
export const NTFY_DEFAULT_URL = "https://ntfy.sh";
/** Shortest topic accepted on the public ntfy.sh, where anyone who knows the name can subscribe. */
export const NTFY_PUBLIC_MIN_TOPIC = 24;

/**
 * ntfy push (https://docs.ntfy.sh/publish/):
 *   POST <NTFY_URL>/<NTFY_TOPIC>  Content-Type: text/plain, Title: errand-joy-bot, Markdown: no,
 *   Authorization: Bearer <NTFY_TOKEN> (only when set); body = the message text. 10s timeout,
 *   no redirects. `ok` only on a 2xx whose JSON body has a string `id` (the ntfy message id).
 * Deliberately NO Click / Actions / Attach headers: those make the ntfy app or a browser fetch a URL
 * on its own. The approval links stay plain text in the body and open only when the owner taps them.
 * The `<...>` wrapper the DM builders put around links (it suppresses Discord previews) is removed
 * here: ntfy has no unfurler, and a linkifier that swallowed the trailing `>` into the #fragment
 * would corrupt the token. On ntfy.sh the topic must be at least NTFY_PUBLIC_MIN_TOPIC chars,
 * because there the topic name is the only thing keeping strangers from reading the links.
 * `error` is a short code only, never the text (it carries approval tokens).
 */
export class NtfyNotifier implements Notifier {
  constructor(
    private readonly baseUrl = env("NTFY_URL") ?? NTFY_DEFAULT_URL,
    private readonly topic = env("NTFY_TOPIC") ?? "",
    private readonly token = env("NTFY_TOKEN") ?? "",
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async send(text: string): Promise<DmResult> {
    if (!this.topic) return { ok: false, error: "notifier_unconfigured" };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.topic)) return { ok: false, error: "ntfy_bad_topic" };
    if (!isSafeEndpoint(this.baseUrl)) return { ok: false, error: "notifier_unsafe_url" };
    const base = new URL(this.baseUrl);
    if (base.search || base.hash) return { ok: false, error: "notifier_unsafe_url" };
    if (base.hostname === "ntfy.sh" && this.topic.length < NTFY_PUBLIC_MIN_TOPIC) {
      return { ok: false, error: "ntfy_topic_guessable" };
    }
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      "Title": "errand-joy-bot",
      "Markdown": "no",
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${base.origin}${base.pathname.replace(/\/+$/, "")}/${this.topic}`, {
        method: "POST",
        headers,
        body: text.replace(/<(https?:\/\/[^\s<>]+)>/g, "$1"),
        signal: AbortSignal.timeout(DM_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      return { ok: false, error: `fetch_${err instanceof Error ? err.name : "error"}` };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, error: `http_${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: "bad_json" };
    }
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 64) return { ok: false, error: "no_message_id" };
    return { ok: true, messageId: id };
  }
}

/** In-memory notifier for DRY_RUN and tests. `fail` makes every send fail closed. */
export class FakeNotifier implements Notifier {
  messages: string[] = [];
  fail = false;
  private n = 0;
  send(text: string): Promise<DmResult> {
    if (this.fail) return Promise.resolve({ ok: false, error: "fake_down" });
    this.messages.push(text);
    return Promise.resolve({ ok: true, messageId: `fake-${++this.n}` });
  }
}

/**
 * Transport registry: the seam for new DM channels. A transport is anything implementing `Notifier`
 * whose `send` resolves ok ONLY once the platform confirms delivery with a message id. To add one
 * (Discord bot, Telegram, ...), write a class and register a factory here that reads its own env.
 */
export const NOTIFY_TRANSPORTS: Record<string, () => Notifier> = {
  "http-dm": () => new HttpDmNotifier(),
  "ntfy": () => new NtfyNotifier(),
  // "discord-bot": () => new DiscordBotNotifier(),   // future
  // "telegram": () => new TelegramNotifier(),         // future
};

/** FakeNotifier unless DRY_RUN is exactly "0". An unknown transport fails closed (never sends). */
export function makeNotifier(): Notifier {
  if (env("DRY_RUN") !== "0") return new FakeNotifier();
  const name = env("NOTIFIER") ?? "http-dm";
  const make = Object.hasOwn(NOTIFY_TRANSPORTS, name) ? NOTIFY_TRANSPORTS[name] : undefined;
  if (!make) return { send: () => Promise.resolve({ ok: false, error: "unknown_transport" }) };
  return make();
}

// ── Quiet hours ───────────────────────────────────────────────────────────
export interface QuietHoursConfig {
  start: number; // minutes after local midnight
  end: number;
  tz: string;
  off?: boolean;
}

function hm(s: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" → minutes after midnight, or undefined when malformed. */
export function parseHm(s: string): number | undefined {
  return hm(s);
}

/** The default timezone (types.ts). The configured one comes from config.ts. */
export function gateTimezone(): string {
  return QUIET_HOURS.tz;
}

/**
 * Quiet hours from "HH:MM" strings in `tz` (config.ts passes config.toml values). Defaults to the
 * types.ts window. Equal start and end means off. Malformed values throw (config.ts validates first).
 */
export function quietHoursConfig(
  start: string = QUIET_HOURS.start,
  end: string = QUIET_HOURS.end,
  tz: string = QUIET_HOURS.tz,
): QuietHoursConfig {
  const s = hm(start), e = hm(end);
  if (s === undefined || e === undefined) throw new Error("quiet hours must be HH:MM");
  if (!validTz(tz)) throw new Error(`invalid timezone ${tz}`);
  return s === e ? { start: s, end: e, tz, off: true } : { start: s, end: e, tz };
}

/** Minutes after local midnight in `tz`. */
export function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return (h % 24) * 60 + m;
}

/** True inside the quiet window (default 22:00–07:30 America/New_York; wraps midnight). */
export function inQuietHours(now: Date, cfg: QuietHoursConfig = quietHoursConfig()): boolean {
  if (cfg.off || cfg.start === cfg.end) return false;
  const mins = localMinutes(now, cfg.tz);
  return cfg.start > cfg.end ? mins >= cfg.start || mins < cfg.end : mins >= cfg.start && mins < cfg.end;
}

// ── Message builders ──────────────────────────────────────────────────────
export function fmtCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

/** Wrap a URL in <> so chat clients (Discord et al.) show no link preview. */
export function link(url: string): string {
  return `<${url}>`;
}

/**
 * Agent-supplied text (reason, titles, requester) is untrusted. Neutralise anything that could pass
 * as a link or formatting in the DM (a fake "approve here" URL is the obvious attack), collapse
 * whitespace and cap the length.
 */
export function clean(s: string | undefined, max = 140): string {
  if (!s) return "";
  // deno-lint-ignore no-control-regex -- stripping control characters is the point
  let t = s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ");
  t = t.replace(/[<>`*_~|\[\]()@#\\]/g, "");
  t = t.replace(/:\/\//g, " ").replace(/\bhttps?\b/gi, "hxxp").replace(/\bwww\./gi, "www ");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function itemsLine(row: Pick<RequestRow, "items">): string {
  const parts = row.items.slice(0, 5).map((i) => `${i.qty}× ${clean(i.title || i.sku, 60)}`);
  if (row.items.length > 5) parts.push(`+${row.items.length - 5} more`);
  return parts.join(", ");
}

type DmRow = Pick<RequestRow, "requester" | "vendor" | "items" | "reason"> & { shipTo?: ShipTo };

/** "ship to: Jane D., Springfield" for third-party addresses; nothing for the owner's own address. */
function shipLine(row: DmRow): string[] {
  const s = row.shipTo;
  if (!s || s === OWNER_HOME) return [];
  return [`ship to: ${clean(s.name, 60)}, ${clean(s.city, 40)} ${clean(s.state, 20)} (someone else)`];
}

/**
 * What a sealed DM may say about WHERE the money goes: a vendor category, never a product.
 * Unknown vendors fall back to their (cleaned) id, which names a shop, not an item.
 */
export const VENDOR_LABELS: Record<string, string> = {
  zinc: "Amazon via Zinc",
  mock: "the mock shop",
};

export function vendorLabel(vendor: string): string {
  return Object.hasOwn(VENDOR_LABELS, vendor) ? VENDOR_LABELS[vendor] : clean(vendor, 40);
}

/** The agent's teaser for a sealed DM, or the default. Never the item. */
export function sealedHint(row: Pick<RequestRow, "hint">): string {
  return clean(row.hint, HINT_MAX_CHARS) || DEFAULT_HINT;
}

export interface Headroom {
  dayCents: number;
  monthCents: number;
}

/**
 * Ask tier: TWO links, each with its own token. The approve link can only approve and the deny
 * link can only deny. Each token sits in its link's #fragment, so opening a link (or a preview
 * crawler fetching it) never sends a token to the relay; the approve token reaches the relay only
 * when the owner taps Approve on the page.
 * `sealed` (reach self/world with [notify] sealed = true): amount, headroom, vendor category and the
 * agent's hint only. No title, URL, SKU, reason or requester. The why-note on delivery reveals it.
 */
export function approvalDm(
  row: DmRow & { hint?: string },
  q: Pick<Quote, "totalCents">,
  approveUrl: string,
  denyUrl: string,
  opts: { ttlHours?: number; headroom?: Headroom; sealed?: boolean } = {},
): string {
  const h = opts.headroom;
  if (opts.sealed) {
    return [
      `purchase-gate: sealed request for ${fmtCents(q.totalCents)} from ${vendorLabel(row.vendor)}`,
      `hint: ${sealedHint(row)}`,
      ...(h ? [`if approved: ${fmtCents(h.dayCents)} left today, ${fmtCents(h.monthCents)} this month`] : []),
      `sealed: what it is and why arrive with the delivery`,
      `approve (${opts.ttlHours ?? 24}h): ${link(approveUrl)}`,
      `deny: ${link(denyUrl)}`,
    ].join("\n");
  }
  return [
    `purchase-gate: ${clean(row.requester, 40)} wants ${fmtCents(q.totalCents)} from ${clean(row.vendor, 40)}`,
    `items: ${itemsLine(row)}`,
    ...shipLine(row),
    `why: ${clean(row.reason)}`,
    ...(h ? [`if approved: ${fmtCents(h.dayCents)} left today, ${fmtCents(h.monthCents)} this month`] : []),
    `approve (${opts.ttlHours ?? 24}h): ${link(approveUrl)}`,
    `deny: ${link(denyUrl)}`,
  ].join("\n");
}

/** Auto tier pre-order notice with a deny-only link. Joy variant NEVER names the item. */
export function vetoDm(
  row: DmRow & { hint?: string },
  q: Pick<Quote, "totalCents">,
  url: string,
  opts: { joy?: boolean; windowMin?: number } = {},
): string {
  if (opts.joy) {
    const hint = row.hint ? ` (hint: ${sealedHint(row)})` : "";
    return `robot spent ${fmtCents(q.totalCents)} on something this week${hint}. tap to veto: ${link(url)}`;
  }
  return [
    `purchase-gate: buying ${fmtCents(q.totalCents)} from ${clean(row.vendor, 40)} in ${opts.windowMin ?? 10} min unless you veto`,
    `items: ${itemsLine(row)}`,
    ...shipLine(row),
    `why: ${clean(row.reason)}`,
    `veto: ${link(url)}`,
  ].join("\n");
}

function fmtWindow(min: number): string {
  return min % 60 === 0 ? `${min / 60}h` : `${min} min`;
}

/** Fund tier: paid from the robot fund after a veto window (default 2h). */
export function fundVetoDm(
  row: DmRow & { hint?: string },
  q: Pick<Quote, "totalCents">,
  url: string,
  windowMin = 120,
  opts: { sealed?: boolean; headroom?: Headroom; fundAfterCents?: number } = {},
): string {
  if (opts.sealed) {
    const h = opts.headroom;
    return [
      `purchase-gate: robot fund pays ${fmtCents(q.totalCents)} to ${vendorLabel(row.vendor)} in ${fmtWindow(windowMin)} unless you veto (sealed)`,
      `hint: ${sealedHint(row)}`,
      ...(opts.fundAfterCents !== undefined ? [`fund after: ${fmtCents(opts.fundAfterCents)}`] : []),
      ...(h ? [`caps: ${fmtCents(h.dayCents)} left today, ${fmtCents(h.monthCents)} this month`] : []),
      `veto: ${link(url)}`,
    ].join("\n");
  }
  return [
    `purchase-gate: robot fund pays ${fmtCents(q.totalCents)} to ${clean(row.vendor, 40)} in ${fmtWindow(windowMin)} unless you veto`,
    `items: ${itemsLine(row)}`,
    `why: ${clean(row.reason)}`,
    `veto: ${link(url)}`,
  ].join("\n");
}

/**
 * THE REVEAL: after a silent, sealed or joy purchase is delivered, the envelope opens: what it is,
 * why the robot picked it (whyNote, else reason) and the item link when there is one. The link was
 * validated as https at intake and is wrapped in <> (no preview); it carries no approval token.
 */
export function deliveredWhyNoteDm(row: Pick<RequestRow, "items" | "whyNote" | "reason"> & { budget?: string }): string {
  const url = row.items.find((i) => i.url)?.url;
  return [
    `your robot's ${row.budget === "joy" ? "surprise" : "purchase"} arrived: ${itemsLine(row)}`,
    `why it picked this: ${clean(row.whyNote || row.reason, 280)}`,
    ...(url && /^https:\/\/[^\s<>]+$/.test(url) ? [`link: ${link(url)}`] : []),
  ].join("\n");
}

export function stopDm(reason: string): string {
  return `purchase-gate STOP: ${clean(reason, 120)}. every vendor is paused and nothing will be bought until STOP is cleared.`;
}

// ── Infra health alerts (optional local command) ──────────────────────────
export type HealthKind = "dm_down" | "stop_tripped";
export const HEALTH_ALERT_TEXT: Record<HealthKind, string> = {
  dm_down: "purchase-gate: DM path down >2h, robot buying paused",
  stop_tripped: "purchase-gate: STOP tripped, robot buying paused",
};
export const HEALTH_RATE_LIMIT_MS = 6 * 3600_000;

export interface HealthAlertResult {
  sent: boolean;
  skipped?: "rate_limited";
  error?: string;
}

/**
 * Generic infra alerts only. A caller-supplied text that looks like it carries a link or an amount
 * is replaced by the canonical text, so purchase details can never leak through this channel.
 * Rate limit: one alert per kind per 6h (in-memory, per process).
 */
export abstract class HealthAlerter {
  private last = new Map<HealthKind, number>();
  constructor(protected readonly clock: () => Date = () => new Date()) {}

  async alert(kind: HealthKind, text: string = HEALTH_ALERT_TEXT[kind]): Promise<HealthAlertResult> {
    const now = this.clock().getTime();
    const prev = this.last.get(kind);
    if (prev !== undefined && now - prev < HEALTH_RATE_LIMIT_MS) return { sent: false, skipped: "rate_limited" };
    this.last.set(kind, now);
    return await this.deliver(kind, safeAlertText(kind, text));
  }

  protected abstract deliver(kind: HealthKind, text: string): Promise<HealthAlertResult>;
}

export function safeAlertText(kind: HealthKind, text: string): string {
  const looksSensitive = /:\/\/|\/a\/|\$\s*\d|\d+\s*(usd|cents?)\b|[<>]|www\.|\.(com|net|org|io)\b/i.test(text);
  if (looksSensitive || !text.startsWith("purchase-gate:") || text.length > 120) return HEALTH_ALERT_TEXT[kind];
  // deno-lint-ignore no-control-regex -- stripping control characters is the point
  return text.replace(/[\u0000-\u001f\u007f"`$\\]/g, " ");
}

/**
 * Runs HEALTH_ALERT_CMD (an executable path, not a shell string) as
 *   <cmd> purchase-gate critical "<text>"
 * via an argv array, so nothing is shell-interpreted. Needs --allow-run=<cmd> in the service unit.
 */
export class CommandHealthAlerter extends HealthAlerter {
  constructor(private readonly script: string, clock?: () => Date) {
    super(clock);
  }
  protected async deliver(_kind: HealthKind, text: string): Promise<HealthAlertResult> {
    try {
      const out = await new Deno.Command(this.script, {
        args: ["purchase-gate", "critical", text],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
      return out.success ? { sent: true } : { sent: false, error: `exit_${out.code}` };
    } catch (err) {
      return { sent: false, error: err instanceof Error ? err.name : "spawn_error" };
    }
  }
}

export class FakeHealthAlerter extends HealthAlerter {
  alerts: { kind: HealthKind; text: string }[] = [];
  protected deliver(kind: HealthKind, text: string): Promise<HealthAlertResult> {
    this.alerts.push({ kind, text });
    return Promise.resolve({ sent: true });
  }
}

/** Used when HEALTH_ALERT_CMD is unset: health alerts are simply off. */
export class NoopHealthAlerter extends HealthAlerter {
  protected deliver(): Promise<HealthAlertResult> {
    return Promise.resolve({ sent: false, error: "not_configured" });
  }
}

/** Fake unless DRY_RUN is exactly "0"; then HEALTH_ALERT_CMD if set (absolute path), else no-op. */
export function makeHealthAlerter(clock?: () => Date): HealthAlerter {
  if (env("DRY_RUN") !== "0") return new FakeHealthAlerter(clock);
  const cmd = env("HEALTH_ALERT_CMD");
  if (!cmd || !cmd.startsWith("/")) return new NoopHealthAlerter(clock);
  return new CommandHealthAlerter(cmd, clock);
}
