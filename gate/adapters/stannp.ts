// Stannp US (https://api-us1.stannp.com) vendor adapter: postcards and letters, paid from a
// prepaid Stannp balance. Docs: https://www.stannp.com/us/direct-mail-api/guide and the LLM
// reference https://www.stannp.com/stannp-api-llm.md (read 2026-10-11).
//
// Money facts this adapter is built on:
// - Every send draws down the prepaid account balance (GET /v1/accounts/balance). Keep it small
//   and auto top-up OFF: then the balance is a hard cap. This adapter NEVER calls
//   /v1/accounts/topup (that endpoint charges the saved card).
// - `test=true` on postcards/create and letters/create "produces a sample PDF without dispatching
//   or charging" and returns the `cost`. quote() is that call, so quotes are free.
// - There is no max_price. The hard cap is enforced by re-quoting (test=true) right before the
//   live call and refusing if the re-quote exceeds it; a live cost above the cap is cancelled.
// - `idempotency_key`: an identical retried body returns the original response with HTTP 409.
// - No transactions endpoint exists. listCharges() reads GET /v1/reporting/list/:start/:end.
//
// Auth: HTTP Basic with the API key as the username and an empty password. pause() is local;
// the real kill is regenerating the API key in Stannp's account settings.
import { OWNER_HOME } from "../types.ts";
import type { Charge, Item, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";
import { checkBaseUrl, dollarsToCents, isHttpsUrl } from "./money.ts";
import { parseOwnerAddress, type ZincAddress, zincIdempotencyKey } from "./zinc.ts";

export const STANNP_DEFAULT_BASE_URL = "https://api-us1.stannp.com";
const TIMEOUT_MS = 20_000;

/**
 * What an Item's `sku` may be. `url` is the front image (postcards: https JPG/PNG/PDF, e.g. a
 * render) or the letter PDF; `title` is the postcard's back message (it is what gets printed, so
 * the owner sees it in every non-sealed DM).
 */
export const STANNP_PRODUCTS = {
  "postcard-4x6": { kind: "postcard", size: "4x6" },
  "postcard-6x9": { kind: "postcard", size: "6x9" },
  "postcard-6x11": { kind: "postcard", size: "6x11" },
  "letter": { kind: "letter", size: undefined },
} as const;
export type StannpSku = keyof typeof STANNP_PRODUCTS;
type Kind = "postcard" | "letter";

export interface StannpAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** The owner's address, Zinc shape (OWNER_SHIP_TO_JSON): raw JSON, base64 JSON, or an object. */
  ownerShipTo?: string | ZincAddress;
  /**
   * Rehearsal only (the opt-in live test): place() also sends test=true, so nothing is mailed
   * or charged. Never set from env: a production gate must not record fake placements.
   */
  testMode?: boolean;
  fetchImpl?: typeof fetch;
}

/** A Stannp failure where money MAY have moved (or we can't tell): the gate records outcome_unknown. */
export class StannpError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "StannpError";
  }
}

/** Stannp's mailpiece object (GET /v1/postcards/get/:id, reporting list "singles"). */
interface StannpMailpiece {
  id?: number | string;
  status?: string;
  type?: string;
  cost?: string | number;
  timestamp?: string;
  created?: string;
  tracking_ref?: string | null;
  tags?: string;
}

/** Map a gate request's single item to a Stannp product. Refuses (pre-network) anything else. */
export function stannpProduct(req: PurchaseRequest): { kind: Kind; size?: string; item: Item } {
  if (req.items.length !== 1) throw new GuardRefused("stannp_one_item_only");
  const item = req.items[0];
  if (item.qty !== 1) throw new GuardRefused("stannp_qty_must_be_1");
  if (!Object.hasOwn(STANNP_PRODUCTS, item.sku)) throw new GuardRefused("stannp_unknown_sku");
  const p = STANNP_PRODUCTS[item.sku as StannpSku];
  if (!item.url || !isHttpsUrl(item.url)) throw new GuardRefused(p.kind === "letter" ? "stannp_letter_pdf_url_missing" : "stannp_front_image_url_missing");
  return { kind: p.kind, size: p.size, item };
}

/** `postcard:<id>` / `letter:<id>`: status() and cancel() need to know which endpoint to use. */
export function stannpOrderId(kind: string, id: unknown): string | undefined {
  const k = kind === "postcard" || kind === "letter" ? kind : undefined;
  const n = typeof id === "number" ? String(id) : typeof id === "string" ? id : "";
  if (!k || !/^[1-9]\d{0,15}$/.test(n)) return undefined;
  return `${k}:${n}`;
}

