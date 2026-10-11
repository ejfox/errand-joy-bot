// Prodigi Print API v4 (https://www.prodigi.com/print-api/docs/reference/) vendor adapter:
// fine-art giclée prints, posters, puzzles, canvases. Paid per order from the card on file in the
// Prodigi dashboard (a Privacy.com merchant-locked card with a monthly cap; see docs/vendors.md).
//
// API facts this adapter is built on (reference fetched 2026-10-11):
// - Two environments with separate keys: sandbox `https://api.sandbox.prodigi.com` (never
//   fulfilled, never charged) and live `https://api.prodigi.com`. Auth header `X-API-Key`.
//   This adapter defaults to the SANDBOX; live only when PRODIGI_ENV=production.
// - `POST /v4.0/quotes` prices items + shipping (+ tax) per shipping method without creating an
//   order. Quotes don't need the image; orders do (`assets[].url`).
// - `POST /v4.0/orders` creates the order. Every success is HTTP 200 with an `outcome`: `created`,
//   `onHold` (pause window; only the id comes back), `createdWithIssues`, `alreadyExists` (the
//   `idempotencyKey` was seen before: nothing new is created and the original order is returned).
// - An order whose card payment needs action carries `status.issues[]` with
//   `errorCode: "RequiresPaymentAuthorisation"` and `authorisationDetails {authorisationUrl,
//   paymentDetails}`. The order EXISTS. This adapter treats it as PLACED BUT BLOCKED: returns the
//   order (never re-posts it), logs one line, and status() keeps reporting `open` + `raw.blocked`.
//   A Privacy card declining against its cap is expected to surface exactly this way.
// - No per-key spend limit at Prodigi: the vendor-side cap is the Privacy card's monthly limit.
//   pause() is local; the real kill is pausing the Privacy card (or revoking the key).
import { OWNER_HOME } from "../types.ts";
import type { Charge, Item, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";
import { parseOwnerAddress, type ZincAddress } from "./zinc.ts";
import { hashedRef, microsToCents, moneyToMicros } from "./money.ts";

export const PRODIGI_SANDBOX_BASE_URL = "https://api.sandbox.prodigi.com";
export const PRODIGI_LIVE_BASE_URL = "https://api.prodigi.com";
export const PRODIGI_SHIPPING_METHODS = ["Budget", "Standard", "StandardPlus", "Express", "Overnight"] as const;
export type ProdigiShippingMethod = typeof PRODIGI_SHIPPING_METHODS[number];
export const PRODIGI_DEFAULT_SHIPPING: ProdigiShippingMethod = "Budget";
export const PRODIGI_SIZINGS = ["fillPrintArea", "fitPrintArea", "stretchToPrintArea"] as const;
/**
 * US sales-tax buffer. Prodigi flags US quotes with `UsSalesTaxWarning` ("prices may be subject to
 * US sales tax") and may quote tax as 0; then the quote adds this rate on items + shipping.
 */
export const PRODIGI_DEFAULT_TAX_RATE = 0.1;
export const PAYMENT_AUTH_CODE = "RequiresPaymentAuthorisation";
const TIMEOUT_MS = 30_000;
const MAX_ITEMS = 10;

/**
 * Per-item print options, from the gate Item's `sizing` and `attributes` (intake bounds them; this
 * adapter narrows `sizing` to Prodigi's enum and re-checks attributes). Defaults: sizing
 * fillPrintArea, no attributes. `url` is the image asset.
 */
export interface ProdigiItem extends Item {
  sizing?: typeof PRODIGI_SIZINGS[number];
  attributes?: Record<string, string>;
}

export interface ProdigiAdapterOptions {
  apiKey?: string;
  /** "sandbox" (default) or "production". Anything else is a config error. */
  env?: string;
  /** Tests only: overrides the env-derived base URL (https, or http on loopback). */
  baseUrl?: string;
  shippingMethod?: string;
  taxRate?: number;
  /** The owner's address, Zinc shape (OWNER_SHIP_TO_JSON, raw JSON or base64). */
  ownerShipTo?: string | ZincAddress;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** A Prodigi failure where an order MAY exist (or we can't tell): the gate records outcome_unknown. */
export class ProdigiError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "ProdigiError";
  }
}

interface Cost {
  amount?: string;
  currency?: string;
}
interface ProdigiIssue {
  objectId?: string;
  errorCode?: string;
  description?: string;
  authorisationDetails?: { authorisationUrl?: string; paymentDetails?: Cost } | null;
}
interface ProdigiOrder {
  id?: string;
  created?: string;
  status?: { stage?: string; issues?: ProdigiIssue[] } | null;
  charges?: { id?: string; chargeType?: string; totalCost?: Cost }[];
  shipments?: { status?: string; tracking?: { number?: string; url?: string } | null }[];
}
interface ProdigiQuote {
  shipmentMethod?: string;
  costSummary?: { items?: Cost; shipping?: Cost; branding?: Cost; totalTax?: Cost; totalCost?: Cost };
  items?: { sku?: string; copies?: number; unitCost?: Cost }[];
}

/** Outcomes where Prodigi documents (or HTTP semantics guarantee) that no order was created. */
const DEFINITE_REJECTIONS = new Set([
  "validationfailed",
  "entitynotfound",
  "endpointdoesnotexist",
  "methodnotallowed",
  "invalidcontenttype",
  "unauthorized",
  "unauthorised",
]);
const ORDER_OK = new Set(["created", "onhold", "createdwithissues", "alreadyexists"]);

/** Strict USD amount → cents (Prodigi amounts are decimal strings). */
function usdCents(c: Cost | undefined, what: string, required = true): number | undefined {
  if (!c || c.amount === undefined || c.amount === null) {
    if (required) throw new ProdigiError(`prodigi_quote_missing_${what}`);
    return undefined;
  }
  if ((c.currency ?? "").toUpperCase() !== "USD") throw new ProdigiError("prodigi_currency_not_usd");
  const m = moneyToMicros(c.amount);
  if (m === undefined || m < 0) throw new ProdigiError(`prodigi_bad_amount_${what}`);
  return microsToCents(m, "ceil");
}

/** The RequiresPaymentAuthorisation issue on an order, if any. */
export function paymentBlock(o: ProdigiOrder | undefined): { amountCents?: number; authorisationUrl?: string } | undefined {
  const issue = (o?.status?.issues ?? []).find((i) => (i.errorCode ?? "").toLowerCase() === PAYMENT_AUTH_CODE.toLowerCase());
  if (!issue) return undefined;
  const pd = issue.authorisationDetails?.paymentDetails;
  const micros = pd && (pd.currency ?? "").toUpperCase() === "USD" ? moneyToMicros(pd.amount) : undefined;
  const url = issue.authorisationDetails?.authorisationUrl;
  return {
    amountCents: micros !== undefined && micros >= 0 ? microsToCents(micros, "ceil") : undefined,
    authorisationUrl: typeof url === "string" && url.startsWith("https://") ? url : undefined,
  };
}

/** Read Prodigi's error body `{outcome, statusText, statusCode}` into a code. Never echoes the request. */
export function readProdigiError(status: number, body: unknown): string {
  const b = (body && typeof body === "object") ? body as Record<string, unknown> : {};
  if (typeof b.outcome === "string" && /^[A-Za-z]{2,40}$/.test(b.outcome)) return b.outcome.toLowerCase();
  if (status === 401) return "unauthorized";
  if (status === 404) return "entitynotfound";
  return status >= 500 ? "prodigi_server_error" : `prodigi_http_${status}`;
}

export function mapProdigiStatus(o: ProdigiOrder): "open" | "shipped" | "delivered" | "cancelled" {
  const stage = (o.status?.stage ?? "").toLowerCase();
  if (stage === "cancelled") return "cancelled";
  // "Complete: all of the order's shipments have been sent". Prodigi has no door-delivery signal,
  // so Complete is the last state there is; the gate needs "delivered" to close and reveal.
  if (stage === "complete") return "delivered";
  if ((o.shipments ?? []).some((s) => (s.status ?? "").toLowerCase() === "shipped")) return "shipped";
  return "open";
}

export class ProdigiAdapter implements VendorAdapter {
  readonly id = "prodigi";
  /** Prodigi ships to any recipient, so the honest worst case is "others". */
  readonly maxReach: Reach = "others";
  paused = false;

  private readonly apiKey: string;
  readonly baseUrl: string;
  readonly shippingMethod: ProdigiShippingMethod;
  readonly taxRate: number;
  private readonly ownerShipTo?: string | ZincAddress;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(opts: ProdigiAdapterOptions = {}) {
    this.apiKey = opts.apiKey ?? "";
    const env = (opts.env ?? "sandbox").trim().toLowerCase() || "sandbox";
    if (env !== "sandbox" && env !== "production") throw new Error('PRODIGI_ENV must be "sandbox" or "production"');
    const base = (opts.baseUrl || (env === "production" ? PRODIGI_LIVE_BASE_URL : PRODIGI_SANDBOX_BASE_URL))
      .replace(/\/+$/, "");
    const u = new URL(base);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
      throw new Error("prodigi base URL must be https (http only on loopback)");
    }
    this.baseUrl = base;
    const sm = PRODIGI_SHIPPING_METHODS.find((m) => m.toLowerCase() === (opts.shippingMethod ?? "").toLowerCase());
    if (opts.shippingMethod && !sm) throw new Error(`PRODIGI_SHIPPING_METHOD must be one of ${PRODIGI_SHIPPING_METHODS.join(", ")}`);
    this.shippingMethod = sm ?? PRODIGI_DEFAULT_SHIPPING;
    this.taxRate = opts.taxRate ?? PRODIGI_DEFAULT_TAX_RATE;
    if (!(Number.isFinite(this.taxRate) && this.taxRate >= 0 && this.taxRate < 1)) {
      throw new Error("prodigi taxRate must be in [0, 1)");
    }
    this.ownerShipTo = opts.ownerShipTo;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.log = opts.log ?? ((line) => console.warn(line));
  }

  /** True unless this adapter talks to the live API. */
  get isSandbox(): boolean {
    return new URL(this.baseUrl).hostname !== new URL(PRODIGI_LIVE_BASE_URL).hostname;
  }

  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "self" : "others";
  }

  /**
   * POST /v4.0/quotes for the configured shipping method, to the owner's country, in USD.
   * subtotal = items, shipping = shipping, tax = totalTax (or the US buffer when Prodigi warns
   * about US sales tax and quotes none), fee = branded inserts (never requested; 0).
   * Refuses up front what place() would refuse later: missing/invalid image URL, bad SKU, > 10 items.
   */
  async quote(req: PurchaseRequest): Promise<Quote> {
    const items = this.validItems(req.items, ProdigiError);
    const country = this.owner(ProdigiError).country;
    const body = {
      shippingMethod: this.shippingMethod,
      destinationCountryCode: country,
      currencyCode: "USD",
      items: items.map((it) => ({
        sku: it.sku,
        copies: it.qty,
        attributes: it.attributes ?? {},
        assets: [{ printArea: "default" }],
      })),
    };
    const res = await this.call("POST", "/v4.0/quotes", body) as {
      outcome?: string;
      quotes?: ProdigiQuote[];
      issues?: ProdigiIssue[];
    };
    const outcome = (res.outcome ?? "").toLowerCase();
    if (outcome !== "created" && outcome !== "createdwithissues" && outcome !== "ok") {
      throw new ProdigiError(`prodigi_quote_${outcome || "unknown"}`);
    }
    const q = (res.quotes ?? []).find((x) => (x.shipmentMethod ?? "").toLowerCase() === this.shippingMethod.toLowerCase());
    if (!q) throw new ProdigiError("prodigi_quote_no_method");
    const cs = q.costSummary ?? {};
    const subtotalCents = usdCents(cs.items, "items")!;
    const shippingCents = usdCents(cs.shipping, "shipping")!;
    const brandingCents = usdCents(cs.branding, "branding", false) ?? 0;
    const quotedTax = usdCents(cs.totalTax, "tax", false);
    const total = usdCents(cs.totalCost, "total", false);
    if (total !== undefined && Math.abs(total - (subtotalCents + shippingCents + brandingCents + (quotedTax ?? 0))) > 1) {
      throw new ProdigiError("prodigi_quote_inconsistent");
    }
    // Per-unit ceiling the agent asked for.
    for (const it of items) {
      if (it.maxUnitCents === undefined) continue;
      const line = (q.items ?? []).find((x) => (x.sku ?? "").toUpperCase() === it.sku.toUpperCase());
      const unit = usdCents(line?.unitCost, "unit_cost");
      if (unit! > it.maxUnitCents) throw new ProdigiError("prodigi_over_max_unit");
    }
    // A US quote with no tax may still be charged sales tax (Prodigi's UsSalesTaxWarning), so buffer it.
    const taxBuffered = country === "US" && (quotedTax ?? 0) === 0;
    const taxCents = taxBuffered ? Math.round((subtotalCents + shippingCents) * this.taxRate) : (quotedTax ?? 0);
    return {
      subtotalCents,
      taxCents,
      shippingCents,
      feeCents: brandingCents,
      totalCents: subtotalCents + taxCents + shippingCents + brandingCents,
      currency: "USD",
      vendorRef: `prodigi:${this.shippingMethod}`,
      quotedAt: new Date().toISOString(),
      raw: { outcome, shippingMethod: this.shippingMethod, taxBuffered, sandbox: this.isSandbox },
    };
  }

  /**
   * Re-quotes first (no money moves) and refuses if the fresh total is over the hard cap, then
   * POSTs one order with a deterministic `idempotencyKey` (so a human re-place returns
   * `alreadyExists`, never a second order). chargedCents = the larger of the fresh quote and any
   * payment amount Prodigi names. RequiresPaymentAuthorisation → the order is returned (placed
   * but blocked) and one line is logged; it is never retried.
   */
  async place(req: PurchaseRequest, q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.apiKey) throw new GuardRefused("prodigi_api_key_missing");
    if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) throw new GuardRefused("prodigi_third_party_shipto_unsupported");
    const items = this.validItems(req.items, GuardRefused);
    const a = this.owner(GuardRefused);
    if (q.totalCents > hardCapCents) throw new GuardRefused("max_price_exceeded");

    let fresh: Quote;
    try {
      fresh = await this.quote(req);
    } catch (e) {
      throw new GuardRefused(e instanceof ProdigiError ? `requote:${e.code}` : "requote_failed");
    }
    if (fresh.totalCents > hardCapCents) throw new GuardRefused("max_price_exceeded");

    const key = await hashedRef(idempotencyKey);
    const body = {
      merchantReference: key,
      idempotencyKey: key,
      shippingMethod: this.shippingMethod,
      recipient: {
        name: `${a.first_name} ${a.last_name}`,
        phoneNumber: a.phone_number,
        address: {
          line1: a.address_line1,
          ...(a.address_line2 ? { line2: a.address_line2 } : {}),
          postalOrZipCode: a.postal_code,
          countryCode: a.country,
          townOrCity: a.city,
          ...(a.state ? { stateOrCounty: a.state } : {}),
        },
      },
      items: items.map((it, n) => ({
        merchantReference: `${key}-${n + 1}`,
        sku: it.sku,
        copies: it.qty,
        sizing: it.sizing ?? "fillPrintArea",
        attributes: it.attributes ?? {},
        assets: [{ printArea: "default", url: it.url! }],
      })),
      metadata: { ejb_idempotency_key: key, task_id: req.taskId.slice(0, 200) },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v4.0/orders`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProdigiError("prodigi_network_error"); // may or may not have reached Prodigi
    }
    const json = await res.json().catch(() => undefined) as { outcome?: string; order?: ProdigiOrder } | undefined;
    if (!res.ok) {
      const code = readProdigiError(res.status, json);
      if (res.status < 500 && DEFINITE_REJECTIONS.has(code)) throw new GuardRefused(`prodigi_${code}`);
      throw new ProdigiError(code, res.status);
    }
    const outcome = (json?.outcome ?? "").toLowerCase();
    const o = json?.order;
    if (!ORDER_OK.has(outcome) || !o || typeof o.id !== "string" || !/^ord_[A-Za-z0-9]+$/.test(o.id)) {
      throw new ProdigiError(`prodigi_unexpected_outcome_${outcome || "none"}`, res.status);
    }
    const block = paymentBlock(o);
    const chargedCents = Math.max(fresh.totalCents, block?.amountCents ?? 0);
    if (block) {
      this.log(
        `prodigi: order ${o.id} PLACED BUT BLOCKED (${PAYMENT_AUTH_CODE}, $${(chargedCents / 100).toFixed(2)}): ` +
          "authorise or cancel it in the Prodigi dashboard; the gate will not retry it.",
      );
    }
    return {
      vendorOrderId: o.id,
      chargedCents,
      raw: {
        outcome,
        stage: o.status?.stage,
        ...(block ? { blocked: PAYMENT_AUTH_CODE, authorisationUrl: block.authorisationUrl } : {}),
      },
    };
  }

  /** Cancelled → cancelled; Complete → delivered; a shipment Shipped → shipped; else open (+ raw.blocked). */
  async status(vendorOrderId: string) {
    const json = await this.call("GET", `/v4.0/orders/${this.orderId(vendorOrderId)}`) as { order?: ProdigiOrder };
    const o = json.order ?? {};
    const tracking = (o.shipments ?? []).find((s) => s.tracking?.number)?.tracking?.number;
    const block = paymentBlock(o);
    return {
      state: mapProdigiStatus(o),
      tracking,
      raw: {
        stage: o.status?.stage,
        // Tracking pages for the delivery why-note (the gate keeps https ones only).
        links: (o.shipments ?? []).map((s) => s.tracking?.url).filter((u): u is string => typeof u === "string"),
        ...(block ? { blocked: PAYMENT_AUTH_CODE, authorisationUrl: block.authorisationUrl } : {}),
      },
    };
  }

  /** POST actions/cancel: `cancelled` → true; `failedToCancel` / `actionNotAvailable` → false. */
  async cancel(vendorOrderId: string): Promise<boolean> {
    const json = await this.call("POST", `/v4.0/orders/${this.orderId(vendorOrderId)}/actions/cancel`) as { outcome?: string };
    const outcome = (json.outcome ?? "").toLowerCase();
    if (outcome === "cancelled") return true;
    if (outcome === "failedtocancel" || outcome === "actionnotavailable") return false;
    throw new ProdigiError(`prodigi_cancel_${outcome || "unknown"}`);
  }

  /**
   * GET /v4.0/orders?createdFrom= (pages of 100). One charge per order = the net of its
   * `charges[].totalCost` (refunds are negative). Orders with no charges yet, or netting to 0,
   * are skipped. Non-USD charges are an error (fail closed).
   */
  async listCharges(sinceISO: string): Promise<Charge[]> {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) throw new ProdigiError("prodigi_bad_since");
    const out: Charge[] = [];
    const top = 100;
    for (let skip = 0; skip < 10_000; skip += top) {
      const qs = new URLSearchParams({ createdFrom: new Date(since).toISOString(), top: String(top), skip: String(skip) });
      const page = await this.call("GET", `/v4.0/orders?${qs}`) as { orders?: ProdigiOrder[]; hasMore?: boolean };
      const orders = page.orders ?? [];
      for (const o of orders) {
        if (typeof o.id !== "string" || !o.id) throw new ProdigiError("prodigi_order_without_id");
        let micros = 0;
        for (const c of o.charges ?? []) {
          if ((c.totalCost?.currency ?? "").toUpperCase() !== "USD") throw new ProdigiError("prodigi_currency_not_usd");
          const m = moneyToMicros(c.totalCost?.amount);
          if (m === undefined) throw new ProdigiError("prodigi_bad_charge_amount");
          micros += m;
        }
        const cents = microsToCents(micros);
        if (cents <= 0) continue;
        const t = Date.parse(o.created ?? "");
        out.push({
          vendorChargeId: `prodigi:${o.id}`,
          amountCents: cents,
          at: Number.isFinite(t) ? new Date(t).toISOString() : new Date(since).toISOString(),
          vendorOrderId: o.id,
        });
      }
      if (!page.hasMore || orders.length === 0) break;
    }
    return out;
  }

  /** Local flag only. The real kill: pause the Privacy `prodigi` card (and/or revoke the key). */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  private owner(E: new (code: string) => Error): ZincAddress {
    try {
      return parseOwnerAddress(this.ownerShipTo);
    } catch (e) {
      const code = e instanceof GuardRefused ? e.code.replace(/^zinc_/, "prodigi_") : "prodigi_owner_address_invalid";
      throw new E(code);
    }
  }

  private validItems(items: Item[], E: new (code: string) => Error): ProdigiItem[] {
    if (!items.length) throw new E("prodigi_no_items");
    if (items.length > MAX_ITEMS) throw new E("prodigi_too_many_items");
    return items.map((raw) => {
      const it = raw as ProdigiItem;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(it.sku)) throw new E("prodigi_bad_sku");
      if (!Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > 50) throw new E("prodigi_bad_qty");
      if (!it.url) throw new E("prodigi_item_url_missing");
      let u: URL;
      try {
        u = new URL(it.url);
      } catch {
        throw new E("prodigi_item_url_invalid");
      }
      if (u.protocol !== "https:" || u.username || u.password) throw new E("prodigi_item_url_invalid");
      if (it.sizing !== undefined && !PRODIGI_SIZINGS.includes(it.sizing)) throw new E("prodigi_bad_sizing");
      if (it.attributes !== undefined) {
        const ok = it.attributes && typeof it.attributes === "object" && !Array.isArray(it.attributes) &&
          Object.entries(it.attributes).every(([k, v]) =>
            /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k) && typeof v === "string" && v.length <= 80
          );
        if (!ok) throw new E("prodigi_bad_attributes");
      }
      return it;
    });
  }

  private orderId(id: string): string {
    if (!/^ord_[A-Za-z0-9]+$/.test(id)) throw new ProdigiError("prodigi_bad_order_id");
    return id;
  }

  private headers(json: boolean): HeadersInit {
    const h: Record<string, string> = { "X-API-Key": this.apiKey, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.apiKey) throw new ProdigiError("prodigi_api_key_missing");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProdigiError("prodigi_network_error");
    }
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new ProdigiError(readProdigiError(res.status, json), res.status);
    return json;
  }
}

/**
 * Build from env: PRODIGI_API_KEY, PRODIGI_ENV ("sandbox" default | "production"),
 * PRODIGI_SHIPPING_METHOD, PRODIGI_TAX_RATE, OWNER_SHIP_TO_JSON.
 */
export function prodigiFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): ProdigiAdapter {
  const tax = env("PRODIGI_TAX_RATE");
  return new ProdigiAdapter({
    apiKey: env("PRODIGI_API_KEY"),
    env: env("PRODIGI_ENV"),
    shippingMethod: env("PRODIGI_SHIPPING_METHOD"),
    taxRate: tax ? Number(tax) : undefined,
    ownerShipTo: env("OWNER_SHIP_TO_JSON"),
  });
}
