// Lob (https://api.lob.com/v1) vendor adapter: printed and mailed postcards, US First Class.
// Docs: https://docs.lob.com (OpenAPI 1.22.0). Prices: https://lob.com/pricing/print-mail and
// https://help.lob.com/print-and-mail/ready-to-get-started/pricing-details.
//
// Money facts this adapter is built on:
// - There is no price-estimate endpoint and the postcard object carries no price, so quote() uses
//   Lob's published per-piece table. Those rates are ALL-IN (print + postage + delivery): there is no
//   separate postage line, so shippingCents = 0.
// - Lob charges no sales tax on print or postage (since 2026-10-01, help.lob.com sales-tax FAQ).
//   Paying Lob by card adds a 3% service fee; by ACH, none. LOB_CARD_FEE_RATE models it (default 0.03).
// - Usage is funded from Lob Credits. Lob has NO per-key spend cap, and when credits run out it does
//   not refuse: it HOLDS postcards and mails the whole backlog the moment credit is topped up. So
//   place() reads the credits balance (GET /accounts/credits_balance, docs "Get Lob Credits Balance")
//   and refuses `lob_insufficient_credit` unless balance ≥ this piece + every unsent piece of ours.
//   If the balance can't be read it refuses `lob_balance_unavailable` unless
//   LOB_ALLOW_UNCHECKED_BALANCE=1. pause() is local; the real kill is disabling the live key in the
//   Lob dashboard (Settings → API Keys).
// - Every postcard gets a send_date LOB_SEND_DELAY_MINUTES (default 60) out, so cancel() has a
//   window (Lob's default cancellation window is 5 minutes). Scheduling is a paid-edition feature:
//   if the account's edition rejects send_date, place() fails cleanly (GuardRefused); set 0 to omit.
// - Test mode is per KEY (`test_…` vs `live_…`), same base URL. Test postcards are free, never
//   print or mail, and never get tracking events.
import { OWNER_HOME } from "../types.ts";
import type { Charge, Item, Order, PurchaseRequest, Quote, Reach, ShipTo, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";
import { parseOwnerAddress, type ZincAddress } from "./zinc.ts";

export const LOB_DEFAULT_BASE_URL = "https://api.lob.com/v1";
/** Developer plan, 4x6 First Class, $0.905 as of 2026-07-12 ($0.909 from 2026-11-01), rounded up. */
export const LOB_POSTCARD_4X6_CENTS = 91;
/** Developer plan, 6x9 First Class, $1.026 as of 2026-07-12 ($1.030 from 2026-11-01), rounded up. */
export const LOB_POSTCARD_6X9_CENTS = 103;
/** Lob's card service fee. Set LOB_CARD_FEE_RATE=0 when the account pays by ACH. */
export const LOB_DEFAULT_CARD_FEE_RATE = 0.03;
/** Minutes between place() and Lob's send_date: the window in which cancel() still works. */
export const LOB_DEFAULT_SEND_DELAY_MINUTES = 60;
/** How far back place() looks for our own unsent postcards when checking credit. */
const PENDING_LOOKBACK_MS = 14 * 24 * 3600_000;
/** Message length the back layout fits, per size. */
export const LOB_MESSAGE_MAX_CHARS: Record<PostcardSize, number> = { "4x6": 350, "6x9": 600 };
const TIMEOUT_MS = 30_000;
const IDEMPOTENCY_METADATA_KEY = "ejb_idempotency_key";
const CENTS_METADATA_KEY = "ejb_cents";

export type PostcardSize = "4x6" | "6x9";

/** Lob's `remote_file_url` pattern (docs): https, ≤256 path chars, ends in .pdf/.png/.jpg. Front is image or PDF only. */
const FRONT_URL_RE = /^https:\/\/[-a-zA-Z0-9@:%._+~#=/]{1,256}\.(pdf|png|jpg)$/;

export interface LobAddress {
  name: string;
  address_line1: string;
  address_line2?: string | null;
  address_city: string;
  address_state: string;
  address_zip: string;
  address_country: "US";
}

export interface LobAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** The owner's address in Zinc's shape (OWNER_SHIP_TO_JSON, raw JSON or base64). */
  ownerShipTo?: string | ZincAddress;
  postcard4x6Cents?: number;
  postcard6x9Cents?: number;
  cardFeeRate?: number;
  /** send_date offset in minutes; 0 omits send_date. Default 60. */
  sendDelayMinutes?: number;
  /** Place even when the credits balance can't be read (LOB_ALLOW_UNCHECKED_BALANCE=1). */
  allowUncheckedBalance?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** A Lob failure where a postcard MAY have been created (or we can't tell): the gate records outcome_unknown. */
export class LobError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "LobError";
  }
}

/** Lob errors are `{error:{code,message,status_code}}`. Falls back on the HTTP status. */
export function readLobError(status: number, body: unknown): string {
  const e = (body && typeof body === "object") ? (body as { error?: unknown }).error : undefined;
  const code = (e && typeof e === "object") ? (e as { code?: unknown }).code : undefined;
  if (typeof code === "string" && code) return code;
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limit_exceeded";
  return status >= 500 ? "lob_server_error" : `lob_http_${status}`;
}

/**
 * POST /postcards rejections where Lob validated and refused the request, so no postcard exists and
 * nothing is billed. These become GuardRefused (request `failed`). 5xx, 408, network errors and
 * unknown codes stay LobError (outcome_unknown): a retry with the same Idempotency-Key is safe.
 */
const DEFINITE_REJECTIONS = new Set([
  "bad_request",
  "invalid",
  "feature_limit_reached",
  "address_length_exceeds_limit",
  "billing_address_required",
  "failed_deliverability_strictness",
  "file_size_exceeds_limit",
  "foreign_return_address",
  "invalid_file",
  "invalid_file_dimensions",
  "invalid_file_download_time",
  "invalid_file_url",
  "invalid_image_dpi",
  "invalid_international_feature",
  "invalid_template_html",
  "mail_use_type_can_not_be_null",
  "merge_variable_required",
  "merge_variable_whitespace",
  "payment_method_unverified",
  "pdf_encrypted",
  "special_characters_restricted",
  "unembedded_fonts",
  "invalid_api_key",
  "publishable_key_not_allowed",
  "unauthorized",
  "unauthorized_token",
  "rate_limit_exceeded",
]);

/** `postcard`, `postcard:4x6` → 4x6; `postcard:6x9` → 6x9; anything else is not a Lob postcard. */
export function postcardSize(sku: string): PostcardSize | undefined {
  if (sku === "postcard" || sku === "postcard:4x6") return "4x6";
  if (sku === "postcard:6x9") return "6x9";
  return undefined;
}

/** HTML-escape, plus `{` `}` so Lob never reads the text as `{{merge_variables}}`. */
export function escapeLobText(s: string): string {
  return s.replace(/[&<>"'{}]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\r?\n/g, "<br>");
}

/**
 * The back of the card: the message in a left column that stays clear of Lob's address and postage
 * block (bottom-right on Lob's 4x6 / 6x9 back templates). Inline styles only, no external assets,
 * no merge variables. Artwork is the full bleed size (+0.25in), per Lob's image guidelines.
 */
export function postcardBackHtml(message: string, size: PostcardSize): string {
  const [w, h, col, pt] = size === "4x6" ? ["6.25in", "4.25in", "2.6in", 11] : ["9.25in", "6.25in", "4.1in", 13];
  return `<html><head><meta charset="UTF-8"><style>` +
    `*{margin:0;padding:0}body{width:${w};height:${h}}` +
    `.msg{position:absolute;left:0.4in;top:0.4in;width:${col};max-height:calc(${h} - 0.8in);overflow:hidden;` +
    `font-family:Georgia,serif;font-size:${pt}pt;line-height:1.35;color:#111;word-wrap:break-word}` +
    `</style></head><body><div class="msg">${escapeLobText(message)}</div></body></html>`;
}

function clean(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

/** Validate a US address against Lob's documented limits. Never echoes values (they are private). */
function lobAddress(a: { name: string; line1: string; line2?: string | null; city: string; state: string; zip: string }): LobAddress {
  const name = clean(a.name), line1 = clean(a.line1), line2 = clean(a.line2), city = clean(a.city);
  const state = clean(a.state).toUpperCase(), zip = clean(a.zip);
  if (!name || !line1 || !city) throw new GuardRefused("lob_address_incomplete");
  if (name.length > 40) throw new GuardRefused("lob_address_name_too_long");
  if (line1.length + line2.length > 50) throw new GuardRefused("address_length_exceeds_limit");
  if (city.length > 200) throw new GuardRefused("lob_address_invalid");
  if (!/^[A-Z]{2}$/.test(state)) throw new GuardRefused("lob_address_bad_state");
  if (!/^\d{5}(-\d{4})?$/.test(zip)) throw new GuardRefused("lob_address_bad_zip");
  return {
    name,
    address_line1: line1,
    address_line2: line2 || null,
    address_city: city,
    address_state: state,
    address_zip: zip,
    address_country: "US",
  };
}

/** Lob metadata values: strings ≤500 chars without `"` or `\`. */
function metaValue(s: string): string {
  return s.replace(/["\\]/g, "").slice(0, 500);
}

interface LobTrackingEvent {
  name?: string;
  time?: string;
}

interface LobPostcard {
  id: string;
  size?: string;
  status?: string;
  deleted?: boolean;
  date_created?: string;
  send_date?: string;
  expected_delivery_date?: string;
  tracking_events?: LobTrackingEvent[] | null;
  metadata?: Record<string, unknown>;
}

const MOVING_EVENTS = new Set(["Mailed", "In Transit", "In Local Area", "Processed for Delivery", "Re-Routed", "International Exit"]);

/**
 * deleted → cancelled (not billed); render `failed` → failed; any `Delivered` event → delivered; a
 * moving event → shipped; none → open. `Returned to Sender` maps to shipped, NOT cancelled: the
 * piece was printed and mailed, so it is billed and must keep counting against the windows.
 * Lob's `status` field is the PDF render status (processed / rendered / failed), not mail status.
 */
export function mapLobStatus(p: Pick<LobPostcard, "deleted" | "status" | "tracking_events">): "open" | "shipped" | "delivered" | "cancelled" | "failed" {
  if (p.deleted === true) return "cancelled";
  if (p.status === "failed") return "failed";
  const names = (p.tracking_events ?? []).map((e) => e.name ?? "");
  if (names.includes("Delivered")) return "delivered";
  if (names.includes("Returned to Sender") || names.some((n) => MOVING_EVENTS.has(n))) return "shipped";
  return "open";
}

export class LobAdapter implements VendorAdapter {
  readonly id = "lob";
  /** A postcard can be mailed to anyone, so the honest worst case is "others". */
  readonly maxReach: Reach = "others";
  paused = false;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly ownerShipTo?: string | ZincAddress;
  readonly priceCents: Record<PostcardSize, number>;
  readonly cardFeeRate: number;
  readonly sendDelayMinutes: number;
  readonly allowUncheckedBalance: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(opts: LobAdapterOptions = {}) {
    this.apiKey = opts.apiKey ?? "";
    if (this.apiKey && (!/^(test|live)_/.test(this.apiKey) || /^(test|live)_pub_/.test(this.apiKey))) {
      throw new Error("LOB_API_KEY must be a secret test_ or live_ key (not a publishable _pub_ key)");
    }
    const base = (opts.baseUrl || LOB_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const u = new URL(base);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
      throw new Error("LOB_BASE_URL must be https (http only on loopback)");
    }
    this.baseUrl = base;
    this.ownerShipTo = opts.ownerShipTo;
    this.priceCents = {
      "4x6": opts.postcard4x6Cents ?? LOB_POSTCARD_4X6_CENTS,
      "6x9": opts.postcard6x9Cents ?? LOB_POSTCARD_6X9_CENTS,
    };
    for (const c of Object.values(this.priceCents)) {
      if (!Number.isSafeInteger(c) || c <= 0 || c > 10_000) throw new Error("lob postcard price must be 1..10000 cents");
    }
    this.cardFeeRate = opts.cardFeeRate ?? LOB_DEFAULT_CARD_FEE_RATE;
    if (!(Number.isFinite(this.cardFeeRate) && this.cardFeeRate >= 0 && this.cardFeeRate < 1)) {
      throw new Error("lob cardFeeRate must be in [0, 1)");
    }
    this.sendDelayMinutes = opts.sendDelayMinutes ?? LOB_DEFAULT_SEND_DELAY_MINUTES;
    // Lob allows send_date up to 180 days out.
    if (!Number.isSafeInteger(this.sendDelayMinutes) || this.sendDelayMinutes < 0 || this.sendDelayMinutes > 180 * 24 * 60) {
      throw new Error("LOB_SEND_DELAY_MINUTES must be an integer 0..259200");
    }
    this.allowUncheckedBalance = opts.allowUncheckedBalance === true;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
  }

  /** True for a `test_` key: free postcards that never print or mail. */
  get isTest(): boolean {
    return this.apiKey.startsWith("test_");
  }

  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "self" : "others";
  }

  /** Per-piece table price + card fee. Same math in quote() and listCharges(). */
  costOf(size: PostcardSize): { subtotalCents: number; feeCents: number; totalCents: number } {
    const subtotalCents = this.priceCents[size];
    const feeCents = Math.ceil(subtotalCents * this.cardFeeRate);
    return { subtotalCents, feeCents, totalCents: subtotalCents + feeCents };
  }

  /**
   * No network: Lob has no estimate endpoint. Validates the request shape (one postcard, a front
   * URL Lob accepts, a message that fits) so a bad request fails before anyone is asked to approve.
   */
  quote(req: PurchaseRequest): Promise<Quote> {
    try {
      const { size } = this.card(req);
      const c = this.costOf(size);
      return Promise.resolve({
        subtotalCents: c.subtotalCents,
        taxCents: 0,
        shippingCents: 0,
        feeCents: c.feeCents,
        totalCents: c.totalCents,
        currency: "USD",
        vendorRef: `lob:postcard:${size}`,
        quotedAt: new Date().toISOString(),
        raw: { size, pieceCents: c.subtotalCents, cardFeeRate: this.cardFeeRate, source: "lob published per-piece table" },
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * POST /postcards with an Idempotency-Key header (Lob returns the existing postcard on a repeat
   * within 24h). chargedCents = the table cost, which is also stored in metadata.ejb_cents so
   * listCharges() reports the same amount. Refuses if that cost is over the hard cap.
   */
  async place(req: PurchaseRequest, q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.apiKey) throw new GuardRefused("lob_api_key_missing");
    const { size, front, message } = this.card(req);
    const chargedCents = Math.max(this.costOf(size).totalCents, q.totalCents);
    if (!Number.isSafeInteger(hardCapCents) || chargedCents > hardCapCents) throw new GuardRefused("max_price_exceeded");
    if (!idempotencyKey || idempotencyKey.length > 256) throw new GuardRefused("lob_bad_idempotency_key");

    const owner = () => {
      const o = parseOwnerAddress(this.ownerShipTo);
      return lobAddress({
        name: `${o.first_name} ${o.last_name}`,
        line1: o.address_line1,
        line2: o.address_line2,
        city: o.city,
        state: o.state ?? "",
        zip: o.postal_code,
      });
    };
    let to: LobAddress;
    let from: LobAddress | undefined;
    if (req.shipTo === undefined || req.shipTo === OWNER_HOME) {
      if (parseOwnerAddress(this.ownerShipTo).country !== "US") throw new GuardRefused("lob_owner_address_not_us");
      to = owner();
      from = to;
    } else {
      to = lobAddress(req.shipTo as Exclude<ShipTo, typeof OWNER_HOME>);
      // Return address = the owner's, when configured. Lob allows none for domestic mail.
      try {
        from = owner();
      } catch {
        from = undefined;
      }
    }
    await this.checkCredit(chargedCents);
    const sendDate = this.sendDelayMinutes > 0
      ? new Date(this.now().getTime() + this.sendDelayMinutes * 60_000).toISOString()
      : undefined;
    const body = {
      description: metaValue(`ejb ${req.taskId}`).slice(0, 255),
      ...(sendDate ? { send_date: sendDate } : {}),
      to,
      ...(from ? { from } : {}),
      front,
      back: postcardBackHtml(message, size),
      size,
      mail_type: "usps_first_class",
      // Required by Lob (null only with an account default). Personal correspondence, not marketing.
      use_type: "operational",
      metadata: {
        [IDEMPOTENCY_METADATA_KEY]: metaValue(idempotencyKey),
        [CENTS_METADATA_KEY]: String(chargedCents),
        task_id: metaValue(req.taskId),
      },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/postcards`, {
        method: "POST",
        headers: { ...this.headers(true), "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new LobError("lob_network_error"); // may or may not have reached Lob
    }
    const json = await res.json().catch(() => undefined) as LobPostcard | undefined;
    if (res.ok) {
      if (!json || typeof json.id !== "string" || !/^psc_[A-Za-z0-9]+$/.test(json.id)) throw new LobError("lob_malformed_postcard");
      return { vendorOrderId: json.id, chargedCents, raw: { size, status: json.status, send_date: json.send_date, test: this.isTest } };
    }
    const code = readLobError(res.status, json);
    if (res.status < 500 && res.status !== 408 && DEFINITE_REJECTIONS.has(code)) throw new GuardRefused(code);
    throw new LobError(code, res.status);
  }

  /** GET /postcards/{id}. See mapLobStatus. Postcards have no carrier tracking number; raw has the last event. */
  async status(vendorOrderId: string): ReturnType<VendorAdapter["status"]> {
    const p = await this.call("GET", `/postcards/${encodeURIComponent(vendorOrderId)}`) as LobPostcard;
    const events = p.tracking_events ?? [];
    const last = events.length ? events[events.length - 1].name : undefined;
    const raw = {
      render: p.status,
      last_event: last,
      returned: events.some((e) => e.name === "Returned to Sender"),
      expected_delivery_date: p.expected_delivery_date,
    };
    return { state: mapLobStatus(p), tracking: undefined, raw };
  }

  /**
   * DELETE /postcards/{id}. Works only inside the cancellation window (5 minutes by default on new
   * accounts) or before a send_date; then the postcard is not billed. Otherwise `not_deletable` → false.
   */
  async cancel(vendorOrderId: string): Promise<boolean> {
    if (!this.apiKey) throw new LobError("lob_api_key_missing");
    const res = await this.fetchImpl(`${this.baseUrl}/postcards/${encodeURIComponent(vendorOrderId)}`, {
      method: "DELETE",
      headers: this.headers(false),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => undefined) as { deleted?: boolean } | undefined;
    if (res.ok) return json?.deleted === true;
    const code = readLobError(res.status, json);
    if (code === "not_deletable" || code === "conflict" || code === "not_found" || res.status === 404) return false;
    throw new LobError(code, res.status);
  }

  /**
   * GET /postcards?date_created[gte]=since, following next_url. One charge per postcard that wasn't
   * cancelled. Amount = metadata.ejb_cents (what place() recorded), else the table cost for its
   * size, so a postcard made by hand in the dashboard still shows up (as a phantom charge).
   */
  async listCharges(sinceISO: string): Promise<Charge[]> {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) throw new LobError("lob_bad_since");
    const out: Charge[] = [];
    for (const p of await this.listPostcards(new Date(since))) {
      if (p.deleted === true) continue;
      const t = Date.parse(p.date_created ?? "");
      const meta = Number(p.metadata?.[CENTS_METADATA_KEY]);
      const amountCents = Number.isSafeInteger(meta) && meta > 0
        ? meta
        : this.costOf(p.size === "4x6" ? "4x6" : "6x9").totalCents; // a phantom trips STOP whatever its amount
      out.push({ vendorChargeId: p.id, amountCents, at: new Date(t).toISOString(), vendorOrderId: p.id });
    }
    return out;
  }

  /** GET /postcards?date_created[gte]=since, every page (via next_url's `after` cursor). */
  private async listPostcards(since: Date): Promise<LobPostcard[]> {
    const out: LobPostcard[] = [];
    let after: string | undefined;
    for (let page = 0; page < 500; page++) {
      const qs = new URLSearchParams({ limit: "100", "date_created[gte]": since.toISOString() });
      if (after) qs.set("after", after);
      const body = await this.call("GET", `/postcards?${qs}`) as { data?: LobPostcard[]; next_url?: string | null };
      for (const p of body.data ?? []) {
        const t = Date.parse(p.date_created ?? "");
        if (!Number.isFinite(t)) throw new LobError("lob_postcard_without_date_created");
        if (t >= since.getTime()) out.push(p);
      }
      if (!body.next_url) break;
      const next = new URL(body.next_url, this.baseUrl).searchParams.get("after");
      if (!next || next === after) break;
      after = next;
    }
    return out;
  }

  /**
   * Lob Credits balance in cents (GET /accounts/credits_balance → `{balance}` in dollars; may be
   * negative). The docs' path key is `/accounts` while their sample calls `/accounts/credits_balance`,
   * so a 404 on the sample path falls back to `/accounts`.
   */
  async creditsBalanceCents(): Promise<number> {
    let body: unknown;
    try {
      body = await this.call("GET", "/accounts/credits_balance");
    } catch (e) {
      if (!(e instanceof LobError && e.status === 404)) throw e;
      body = await this.call("GET", "/accounts");
    }
    const b = (body as { balance?: unknown } | undefined)?.balance;
    if (typeof b !== "number" || !Number.isFinite(b)) throw new LobError("lob_malformed_balance");
    return Math.floor(b * 100 + 1e-6);
  }

  /**
   * Our unsent postcards: created by this gate (metadata.ejb_cents) in the last 14 days, not
   * deleted, with no tracking event yet. Conservative on purpose: a piece Lob already mailed but USPS
   * hasn't scanned still counts, which only makes the credit check stricter.
   */
  async pendingCents(): Promise<number> {
    let sum = 0;
    for (const p of await this.listPostcards(new Date(this.now().getTime() - PENDING_LOOKBACK_MS))) {
      if (p.deleted === true || (p.tracking_events ?? []).length > 0) continue;
      const c = Number(p.metadata?.[CENTS_METADATA_KEY]);
      if (Number.isSafeInteger(c) && c > 0) sum += c;
    }
    return sum;
  }

  /**
   * Lob holds postcards when credits run out and mails the backlog on top-up, so "no credit" is not
   * a refusal at Lob. Refuse here instead. Test keys make free postcards: no check.
   */
  private async checkCredit(pieceCents: number): Promise<void> {
    if (this.isTest) return;
    let balance: number, pending: number;
    try {
      balance = await this.creditsBalanceCents();
      pending = await this.pendingCents();
    } catch {
      if (this.allowUncheckedBalance) return;
      throw new GuardRefused("lob_balance_unavailable");
    }
    if (balance < pieceCents + pending) throw new GuardRefused("lob_insufficient_credit");
  }

  /** Local flag only. The real kill is disabling the live key at dashboard.lob.com (Settings → API Keys). */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  /** The one postcard a request describes. Throws GuardRefused on anything Lob would refuse. */
  private card(req: PurchaseRequest): { size: PostcardSize; front: string; message: string } {
    if (req.items.length !== 1) throw new GuardRefused("lob_one_postcard_per_request");
    const it = req.items[0] as Item & { message?: unknown };
    if (it.qty !== 1) throw new GuardRefused("lob_one_postcard_per_request");
    const size = postcardSize(it.sku);
    if (!size) throw new GuardRefused("lob_unknown_sku");
    const front = clean(it.url);
    if (!FRONT_URL_RE.test(front)) throw new GuardRefused("lob_front_url_invalid");
    const message = clean(typeof it.message === "string" ? it.message : it.title);
    if (!message) throw new GuardRefused("lob_message_missing");
    if (message.length > LOB_MESSAGE_MAX_CHARS[size]) throw new GuardRefused("lob_message_too_long");
    return { size, front, message };
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Basic ${btoa(`${this.apiKey}:`)}`, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async call(method: string, path: string): Promise<unknown> {
    if (!this.apiKey) throw new LobError("lob_api_key_missing");
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(false),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new LobError(readLobError(res.status, json), res.status);
    return json;
  }
}

/**
 * Build from env: LOB_API_KEY, LOB_BASE_URL, LOB_POSTCARD_CENTS, LOB_POSTCARD_6X9_CENTS,
 * LOB_CARD_FEE_RATE, LOB_SEND_DELAY_MINUTES, LOB_ALLOW_UNCHECKED_BALANCE, OWNER_SHIP_TO_JSON.
 */
export function lobFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): LobAdapter {
  const num = (k: string) => {
    const v = env(k);
    return v ? Number(v) : undefined;
  };
  return new LobAdapter({
    apiKey: env("LOB_API_KEY"),
    baseUrl: env("LOB_BASE_URL"),
    ownerShipTo: env("OWNER_SHIP_TO_JSON"),
    postcard4x6Cents: num("LOB_POSTCARD_CENTS"),
    postcard6x9Cents: num("LOB_POSTCARD_6X9_CENTS"),
    cardFeeRate: num("LOB_CARD_FEE_RATE"),
    sendDelayMinutes: num("LOB_SEND_DELAY_MINUTES"),
    allowUncheckedBalance: env("LOB_ALLOW_UNCHECKED_BALANCE") === "1",
  });
}