function parseOrderId(vendorOrderId: string): { kind: Kind; id: string } {
  const m = /^(postcard|letter):([1-9]\d{0,15})$/.exec(vendorOrderId);
  if (!m) throw new StannpError("stannp_bad_order_id");
  return { kind: m[1] as Kind, id: m[2] };
}

/**
 * Stannp mailpiece status → gate status. `returned` maps to delivered, NOT failed: the piece was
 * printed and posted, the money is spent, and the gate drops failed/cancelled rows from its
 * window totals. raw.status keeps the truth.
 */
export function mapStannpStatus(status: string | undefined): "open" | "shipped" | "delivered" | "cancelled" {
  switch (status) {
    case "handed_over":
    case "dispatched":
    case "local_delivery":
      return "shipped";
    case "delivered":
    case "returned":
      return "delivered";
    case "cancelled":
      return "cancelled";
    default: // received, producing, printing, unknown
      return "open";
  }
}

function owner(raw: string | ZincAddress | undefined): ZincAddress {
  try {
    return parseOwnerAddress(raw);
  } catch (e) {
    if (e instanceof GuardRefused) throw new GuardRefused(e.code.replace(/^zinc_/, "stannp_"));
    throw e;
  }
}

/** Recipient form fields for the owner (self) or the gate's third-party ShipTo (others). */
export function stannpRecipient(req: PurchaseRequest, ownerShipTo: string | ZincAddress | undefined): Record<string, string> {
  if (req.shipTo === undefined || req.shipTo === OWNER_HOME) {
    const a = owner(ownerShipTo);
    if (a.country !== "US") throw new GuardRefused("stannp_us_only");
    return {
      "recipient[firstname]": a.first_name,
      "recipient[lastname]": a.last_name,
      "recipient[address1]": a.address_line1,
      ...(a.address_line2 ? { "recipient[address2]": a.address_line2 } : {}),
      "recipient[city]": a.city,
      "recipient[state]": a.state ?? "",
      "recipient[zipcode]": a.postal_code,
      "recipient[country]": "US",
    };
  }
  const s = req.shipTo;
  const name = s.name.trim().replace(/\s+/g, " ");
  if (!/^\d{5}(-\d{4})?$/.test(s.zip.trim())) throw new GuardRefused("stannp_recipient_bad_zip");
  if (!/^[A-Za-z]{2}$/.test(s.state.trim())) throw new GuardRefused("stannp_recipient_bad_state");
  const cut = name.lastIndexOf(" ");
  return {
    "recipient[firstname]": cut > 0 ? name.slice(0, cut) : name,
    "recipient[lastname]": cut > 0 ? name.slice(cut + 1) : "",
    "recipient[address1]": s.line1.trim(),
    "recipient[city]": s.city.trim(),
    "recipient[state]": s.state.trim().toUpperCase(),
    "recipient[zipcode]": s.zip.trim(),
    "recipient[country]": "US",
  };
}

