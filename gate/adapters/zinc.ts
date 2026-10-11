// Zinc 2.0 (https://api.zinc.com) vendor adapter: retail orders (Amazon, Walmart, Target...) paid
// from a prepaid Zinc wallet. Docs: https://www.zinc.com/docs/llms-full.txt and
// https://api.zinc.com/openapi.json.
//
// Money facts this adapter is built on (Zinc wallet docs, https://www.zinc.com/docs/v2/wallet):
// - Every order carries `max_price` (CENTS) = the ceiling for item + tax + shipping.
// - The wallet must hold `max_price + order fee` ($1) at order time; Zinc holds that up front and
//   refunds the difference once the order completes. Failed / cancelled orders are refunded in full.
// - POST /orders only queues the order (status "pending"). The real total, and failures such as
//   `max_price_exceeded`, arrive later on GET /orders/{id} as `job_result`.
//
// Test mode is per KEY, not per host: a `zn_test_` key hits the sandbox at the same base URL.
// There is no per-key spend limit at Zinc. The vendor-side caps are the wallet balance (keep it
// small, auto top-up OFF) and `max_price`. pause() is local; the real kill is revoking the key
// in the Zinc dashboard (app.zinc.com → Settings → API keys).
import { OWNER_HOME } from "../types.ts";
import type { Charge, Item, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";

export const ZINC_DEFAULT_BASE_URL = "https://api.zinc.com";
export const ZINC_DEFAULT_RETAILER = "amazon";
/** Zinc's per-order API fee. `GET /wallet/me` → `order_fee_cents` is authoritative. */
export const ZINC_ORDER_FEE_CENTS = 100;
/** Offers carry no tax, so the quote adds this buffer on the subtotal (≈ the highest US combined rates). */
export const ZINC_DEFAULT_TAX_RATE = 0.1;
/** Headroom over the quote that max_price allows for price drift: max 10%. */
export const ZINC_MAX_PRICE_HEADROOM = 1.1;
const IDEMPOTENCY_METADATA_KEY = "ejb_idempotency_key";
const TIMEOUT_MS = 20_000;

/** Zinc's shipping address object (OpenAPI `Address`). */
export interface ZincAddress {
  first_name: string;
  last_name: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state?: string | null;
  postal_code: string;
  phone_number: string;
  country: string;
}

export interface ZincAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  retailer?: string;
  /** The owner's address, Zinc shape. Raw JSON string (OWNER_SHIP_TO_JSON) or an object. */
  ownerShipTo?: string | ZincAddress;
  taxRate?: number;
  feeCents?: number;
  fetchImpl?: typeof fetch;
}

/** A Zinc failure where money MAY have moved (or we can't tell): the gate records outcome_unknown. */
export class ZincError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "ZincError";
  }
}

/**
 * The wallet ceiling for one order: the hold (`max_price + fee`) never exceeds the gate's hard cap
 * nor the quote (which already includes the fee) plus 10%. Pure, gate-side; the agent has no input.
 * Returns the `max_price` to send (item + tax + shipping ceiling, in cents).
 */
export function zincMaxPrice(hardCapCents: number, quoteTotalCents: number, feeCents = ZINC_ORDER_FEE_CENTS): number {
  const ceiling = Math.min(hardCapCents, Math.floor(quoteTotalCents * ZINC_MAX_PRICE_HEADROOM));
  return ceiling - feeCents;
}

/** Parse any of Zinc's three error shapes: `{error:{code}}`, flat `{code}`, metered-402 `{detail}`. */
export function readZincError(status: number, body: unknown): { code: string; message?: string } {
  const b = (body && typeof body === "object") ? body as Record<string, unknown> : {};
  const nested = (b.error && typeof b.error === "object") ? b.error as Record<string, unknown> : undefined;
  const code = typeof nested?.code === "string" ? nested.code : typeof b.code === "string" ? b.code : undefined;
  const message = typeof nested?.message === "string"
    ? nested.message
    : typeof b.message === "string"
    ? b.message
    : typeof b.detail === "string"
    ? b.detail
    : undefined;
  if (code) return { code, message };
  if (status === 402) return { code: "insufficient_funds", message };
  if (status === 401) return { code: "unauthorized", message };
  if (status === 429) return { code: "rate_limit_exceeded", message };
  return { code: status >= 500 ? "zinc_server_error" : `zinc_http_${status}`, message };
}

