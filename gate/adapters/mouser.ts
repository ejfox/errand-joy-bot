// Mouser API V1 (https://api.mouser.com, Swagger at https://api.mouser.com/api/docs/V1) vendor
// adapter: electronics, including Adafruit parts (Mouser lists them as `485-<PID>`). Paid with the
// saved credit card on the My Mouser account (a Privacy.com merchant-locked card, monthly cap).
//
// API facts this adapter is built on (Swagger fetched 2026-10-11):
// - Auth is an `apiKey` QUERY parameter (a UUID). Two keys: the Search API key for
//   `POST /api/v1/search/partnumber`, and the Order (cart + order) API key for everything else.
//   Because the key rides in the URL, this adapter never puts a URL in an error, a log line or
//   `raw`, and `scrubUrl()` redacts it for anyone who must log one. Deno's fetch errors embed the
//   URL, so they are caught and replaced, never rethrown.
// - Ordering: `POST /api/v1/cart/items/insert` with no CartKey makes a new cart →
//   `POST /api/v1/order/options/query` lists shipping methods and saved cards (`PaymentTypes[]`
//   with `CreditCardLastFourDigits`) → `POST /api/v1/order` with `SubmitOrder:false` returns an
//   order summary (a free dry run) → the same body with `SubmitOrder:true` places it.
// - No idempotency field exists. The gate key (hashed) goes in `Payment.PoNumber`, and place()
//   looks it up in order history before submitting.
// - No cancel endpoint: cancel() returns false (cancel by phone/email with Mouser).
// - No per-key spend limit at Mouser: the vendor-side cap is the Privacy card's monthly limit.
//   pause() is local; the real kill is pausing the Privacy `mouser` card.
import { OWNER_HOME } from "../types.ts";
import type { Charge, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";
import { parseOwnerAddress, type ZincAddress } from "./zinc.ts";
import { hashedRef, microsToCents, moneyToMicros } from "./money.ts";

export const MOUSER_DEFAULT_BASE_URL = "https://api.mouser.com";
/** Search prices carry no tax: the quote adds this buffer on the subtotal (the dry run is the truth). */
export const MOUSER_DEFAULT_TAX_RATE = 0.1;
/** Search carries no shipping: the quote adds this estimate (the dry run is the truth). */
export const MOUSER_DEFAULT_SHIPPING_ESTIMATE_CENTS = 999;
/** The dry-run total may exceed the quote by at most 10% (and never the hard cap). */
export const MOUSER_MAX_DRIFT = 1.1;
const TIMEOUT_MS = 30_000;
const MAX_ITEMS = 10; // search/partnumber takes at most 10 part numbers
const HISTORY_LOOKBACK_DAYS = 30;

export interface MouserAdapterOptions {
  searchApiKey?: string;
  orderApiKey?: string;
  /** Last four digits of the saved card Mouser must charge (the Privacy card). Not a secret. */
  cardLast4?: string;
  /** Optional Mouser shipping method `Code`; default = the cheapest the account offers. */
  shippingCode?: number;
  taxRate?: number;
  shippingEstimateCents?: number;
  /** The owner's address, Zinc shape (OWNER_SHIP_TO_JSON, raw JSON or base64). */
  ownerShipTo?: string | ZincAddress;
  /** Tests only (https, or http on loopback). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** A Mouser failure where an order MAY exist (or we can't tell): the gate records outcome_unknown. */
export class MouserError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "MouserError";
  }
}