export class StannpAdapter implements VendorAdapter {
  readonly id = "stannp";
  /** Mail can reach anyone. */
  readonly maxReach: Reach = "others";
  paused = false;

  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly ownerShipTo?: string | ZincAddress;
  readonly testMode: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: StannpAdapterOptions = {}) {
    this.apiKey = opts.apiKey ?? "";
    this.baseUrl = checkBaseUrl(opts.baseUrl || STANNP_DEFAULT_BASE_URL, "STANNP_BASE_URL");
    this.ownerShipTo = opts.ownerShipTo;
    this.testMode = opts.testMode === true;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** A postcard to the owner's own address is "self"; mail to anyone else is "others" (always asks). */
  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "self" : "others";
  }

  /** The create call with test=true: Stannp renders a sample PDF and returns `cost`; nothing is mailed or charged. */
  async quote(req: PurchaseRequest): Promise<Quote> {
    const { kind, size } = stannpProduct(req);
    const cost = await this.testCost(req);
    return {
      subtotalCents: cost,
      taxCents: 0,
      shippingCents: 0, // US prices include postage
      totalCents: cost,
      currency: "USD",
      vendorRef: `stannp:${kind}${size ? `-${size}` : ""}`,
      quotedAt: new Date().toISOString(),
      raw: { kind, size, test: true },
    };
  }

  /**
   * Re-quotes (test=true) and checks the balance BEFORE the live call: either over the cap or a
   * short balance refuses with GuardRefused (nothing was sent). The live create carries the
   * idempotency key (also in `tags`, so the piece can be found in reporting). A network error is
   * retried once with the identical body (Stannp answers a duplicate with 409 + the original).
   * chargedCents = the live `cost`. A live cost above the hard cap is cancelled and thrown.
   */
  async place(req: PurchaseRequest, _q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.apiKey) throw new GuardRefused("stannp_api_key_missing");
    const { kind } = stannpProduct(req);
    let requote: number;
    try {
      requote = await this.testCost(req);
    } catch (e) {
      if (e instanceof GuardRefused) throw e;
      throw new GuardRefused(`stannp_requote_failed:${e instanceof StannpError ? e.code : "error"}`);
    }
    if (requote > hardCapCents) throw new GuardRefused("max_price_exceeded");
    if (!this.testMode) {
      let bal: number;
      try {
        bal = await this.balance();
      } catch {
        throw new GuardRefused("stannp_balance_unavailable");
      }
      if (bal < requote) throw new GuardRefused("stannp_insufficient_balance");
    }

    const key = await zincIdempotencyKey(idempotencyKey);
    const form = this.form(req, { idempotency_key: key, tags: `ejb-${key}` });
    if (this.testMode) form.set("test", "true");
    let res: { status: number; json: unknown } | undefined;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await this.send("POST", `/v1/${kind}s/create`, form);
      } catch {
        if (attempt === 1) throw new StannpError("stannp_network_error"); // may or may not have reached Stannp
      }
    }
    const { status, json } = res!;
    const body = (json && typeof json === "object" ? json : {}) as { success?: boolean; data?: StannpMailpiece };
    // 409 = this exact body was already accepted: the original response is the answer.
    if (!(status === 200 || status === 201 || status === 409) || body.success !== true || !body.data) {
      if (status === 401) throw new GuardRefused("stannp_unauthorized"); // no key → nothing created
      throw new StannpError(status >= 500 ? "stannp_server_error" : `stannp_http_${status}`, status);
    }
    const d = body.data;
    const cost = dollarsToCents(d.cost);
    if (this.testMode) {
      if (d.status !== "test" || cost === undefined) throw new StannpError("stannp_test_mode_not_honoured");
      return { vendorOrderId: `${kind}:test-${key}`, chargedCents: 0, raw: { status: "test" } };
    }
    if (d.status === "test") throw new StannpError("stannp_unexpected_test_response");
    const id = stannpOrderId(kind, d.id);
    if (!id || cost === undefined) throw new StannpError("stannp_malformed_order");
    if (cost > hardCapCents) {
      const cancelled = await this.cancel(id).catch(() => false);
      throw new StannpError(cancelled ? "stannp_cost_over_cap_cancelled" : "stannp_cost_over_cap", status);
    }
    return { vendorOrderId: id, chargedCents: cost, raw: { status: d.status } };
  }

  async status(vendorOrderId: string) {
    const { kind, id } = parseOrderId(vendorOrderId);
    const d = await this.data("GET", `/v1/${kind}s/get/${id}`) as StannpMailpiece;
    return {
      state: mapStannpStatus(d.status),
      tracking: typeof d.tracking_ref === "string" && d.tracking_ref ? d.tracking_ref : undefined,
      raw: { status: d.status },
    };
  }

  /** POST /v1/{postcards|letters}/cancel: only before Stannp starts processing. Otherwise false. */
  async cancel(vendorOrderId: string): Promise<boolean> {
    const { kind, id } = parseOrderId(vendorOrderId);
    const { status, json } = await this.send("POST", `/v1/${kind}s/cancel`, new URLSearchParams({ id }));
    const b = (json && typeof json === "object" ? json : {}) as { success?: boolean; data?: unknown };
    if (status >= 500) throw new StannpError("stannp_server_error", status);
    if (status === 401) throw new StannpError("stannp_unauthorized", status);
    return status === 200 && b.success === true && (b.data === 1 || b.data === true || b.data === "1");
  }

  /**
   * GET /v1/reporting/list/:start/:end (dates inclusive, YYYY-MM-DD, start = the UTC date of
   * sinceISO). One charge per non-cancelled mailpiece at or after sinceISO, amount = `cost`, id =
   * `postcard:<id>` / `letter:<id>` (the same string place() returned, so reconcile matches).
   * Stannp's "YYYY-MM-DD HH:MM:SS" timestamps carry no zone; they are read as UTC.
   */
  async listCharges(sinceISO: string): Promise<Charge[]> {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) throw new StannpError("stannp_bad_since");
    // A day early: Stannp's report dates may be US-local; the timestamp filter below trims the rest.
    const start = new Date(since - 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Math.max(Date.now(), since)).toISOString().slice(0, 10);
    const data = await this.data("GET", `/v1/reporting/list/${start}/${end}`) as { singles?: StannpMailpiece[] };
    const out: Charge[] = [];
    for (const p of data?.singles ?? []) {
      if (p.status === "cancelled") continue;
      // Types this adapter never places (greeting cards, self-mailers...) still count: they are
      // money out of the balance, and with no ledger row they trip STOP as they should.
      const type = String(p.type ?? "mailpiece").replace(/[^a-z_-]/gi, "").slice(0, 32) || "mailpiece";
      const id = stannpOrderId(type, p.id) ?? `${type}:${String(p.id ?? "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 32)}`;
      const amount = dollarsToCents(p.cost);
      if (amount === undefined) throw new StannpError("stannp_mailpiece_without_cost");
      const t = parseStannpTime(p.timestamp);
      if (t === undefined) throw new StannpError("stannp_mailpiece_without_timestamp");
      if (t < since) continue;
      out.push({ vendorChargeId: id, amountCents: amount, at: new Date(t).toISOString(), vendorOrderId: id });
    }
    return out;
  }

  /** Local flag only. The real kill is regenerating the API key in Stannp's settings. */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  /** Prepaid balance in cents (GET /v1/accounts/balance, free). For place() and ops. */
  async balance(): Promise<number> {
    const d = await this.data("GET", "/v1/accounts/balance") as { balance?: string | number };
    const c = dollarsToCents(d?.balance);
    if (c === undefined) throw new StannpError("stannp_bad_balance");
    return c;
  }

  private async testCost(req: PurchaseRequest): Promise<number> {
    const { kind } = stannpProduct(req);
    const form = this.form(req, { test: "true" });
    const d = await this.data("POST", `/v1/${kind}s/create`, form) as StannpMailpiece;
    // A real (non-test) piece here would mean money moved on a "quote": fail loudly.
    if (d.status !== "test" || !(d.id === 0 || d.id === "0")) throw new StannpError("stannp_quote_not_test");
    const cost = dollarsToCents(d.cost);
    if (cost === undefined || cost <= 0) throw new StannpError("stannp_quote_without_cost");
    return cost;
  }

  private form(req: PurchaseRequest, extra: Record<string, string>): URLSearchParams {
    const { kind, size, item } = stannpProduct(req);
    const f = new URLSearchParams();
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    if (kind === "postcard") {
      f.set("size", size!);
      f.set("front", item.url!);
      if (item.title) f.set("message", item.title);
    } else {
      f.set("file", item.url!);
    }
    for (const [k, v] of Object.entries(stannpRecipient(req, this.ownerShipTo))) f.set(k, v);
    f.set("post_unverified", "false"); // never mail to an address Stannp couldn't verify
    return f;
  }

  private headers(form: boolean): HeadersInit {
    const h: Record<string, string> = { Authorization: `Basic ${btoa(`${this.apiKey}:`)}`, Accept: "application/json" };
    if (form) h["Content-Type"] = "application/x-www-form-urlencoded";
    return h;
  }

  private async send(method: string, path: string, form?: URLSearchParams): Promise<{ status: number; json: unknown }> {
    if (!this.apiKey) throw new StannpError("stannp_api_key_missing");
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(form !== undefined),
      body: form?.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, json: await res.json().catch(() => undefined) };
  }

  /** A call whose answer must be `{success: true, data}`. Error text is never echoed (it may hold addresses). */
  private async data(method: string, path: string, form?: URLSearchParams): Promise<unknown> {
    const { status, json } = await this.send(method, path, form);
    const b = (json && typeof json === "object" ? json : {}) as { success?: boolean; data?: unknown };
    if (status < 200 || status >= 300 || b.success !== true) {
      throw new StannpError(
        status === 401 ? "stannp_unauthorized" : status === 404 ? "stannp_not_found" : status >= 500 ? "stannp_server_error" : `stannp_http_${status}`,
        status,
      );
    }
    return b.data;
  }
}

/** "2026-10-11 15:00:00" (no zone; read as UTC) or ISO 8601 → epoch ms. */
export function parseStannpTime(s: unknown): number | undefined {
  if (typeof s !== "string" || !s) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** Build from env: STANNP_API_KEY, STANNP_BASE_URL (default the US region), OWNER_SHIP_TO_JSON. */
export function stannpFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): StannpAdapter {
  return new StannpAdapter({
    apiKey: env("STANNP_API_KEY"),
    baseUrl: env("STANNP_BASE_URL"),
    ownerShipTo: env("OWNER_SHIP_TO_JSON"),
  });
}