/**
 * POST /orders rejections where Zinc documents that no order was created and nothing was charged
 * ("rejected, never partially placed"). These become GuardRefused, so the gate marks the request
 * failed instead of outcome_unknown. Anything else (5xx, network, unknown codes) stays a ZincError.
 */
const DEFINITE_REJECTIONS = new Set([
  "insufficient_funds",
  "invalid_shipping_address",
  "url_unreachable",
  "validation_error",
  "bad_request",
  "invalid_variant",
  "out_of_stock",
  "shipping_unavailable",
  "unsupported_retailer",
  "unsupported_country",
  "retailer_country_not_supported",
  "guest_checkout_not_supported",
  "unauthorized",
  "forbidden",
  "invalid_token",
  "token_expired",
  "payment_required",
  "payment_method_required",
]);

/** Validate the owner's address in Zinc's shape. Never echoes values (they are private). */
export function parseOwnerAddress(raw: string | ZincAddress | undefined): ZincAddress {
  if (raw === undefined || raw === "") throw new GuardRefused("zinc_owner_address_missing");
  let a: unknown = raw;
  if (typeof raw === "string") {
    try {
      // .env values can't hold spaces or quotes (ops/set-key.sh, systemd, docker --env-file), so the
      // address may be given base64-encoded: `printf '%s' '{...}' | base64 | ops/set-key.sh OWNER_SHIP_TO_JSON`.
      const s = raw.trim();
      a = JSON.parse(s.startsWith("{") ? s : new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));
    } catch {
      throw new GuardRefused("zinc_owner_address_invalid_json");
    }
  }
  if (!a || typeof a !== "object") throw new GuardRefused("zinc_owner_address_invalid");
  const o = a as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === "string" ? (o[k] as string).trim() : "";
  for (const k of ["first_name", "last_name", "address_line1", "city", "postal_code", "phone_number"]) {
    if (!str(k)) throw new GuardRefused(`zinc_owner_address_missing_${k}`);
  }
  const country = (str("country") || "US").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new GuardRefused("zinc_owner_address_bad_country");
  if (str("address_line1").length > 60 || str("address_line2").length > 60) {
    throw new GuardRefused("zinc_owner_address_line_too_long");
  }
  if (country === "US") {
    if (!/^\d{5}(-\d{4})?$/.test(str("postal_code"))) throw new GuardRefused("zinc_owner_address_bad_zip");
    if (!/^[A-Z]{2}$/.test(str("state").toUpperCase())) throw new GuardRefused("zinc_owner_address_bad_state");
  }
  return {
    first_name: str("first_name"),
    last_name: str("last_name"),
    address_line1: str("address_line1"),
    address_line2: str("address_line2") || null,
    city: str("city"),
    state: str("state") ? str("state").toUpperCase() : null,
    postal_code: str("postal_code"),
    phone_number: str("phone_number"),
    country,
  };
}