/** Replace any `apiKey=` query value with REDACTED. Use before logging any Mouser URL. */
export function scrubUrl(url: string): string {
  return url.replace(/([?&]api[_-]?key=)[^&#\s]*/gi, "$1REDACTED");
}

interface ErrorEntity {
  Code?: string;
  Message?: string;
  PropertyName?: string;
}
interface PriceBreak {
  Quantity?: number;
  Price?: string;
  Currency?: string;
}
interface MouserPart {
  MouserPartNumber?: string;
  Min?: string;
  Mult?: string;
  AvailabilityInStock?: string | null;
  PriceBreaks?: PriceBreak[];
  RestrictionMessage?: string | null;
}
interface OrderLine {
  MouserPartNumber?: string;
  Quantity?: number;
  Errors?: ErrorEntity[];
}
interface MouserOrder {
  OrderLines?: OrderLine[];
  CurrencyCode?: string;
  MerchandiseTotal?: number;
  additionalFeesTotal?: number;
  OrderTotal?: number;
  TaxAmount?: number;
  OrderID?: string | null;
  ShippingMethod?: { PrimaryShippingRate?: number } | null;
  PaymentMethod?: { PONumber?: string | null } | null;
  ShippingAddress?: { PostalCode?: string } | null;
  Errors?: ErrorEntity[];
  SubmitOrder?: boolean;
}
interface OrderDetail {
  WebOrderId?: number;
  OrderStatusName?: string;
  OrderDate?: string;
  CurrencyCode?: string;
  SummaryDetail?: { OrderTotal?: string } | null;
  DeliveryDetail?: { TrackingDetails?: { Number?: string }[] } | null;
}
interface HistoryItem {
  DateCreated?: string;
  WebOrderNumber?: string;
  SalesOrderNumber?: string;
  PoNumber?: string;
  OrderStatusDisplay?: string;
}

/** First error code from a Mouser `Errors[]` array, sanitised to a short token. */
function errCode(errors: ErrorEntity[] | undefined): string | undefined {
  const e = (errors ?? [])[0];
  if (!e) return undefined;
  const raw = e.Code || e.PropertyName || "error";
  return raw.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40).toLowerCase() || "error";
}

/** Mouser's mm/dd/yyyy (UTC). */
export function mouserDate(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

function toInt(s: unknown, dflt: number): number {
  const n = typeof s === "number" ? s : typeof s === "string" ? Number(s.replace(/[^0-9]/g, "")) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
}

/** Dollars (number from the order endpoint) → cents; refuses non-finite or negative values. */
function dollars(n: unknown): number | undefined {
  if (n === undefined || n === null) return undefined;
  const m = moneyToMicros(n);
  return m === undefined || m < 0 ? undefined : microsToCents(m, "ceil");
}

/**
 * What the order will cost: the larger of Mouser's OrderTotal and the sum of its parts
 * (merchandise + fees + tax + shipping), so a missing field can't make it look cheaper.
 */
export function mouserOrderTotalCents(o: MouserOrder): number | undefined {
  const total = dollars(o.OrderTotal);
  const parts = [o.MerchandiseTotal, o.additionalFeesTotal, o.TaxAmount, o.ShippingMethod?.PrimaryShippingRate]
    .map(dollars).reduce((a: number, b) => a + (b ?? 0), 0);
  if (total === undefined && parts === 0) return undefined;
  return Math.max(total ?? 0, parts);
}

export function mapMouserStatus(d: OrderDetail): "open" | "shipped" | "delivered" | "cancelled" {
  const name = (d.OrderStatusName ?? "").toLowerCase();
  if (name.includes("cancel")) return "cancelled";
  // Mouser does not enumerate OrderStatusName and has no delivery signal; tracking = shipped.
  if ((d.DeliveryDetail?.TrackingDetails ?? []).some((t) => t.Number)) return "shipped";
  if (name.includes("shipped") || name.includes("invoiced")) return "shipped";
  return "open";
}

/** The unit price (micro-dollars) at the highest price break whose Quantity ≤ qty. */
export function unitMicrosFor(part: MouserPart, qty: number): number | undefined {
  const breaks = (part.PriceBreaks ?? [])
    .filter((b) => Number.isSafeInteger(b.Quantity) && (b.Quantity as number) <= qty)
    .sort((a, b) => (b.Quantity as number) - (a.Quantity as number));
  const b = breaks[0];
  if (!b) return undefined;
  if ((b.Currency ?? "USD").toUpperCase() !== "USD") throw new MouserError("mouser_currency_not_usd");
  const m = moneyToMicros(b.Price);
  return m !== undefined && m > 0 ? m : undefined;
}

export class MouserAdapter implements VendorAdapter {
  readonly id = "mouser";
  /** A distributor ships to any address, so the honest worst case is "others". */
  readonly maxReach: Reach = "others";
  paused = false;

  private readonly searchApiKey: string;
  private readonly orderApiKey: string;
  private readonly cardLast4: string;
  readonly shippingCode?: number;
  readonly taxRate: number;
  readonly shippingEstimateCents: number;
  private readonly ownerShipTo?: string | ZincAddress;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MouserAdapterOptions = {}) {
    this.searchApiKey = opts.searchApiKey ?? "";
    this.orderApiKey = opts.orderApiKey ?? "";
    this.cardLast4 = (opts.cardLast4 ?? "").trim();
    if (opts.shippingCode !== undefined && !Number.isSafeInteger(opts.shippingCode)) {
      throw new Error("MOUSER_SHIPPING_CODE must be an integer");
    }
    this.shippingCode = opts.shippingCode;
    this.taxRate = opts.taxRate ?? MOUSER_DEFAULT_TAX_RATE;
    if (!(Number.isFinite(this.taxRate) && this.taxRate >= 0 && this.taxRate < 1)) {
      throw new Error("mouser taxRate must be in [0, 1)");
    }
    this.shippingEstimateCents = opts.shippingEstimateCents ?? MOUSER_DEFAULT_SHIPPING_ESTIMATE_CENTS;
    if (!Number.isSafeInteger(this.shippingEstimateCents) || this.shippingEstimateCents < 0) {
      throw new Error("mouser shippingEstimateCents must be >= 0");
    }
    this.ownerShipTo = opts.ownerShipTo;
    const base = (opts.baseUrl || MOUSER_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const u = new URL(base);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
      throw new Error("mouser base URL must be https (http only on loopback)");
    }
    this.baseUrl = base;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "self" : "others";
  }

  /**
   * One `search/partnumber` call (Search key, Exact match) for all part numbers. Per item: the
   * price break for qty (qty must meet Min and Mult; in-stock count must cover it when Mouser
   * reports one), × qty, rounded up to the cent. Tax = subtotal × taxRate; shipping = the
   * configured estimate. Both are buffers: place()'s dry run carries Mouser's real numbers.
   */
  async quote(req: PurchaseRequest): Promise<Quote> {
    const items = this.validItems(req, MouserError);
    const body = {
      SearchByPartRequest: { mouserPartNumber: items.map((i) => i.sku).join("|"), partSearchOptions: "Exact" },
    };
    const res = await this.call("search", "/search/partnumber", body) as {
      Errors?: ErrorEntity[];
      SearchResults?: { Parts?: MouserPart[] } | null;
    };
    const ec = errCode(res.Errors);
    if (ec) throw new MouserError(`mouser_search_${ec}`);
    const parts = res.SearchResults?.Parts ?? [];
    let subtotalCents = 0;
    const lines: { sku: string; qty: number; unitMicros: number }[] = [];
    for (const it of items) {
      const part = parts.find((p) => (p.MouserPartNumber ?? "").toUpperCase() === it.sku.toUpperCase());
      if (!part) throw new MouserError("mouser_part_not_found");
      const min = toInt(part.Min, 1);
      const mult = toInt(part.Mult, 1);
      if (it.qty < min) throw new MouserError("mouser_below_min_qty");
      if (it.qty % mult !== 0) throw new MouserError("mouser_not_order_multiple");
      const stockRaw = part.AvailabilityInStock;
      const stock = typeof stockRaw === "string" && /\d/.test(stockRaw) ? toInt(stockRaw, 0) : undefined;
      if (stock !== undefined && stock < it.qty) throw new MouserError("mouser_insufficient_stock");
      const unit = unitMicrosFor(part, it.qty);
      if (unit === undefined) throw new MouserError("mouser_no_price");
      if (it.maxUnitCents !== undefined && unit > it.maxUnitCents * 10_000) throw new MouserError("mouser_over_max_unit");
      subtotalCents += microsToCents(unit * it.qty, "ceil");
      lines.push({ sku: part.MouserPartNumber!, qty: it.qty, unitMicros: unit });
    }
    const taxCents = Math.round(subtotalCents * this.taxRate);
    const shippingCents = this.shippingEstimateCents;
    return {
      subtotalCents,
      taxCents,
      shippingCents,
      totalCents: subtotalCents + taxCents + shippingCents,
      currency: "USD",
      vendorRef: "mouser:search",
      quotedAt: new Date().toISOString(),
      raw: { lines, taxRate: this.taxRate, shippingEstimateCents: shippingCents, estimate: true },
    };
  }

  /**
   * 1. order history: an order already carrying this PoNumber is returned, not re-placed.
   * 2. new cart with exactly the requested lines. 3. options: the saved card whose last four
   * digits equal MOUSER_CARD_LAST4 (exactly one), the shipping method. 4. `SubmitOrder:false`
   * dry run: lines must match, total ≤ min(hard cap, quote × 1.10). 5. `SubmitOrder:true`.
   * Steps 1-4 can't move money, so every failure there is a GuardRefused. Only step 5 can.
   */
  async place(req: PurchaseRequest, q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.orderApiKey) throw new GuardRefused("mouser_order_api_key_missing");
    if (!/^\d{4}$/.test(this.cardLast4)) throw new GuardRefused("mouser_card_last4_missing");
    if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) throw new GuardRefused("mouser_third_party_shipto_unsupported");
    const items = this.validItems(req, GuardRefused);
    const address = this.ownerAddress();
    const ceiling = Math.min(hardCapCents, Math.floor(q.totalCents * MOUSER_MAX_DRIFT));
    const poNumber = await hashedRef(idempotencyKey, 16); // "ejb-" + 16 hex = 20 chars

    // Every step before the submit is refused-on-failure: nothing can have been ordered yet.
    const pre = async <T>(step: string, f: () => Promise<T>): Promise<T> => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof GuardRefused) throw e;
        throw new GuardRefused(`mouser_${step}:${e instanceof MouserError ? e.code : "error"}`);
      }
    };

    // 1. Already placed under this PoNumber (an earlier attempt that errored after submitting)?
    const recent = await pre("history", () => this.history(new Date(Date.now() - HISTORY_LOOKBACK_DAYS * 86_400_000)));
    const priorWeb = this.findByPoNumber(recent, poNumber);
    if (priorWeb) {
      // The order is real: from here a failure is MouserError (outcome unknown), never refused.
      const d = await this.detail(priorWeb);
      const m = moneyToMicros(d.SummaryDetail?.OrderTotal);
      if (m === undefined) throw new MouserError("mouser_order_without_total");
      return { vendorOrderId: priorWeb, chargedCents: microsToCents(m), raw: { poNumber, found: "history" } };
    }

    // 2. A fresh cart holding exactly these lines.
    const cart = await pre("cart", async () => {
      const c = await this.call("order", "/cart/items/insert", {
        CartItems: items.map((i) => ({ MouserPartNumber: i.sku, Quantity: i.qty })),
      }) as { Errors?: ErrorEntity[]; CartKey?: string; CartItems?: OrderLine[] };
      const ec = errCode(c.Errors);
      if (ec) throw new MouserError(ec);
      if (!c.CartKey || !/^[0-9a-f-]{36}$/i.test(c.CartKey)) throw new MouserError("no_cart_key");
      this.assertLines(c.CartItems, items);
      return c.CartKey;
    });

    // 3. Payment method = the Privacy card on file; shipping method.
    const opts = await pre("options", async () => {
      const r = await this.call("order", "/order/options/query", {
        OrderInitialize: { ShippingAddress: address, CurrencyCode: "USD", CartKey: cart },
      }) as {
        OrderInitialize?: {
          Errors?: ErrorEntity[];
          Payment?: { PaymentTypes?: { Method?: number; Name?: string; CreditCardLastFourDigits?: string }[] };
          Shipping?: { Methods?: { Method?: string; Rate?: number; Code?: number }[] };
        };
      };
      const oi = r.OrderInitialize ?? {};
      const ec = errCode(oi.Errors);
      if (ec) throw new MouserError(ec);
      const cards = (oi.Payment?.PaymentTypes ?? []).filter((p) => (p.CreditCardLastFourDigits ?? "").trim() === this.cardLast4);
      if (cards.length !== 1 || !Number.isSafeInteger(cards[0].Method)) {
        throw new GuardRefused(cards.length ? "mouser_card_ambiguous" : "mouser_card_not_on_file");
      }
      const methods = (oi.Shipping?.Methods ?? []).filter((m) => Number.isSafeInteger(m.Code));
      const ship = this.shippingCode !== undefined
        ? methods.find((m) => m.Code === this.shippingCode)
        : methods.filter((m) => typeof m.Rate === "number" && m.Rate >= 0).sort((a, b) => a.Rate! - b.Rate!)[0];
      if (!ship) throw new GuardRefused("mouser_shipping_method_unavailable");
      return { method: cards[0].Method as number, shipCode: ship.Code as number };
    });

    const orderBody = (submit: boolean) => ({
      Order: {
        ShippingAddress: address,
        OrderType: "Unspecified",
        PrimaryShipping: { Code: opts.shipCode },
        Payment: { Method: opts.method, CreditCardLastFourDigits: this.cardLast4, PoNumber: poNumber },
        CurrencyCode: "USD",
        CartKey: cart,
        SubmitOrder: submit,
      },
    });

    // 4. Dry run (SubmitOrder:false): Mouser's own total, before any money can move.
    const dryTotal = await pre("dry_run", async () => {
      const r = await this.call("order", "/order", orderBody(false)) as { Order?: MouserOrder } & MouserOrder;
      const o = r.Order ?? r;
      const ec = errCode(o.Errors);
      if (ec) throw new MouserError(ec);
      if ((o.CurrencyCode ?? "USD").toUpperCase() !== "USD") throw new GuardRefused("mouser_currency_not_usd");
      this.assertLines(o.OrderLines, items);
      const total = mouserOrderTotalCents(o);
      if (total === undefined || total <= 0) throw new MouserError("no_total");
      return total;
    });
    if (dryTotal > hardCapCents) throw new GuardRefused("max_price_exceeded");
    if (dryTotal > ceiling) throw new GuardRefused("mouser_dry_run_over_quote");

    // 5. The only call that can spend money.
    let res: Response;
    try {
      res = await this.fetchImpl(this.url("order", "/order"), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(orderBody(true)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new MouserError("mouser_network_error"); // may or may not have reached Mouser
    }
    const json = await res.json().catch(() => undefined) as ({ Order?: MouserOrder } & MouserOrder) | undefined;
    if (res.status === 401 || res.status === 403) throw new GuardRefused(`mouser_http_${res.status}`);
    if (!res.ok) throw new MouserError(`mouser_http_${res.status}`, res.status);
    const o = json?.Order ?? json ?? {};
    const id = typeof o.OrderID === "string" ? o.OrderID.trim() : "";
    if (!/^\d{1,18}$/.test(id)) {
      // 200 without a (numeric web) order number: Mouser may or may not have taken it. Never guess.
      // Digits only, because status() and listCharges() look orders up by web order number.
      throw new MouserError(`mouser_submit_no_order_id${errCode(o.Errors) ? `_${errCode(o.Errors)}` : ""}`, res.status);
    }
    const submitTotal = mouserOrderTotalCents(o) ?? 0;
    return {
      vendorOrderId: id,
      chargedCents: Math.max(dryTotal, submitTotal),
      raw: { poNumber, dryRunCents: dryTotal },
    };
  }

  /** orderhistory/webOrderNumber → cancelled (status name), shipped (tracking), else open. */
  async status(vendorOrderId: string) {
    const d = await this.detail(vendorOrderId);
    const tracking = (d.DeliveryDetail?.TrackingDetails ?? []).find((t) => t.Number)?.Number;
    return { state: mapMouserStatus(d), tracking, raw: { status: d.OrderStatusName } };
  }

  /** Mouser's API has no cancel endpoint. Cancel by phone or email; the gate is told "not cancelled". */
  cancel(_vendorOrderId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * orderhistory/ByDateRange (since → tomorrow, mm/dd/yyyy) then each order's detail for its
   * total. One charge per non-cancelled order, vendorOrderId = the web order number.
   */
  async listCharges(sinceISO: string): Promise<Charge[]> {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) throw new MouserError("mouser_bad_since");
    const items = await this.history(new Date(since));
    const out: Charge[] = [];
    for (const h of items.slice(0, 200)) {
      const web = (h.WebOrderNumber ?? "").trim();
      if (!web) continue;
      const t = Date.parse(h.DateCreated ?? "");
      if (Number.isFinite(t) && t < since) continue;
      const d = await this.detail(web);
      if (mapMouserStatus(d) === "cancelled") continue;
      if ((d.CurrencyCode ?? "USD").toUpperCase() !== "USD") throw new MouserError("mouser_currency_not_usd");
      const m = moneyToMicros(d.SummaryDetail?.OrderTotal);
      if (m === undefined) throw new MouserError("mouser_order_without_total");
      out.push({
        vendorChargeId: `mouser:${web}`,
        amountCents: microsToCents(m),
        at: new Date(Number.isFinite(t) ? t : since).toISOString(),
        vendorOrderId: web,
      });
    }
    return out;
  }

  /** Local flag only. The real kill: pause the Privacy `mouser` card (and/or delete the keys in My Mouser). */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  /** The web order number of an order already carrying this PoNumber, if any. */
  private findByPoNumber(history: HistoryItem[], po: string): string | undefined {
    const hit = history.filter((h) => (h.PoNumber ?? "").trim() === po);
    if (!hit.length) return undefined;
    // An order with our PoNumber exists, but we can't tell which: a human must look.
    if (hit.length > 1) throw new MouserError("mouser_duplicate_po_number");
    const web = (hit[0].WebOrderNumber ?? "").trim();
    if (!/^\d{1,18}$/.test(web)) throw new MouserError("mouser_bad_order_id");
    return web;
  }

  private async history(from: Date): Promise<HistoryItem[]> {
    const to = new Date(Date.now() + 86_400_000);
    const qs = { startDate: mouserDate(from), endDate: mouserDate(to) };
    const r = await this.call("order", "/orderhistory/ByDateRange", undefined, qs) as {
      Errors?: ErrorEntity[];
      OrderHistoryItems?: HistoryItem[];
    };
    const ec = errCode(r.Errors);
    if (ec) throw new MouserError(`mouser_history_${ec}`);
    return r.OrderHistoryItems ?? [];
  }

  private async detail(webOrderNumber: string): Promise<OrderDetail> {
    if (!/^\d{1,18}$/.test(webOrderNumber)) throw new MouserError("mouser_bad_order_id");
    return await this.call("order", "/orderhistory/webOrderNumber", undefined, { webOrderNumber }) as OrderDetail;
  }

  private assertLines(lines: OrderLine[] | undefined, items: { sku: string; qty: number }[]): void {
    const got = new Map<string, number>();
    for (const l of lines ?? []) {
      if ((l.Errors ?? []).length) throw new GuardRefused(`mouser_line_${errCode(l.Errors)}`);
      const k = (l.MouserPartNumber ?? "").toUpperCase();
      got.set(k, (got.get(k) ?? 0) + (l.Quantity ?? 0));
    }
    const want = new Map(items.map((i) => [i.sku.toUpperCase(), i.qty]));
    if (got.size !== want.size || [...want].some(([k, q]) => got.get(k) !== q)) {
      throw new GuardRefused("mouser_lines_mismatch");
    }
  }

  private ownerAddress() {
    let a: ZincAddress;
    try {
      a = parseOwnerAddress(this.ownerShipTo);
    } catch (e) {
      throw new GuardRefused(e instanceof GuardRefused ? e.code.replace(/^zinc_/, "mouser_") : "mouser_owner_address_invalid");
    }
    return {
      AddressLocationTypeID: "Residential",
      CountryCode: a.country,
      FirstName: a.first_name,
      LastName: a.last_name,
      AddressOne: a.address_line1,
      ...(a.address_line2 ? { AddressTwo: a.address_line2 } : {}),
      City: a.city,
      ...(a.state ? { StateOrProvince: a.state } : {}),
      PostalCode: a.postal_code,
      PhoneNumber: a.phone_number,
    };
  }

  private validItems(req: PurchaseRequest, E: new (code: string) => Error): { sku: string; qty: number; maxUnitCents?: number }[] {
    if (!req.items.length) throw new E("mouser_no_items");
    if (req.items.length > MAX_ITEMS) throw new E("mouser_too_many_items");
    const seen = new Set<string>();
    return req.items.map((it) => {
      // Mouser: 3-40 chars per part number; a pipe would smuggle a second part into the search.
      if (!/^[A-Za-z0-9][A-Za-z0-9._\-\/#+]{2,39}$/.test(it.sku)) throw new E("mouser_bad_part_number");
      if (seen.has(it.sku.toUpperCase())) throw new E("mouser_duplicate_part_number");
      seen.add(it.sku.toUpperCase());
      if (!Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > 1000) throw new E("mouser_bad_qty");
      return { sku: it.sku, qty: it.qty, maxUnitCents: it.maxUnitCents };
    });
  }

  /** The request URL. It holds a key: never log, throw or store it (see scrubUrl). */
  private url(which: "search" | "order", path: string, qs: Record<string, string> = {}): string {
    const u = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
    u.searchParams.set("apiKey", which === "search" ? this.searchApiKey : this.orderApiKey);
    return u.toString();
  }

  private async call(which: "search" | "order", path: string, body?: unknown, qs?: Record<string, string>): Promise<unknown> {
    const key = which === "search" ? this.searchApiKey : this.orderApiKey;
    if (!key) throw new MouserError(`mouser_${which}_api_key_missing`);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(which, path, qs), {
        method: body === undefined ? "GET" : "POST",
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // Deno's fetch error text contains the URL, and so the key: drop it entirely.
      throw new MouserError("mouser_network_error");
    }
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new MouserError(`mouser_http_${res.status}`, res.status);
    return json;
  }
}

/**
 * Build from env: MOUSER_SEARCH_API_KEY, MOUSER_ORDER_API_KEY, MOUSER_CARD_LAST4,
 * MOUSER_SHIPPING_CODE, MOUSER_TAX_RATE, MOUSER_SHIPPING_ESTIMATE_CENTS, OWNER_SHIP_TO_JSON.
 */
export function mouserFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): MouserAdapter {
  const num = (k: string) => {
    const v = env(k);
    return v ? Number(v) : undefined;
  };
  return new MouserAdapter({
    searchApiKey: env("MOUSER_SEARCH_API_KEY"),
    orderApiKey: env("MOUSER_ORDER_API_KEY"),
    cardLast4: env("MOUSER_CARD_LAST4"),
    shippingCode: num("MOUSER_SHIPPING_CODE"),
    taxRate: num("MOUSER_TAX_RATE"),
    shippingEstimateCents: num("MOUSER_SHIPPING_ESTIMATE_CENTS"),
    ownerShipTo: env("OWNER_SHIP_TO_JSON"),
  });
}