/** Deterministic ≤36-char idempotency key: the gate key itself if it fits, else a sha256-derived UUID shape. */
export async function zincIdempotencyKey(key: string): Promise<string> {
  if (/^[A-Za-z0-9_-]{1,36}$/.test(key)) return key;
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  const hex = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface ZincOffer {
  price?: number;
  condition?: string;
  available?: boolean;
  shipping_options?: { price?: number }[];
}

interface ZincOrder {
  id: string;
  status: string;
  max_price: number;
  created_at: string;
  tracking_numbers?: { tracking_number?: string; status?: string | null }[];
  job_result?: { error_type?: string | null; price_components?: { total?: number | null } | null } | null;
  metadata?: Record<string, unknown>;
}

const REFUNDED_STATUSES = new Set(["order_failed", "cancelled", "cancelled_by_retailer"]);

function cents(n: unknown): number | undefined {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export class ZincAdapter implements VendorAdapter {
  readonly id = "zinc";
  /** A retailer can ship to anyone, so the honest worst case is "others". */
  readonly maxReach: Reach = "others";
  paused = false;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly retailer: string;
  private readonly ownerShipTo?: string | ZincAddress;
  readonly taxRate: number;
  readonly feeCents: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ZincAdapterOptions = {}) {
    this.apiKey = opts.apiKey ?? "";
    const base = (opts.baseUrl || ZINC_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const u = new URL(base);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
      throw new Error("ZINC_BASE_URL must be https (http only on loopback)");
    }
    this.baseUrl = base;
    this.retailer = opts.retailer || ZINC_DEFAULT_RETAILER;
    if (!/^[a-z0-9-]{2,40}$/.test(this.retailer)) throw new Error("ZINC_RETAILER must be a Zinc retailer slug");
    this.ownerShipTo = opts.ownerShipTo;
    this.taxRate = opts.taxRate ?? ZINC_DEFAULT_TAX_RATE;
    if (!(Number.isFinite(this.taxRate) && this.taxRate >= 0 && this.taxRate < 1)) {
      throw new Error("zinc taxRate must be in [0, 1)");
    }
    this.feeCents = opts.feeCents ?? ZINC_ORDER_FEE_CENTS;
    if (!Number.isSafeInteger(this.feeCents) || this.feeCents < 0) throw new Error("zinc feeCents must be >= 0");
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** True when the key is a sandbox (`zn_test_`) key. */
  get isSandbox(): boolean {
    return this.apiKey.startsWith("zn_test_");
  }

  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "self" : "others";
  }

  /**
   * Per item: GET /products/{sku}/offers → cheapest available New offer (within maxUnitCents),
   * price × qty, plus that offer's cheapest shipping option. Tax = round(subtotal × taxRate)
   * (offers carry none). totalCents = subtotal + tax + shipping + feeCents (Zinc's order fee), so
   * the fee is in the total the tiers see and the parts sum to the total (the gate checks this).
   */
  async quote(req: PurchaseRequest): Promise<Quote> {
    if (!req.items.length) throw new ZincError("zinc_no_items");
    if (req.items.length > 10) throw new ZincError("zinc_too_many_items"); // Zinc: ≤ 10 products per order
    let subtotalCents = 0;
    let shippingCents = 0;
    const raw: unknown[] = [];
    for (const it of req.items) {
      if (!Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > 100) throw new ZincError("zinc_bad_qty");
      const path = `/products/${encodeURIComponent(it.sku)}/offers?retailer=${encodeURIComponent(this.retailer)}`;
      const body = await this.call("GET", path) as { status?: string; code?: string; offers?: ZincOffer[] };
      raw.push(body);
      if (body.status !== "completed") throw new ZincError(`zinc_offers_${body.code ?? body.status ?? "unknown"}`);
      const offers = (body.offers ?? []).filter((o) =>
        o.available === true && o.condition === "New" && cents(o.price) !== undefined &&
        (it.maxUnitCents === undefined || (o.price as number) <= it.maxUnitCents)
      );
      if (!offers.length) throw new ZincError("zinc_no_offer");
      const shipOf = (o: ZincOffer) => {
        const s = (o.shipping_options ?? []).map((x) => cents(x.price)).filter((p): p is number => p !== undefined);
        return s.length ? Math.min(...s) : 0;
      };
      const cost = (o: ZincOffer) => (o.price as number) * it.qty + shipOf(o);
      const best = offers.reduce((a, b) => cost(a) <= cost(b) ? a : b); // cheapest delivered, not cheapest sticker
      subtotalCents += (best.price as number) * it.qty;
      shippingCents += shipOf(best);
    }
    const taxCents = Math.round(subtotalCents * this.taxRate);
    return {
      subtotalCents,
      taxCents,
      shippingCents,
      feeCents: this.feeCents,
      totalCents: subtotalCents + taxCents + shippingCents + this.feeCents,
      currency: "USD",
      vendorRef: `zinc:${this.retailer}`,
      quotedAt: new Date().toISOString(),
      raw: { offers: raw, feeCents: this.feeCents, taxRate: this.taxRate },
    };
  }

  /**
   * Sends max_price = zincMaxPrice(hardCap, quote.total) and the (≤36-char) idempotency key.
   * chargedCents = the up-front wallet hold (max_price + fee): the refund of the difference comes
   * later, so the ledger over-counts (the safe direction) and listCharges reports the same hold.
   */
  async place(req: PurchaseRequest, q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.apiKey) throw new GuardRefused("zinc_api_key_missing");
    if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) {
      // The gate's ShipTo has no phone or split name, which Zinc requires. Refuse rather than guess.
      throw new GuardRefused("zinc_third_party_shipto_unsupported");
    }
    const shipping_address = parseOwnerAddress(this.ownerShipTo);
    const maxPrice = zincMaxPrice(hardCapCents, q.totalCents, this.feeCents);
    if (!Number.isSafeInteger(maxPrice) || maxPrice <= 0) throw new GuardRefused("zinc_max_price_nonpositive");
    if (maxPrice + this.feeCents > hardCapCents) throw new GuardRefused("max_price_exceeded"); // belt and braces
    const products = req.items.map((it) => ({ url: this.productUrl(it), quantity: it.qty }));
    const key = await zincIdempotencyKey(idempotencyKey);
    const body = {
      products,
      max_price: maxPrice,
      shipping_address,
      idempotency_key: key,
      po_number: key,
      metadata: { [IDEMPOTENCY_METADATA_KEY]: key, task_id: req.taskId.slice(0, 200) },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/orders`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ZincError("zinc_network_error"); // may or may not have reached Zinc
    }
    const json = await res.json().catch(() => undefined);
    if (res.ok) return this.toOrder(json as ZincOrder);
    const err = readZincError(res.status, json);
    if (err.code === "already_exists") {
      // Docs: a duplicate idempotency key means the first attempt got through. Find it.
      const found = await this.findByIdempotencyKey(key);
      if (found) return this.toOrder(found);
      throw new ZincError("zinc_duplicate_order_not_found", res.status);
    }
    if (res.status < 500 && DEFINITE_REJECTIONS.has(err.code)) throw new GuardRefused(err.code);
    throw new ZincError(err.code, res.status);
  }

  /**
   * pending / in_progress / order_placed → open; a package moving → shipped; every package
   * delivered → delivered; order_failed (e.g. max_price_exceeded), cancelled,
   * cancelled_by_retailer → cancelled (the wallet is refunded). `raw.error_type` says why.
   */
  async status(vendorOrderId: string) {
    const o = await this.call("GET", `/orders/${encodeURIComponent(vendorOrderId)}`) as ZincOrder;
    const tracking = (o.tracking_numbers ?? []).find((t) => t.tracking_number)?.tracking_number;
    const errorType = o.job_result?.error_type ?? undefined;
    const raw = { status: o.status, error_type: errorType, total: o.job_result?.price_components?.total ?? undefined };
    return { state: mapZincStatus(o), tracking, raw };
  }

  /** Zinc can cancel only while the order is still queued (`pending`). `order_not_cancellable` → false. */
  async cancel(vendorOrderId: string): Promise<boolean> {
    if (!this.apiKey) throw new ZincError("zinc_api_key_missing");
    const res = await this.fetchImpl(`${this.baseUrl}/orders/${encodeURIComponent(vendorOrderId)}/cancel`, {
      method: "POST",
      headers: this.headers(false),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      await res.body?.cancel();
      return true;
    }
    const err = readZincError(res.status, await res.json().catch(() => undefined));
    if (err.code === "order_not_cancellable" || res.status === 404 || res.status === 409) return false;
    throw new ZincError(err.code, res.status);
  }

  /**
   * Zinc has no wallet-transactions endpoint, so charges come from GET /orders (created_after).
   * One charge per order that was not refunded: amount = the up-front hold (max_price + fee),
   * matching what place() recorded. Failed and cancelled orders are refunded in full and skipped.
   */
  async listCharges(sinceISO: string): Promise<Charge[]> {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) throw new ZincError("zinc_bad_since");
    const out: Charge[] = [];
    const limit = 500;
    for (let offset = 0; offset < 50_000; offset += limit) {
      const qs = new URLSearchParams({ created_after: sinceISO, limit: String(limit), offset: String(offset) });
      const page = await this.call("GET", `/orders?${qs}`) as { orders?: ZincOrder[]; total?: number };
      const orders = page.orders ?? [];
      for (const o of orders) {
        if (REFUNDED_STATUSES.has(o.status)) continue;
        const max = cents(o.max_price);
        if (max === undefined) throw new ZincError("zinc_order_without_max_price");
        const t = Date.parse(o.created_at);
        if (!Number.isFinite(t)) throw new ZincError("zinc_order_without_created_at");
        if (t < since) continue;
        out.push({ vendorChargeId: o.id, amountCents: max + this.feeCents, at: new Date(t).toISOString(), vendorOrderId: o.id });
      }
      if (orders.length < limit || offset + orders.length >= (page.total ?? 0)) break;
    }
    return out;
  }

  /** Local flag only. The real kill is revoking the key at app.zinc.com (Settings → API keys). */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  /** Spendable wallet cents and the live order fee (GET /wallet/me, free). For ops and reconcile. */
  async wallet(): Promise<{ spendableCents: number; feeCents: number }> {
    const w = await this.call("GET", "/wallet/me") as { spendable_balance?: number; balance?: number; order_fee_cents?: number };
    return {
      spendableCents: cents(w.spendable_balance) ?? cents(w.balance) ?? 0,
      feeCents: cents(w.order_fee_cents) ?? this.feeCents,
    };
  }

  /** The URL Zinc orders. It must name the same sku that was quoted, so an agent can't swap items. */
  private productUrl(it: Item): string {
    if (this.retailer === "amazon" && /^[A-Z0-9]{10}$/.test(it.sku)) {
      if (it.url && !it.url.includes(it.sku)) throw new GuardRefused("zinc_url_sku_mismatch");
      return `https://www.amazon.com/dp/${it.sku}`;
    }
    if (!it.url) throw new GuardRefused("zinc_item_url_missing");
    let u: URL;
    try {
      u = new URL(it.url);
    } catch {
      throw new GuardRefused("zinc_item_url_invalid");
    }
    if (u.protocol !== "https:") throw new GuardRefused("zinc_item_url_invalid");
    if (!it.url.includes(it.sku)) throw new GuardRefused("zinc_url_sku_mismatch");
    return it.url;
  }

  private async findByIdempotencyKey(key: string): Promise<ZincOrder | undefined> {
    const qs = new URLSearchParams({ metadata_key: IDEMPOTENCY_METADATA_KEY, metadata_value: key, limit: "2" });
    const page = await this.call("GET", `/orders?${qs}`) as { orders?: ZincOrder[] };
    const hits = (page.orders ?? []).filter((o) => o.metadata?.[IDEMPOTENCY_METADATA_KEY] === key);
    return hits.length === 1 ? hits[0] : undefined;
  }

  private toOrder(o: ZincOrder): Order {
    const max = cents(o?.max_price);
    if (!o || typeof o.id !== "string" || !o.id || max === undefined) throw new ZincError("zinc_malformed_order");
    return { vendorOrderId: o.id, chargedCents: max + this.feeCents, raw: { status: o.status } };
  }

  private headers(json: boolean): HeadersInit {
    const h: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async call(method: string, path: string): Promise<unknown> {
    if (!this.apiKey) throw new ZincError("zinc_api_key_missing");
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(false),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new ZincError(readZincError(res.status, json).code, res.status);
    return json;
  }
}

export function mapZincStatus(o: Pick<ZincOrder, "status" | "tracking_numbers">): "open" | "shipped" | "delivered" | "cancelled" {
  if (REFUNDED_STATUSES.has(o.status)) return "cancelled";
  if (o.status !== "order_placed") return "open";
  const t = (o.tracking_numbers ?? []).map((x) => x.status ?? "pending");
  if (t.length && t.every((s) => s === "delivered")) return "delivered";
  if (t.some((s) => s === "in_transit" || s === "available_for_pickup" || s === "delivered")) return "shipped";
  return "open";
}

/** Build from env: ZINC_API_KEY, ZINC_BASE_URL, ZINC_RETAILER, ZINC_TAX_RATE, OWNER_SHIP_TO_JSON. */
export function zincFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): ZincAdapter {
  const tax = env("ZINC_TAX_RATE");
  return new ZincAdapter({
    apiKey: env("ZINC_API_KEY"),
    baseUrl: env("ZINC_BASE_URL"),
    retailer: env("ZINC_RETAILER"),
    ownerShipTo: env("OWNER_SHIP_TO_JSON"),
    taxRate: tax ? Number(tax) : undefined,
  });
}
