// CJdropshipping (https://developers.cjdropshipping.com) vendor adapter: catalog goods shipped
// from China (or another CJ warehouse) to the owner's home, paid from the prepaid CJ wallet.
// Built from CJ's own REST docs only (API 2.0). CJ's MCP server is NOT used: it has no usable
// license and its "sensitive operation confirmation" runs the call anyway.
//
// Docs this is built on (read 2026-10-11):
// - Auth: https://developers.cjdropshipping.com/en/api/api2/api/auth.html
//   POST /authentication/getAccessToken {apiKey} → accessToken (180 days) + refreshToken (180
//   days); POST /authentication/refreshAccessToken {refreshToken}. Every call sends the header
//   `CJ-Access-Token`. The API key alone is enough (no email).
// - Sandbox: https://developers.cjdropshipping.com/en/api/start/sandbox.html
//   NOT a separate host: `isSandbox: 1` on the create call makes a sandbox order whose balance
//   payment is simulated (no real deduction, no fulfillment). CJ_ENV=production sends 0.
// - Freight: https://developers.cjdropshipping.com/en/api/api2/api/logistic.html (1.1
//   freightCalculate): per line `logisticPrice`, `taxesFee` ("US taxes fee, not included in
//   postage"), `clearanceOperationFee`, `totalPostageFee`.
// - Orders and wallet: https://developers.cjdropshipping.com/en/api/api2/api/shopping.html
//   createOrderV2 `payType: 3` = create only, no payment; getOrderDetail (accepts our own order
//   number); deleteOrder (only CREATED / IN_CART); getBalance; payBalance / payBalanceV2;
//   order/list filtered by paymentDateFrom/To (UTC, ≤ 90 days).
// - Errors: https://developers.cjdropshipping.com/en/api/api2/standard/ps-code.html
//   1600001 bad token, 1603003 duplicate order, 1604000 balance insufficient, 1604001 balance
//   payment restricted, 1600200/1600201/16900500 rate or quota.
// - Rate limit: https://developers.cjdropshipping.com/en/api/api2/standard/limit.html
//   free tier = 1 request/second per account, so calls are paced (CJ_MIN_INTERVAL_MS).
//
// Money rules (the gate's, enforced here too):
// - DDP only. A China-origin line whose freight quote has no `taxesFee` is refused
//   (`cj_not_ddp`): duty collected at the door never passes through the ledger.
// - CJ's duty is cross-checked against a rough US estimate (40% of goods + shipping, + $3 MPF);
//   under half of that → `cj_duty_suspicious`. CJ's "US taxes fee" may be sales tax rather than
//   customs duty, in which case this refuses often. That is the intended direction.
// - place(): create WITHOUT paying, re-read the order total, refuse over the hard cap, check the
//   wallet, then pay the whole order from the balance (never a partial payment).
//
// pause() is local. The real kill: delete the API key at My CJ → Authorization → API
// (https://www.cjdropshipping.com/my.html#/authorize/API); the logout endpoint is not a kill,
// since the key mints a new token.
import { OWNER_HOME } from "../types.ts";
import type { Charge, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";
import { checkBaseUrl, dollarsToCents, hashedRef, isHttpsUrl } from "./money.ts";
import { parseOwnerAddress, type ZincAddress } from "./zinc.ts";

export const CJ_DEFAULT_BASE_URL = "https://developers.cjdropshipping.com/api2.0/v1";
export const CJ_DEFAULT_FROM_COUNTRY = "CN";
/** Fallback US duty estimate on goods + shipping when nothing better is known (see docs/vendors.md). */
export const CJ_DEFAULT_DUTY_RATE = 0.4;
/** Flat part of the estimate: informal-entry MPF ($2.77), rounded up. */
export const CJ_DEFAULT_DUTY_FLAT_CENTS = 300;
/** Free tier: 1 request/second. A little slack on top. */
export const CJ_DEFAULT_MIN_INTERVAL_MS = 1_100;
const TIMEOUT_MS = 20_000;
/** Refresh the access token when it has less than this left. */
const TOKEN_SLACK_MS = 24 * 3600_000;
const MAX_ITEMS = 10;
const ORDER_NUMBER_MAX = 50;

const CODE_BAD_TOKEN = new Set([1600001, 1600002, 1600030]);
const CODE_DUPLICATE_ORDER = 1603003;
const CODE_BALANCE_INSUFFICIENT = 1604000;
const CODE_BALANCE_RESTRICTED = 1604001;
const CODE_RATE = new Set([1600200, 1600201, 16900500]);

/** Order statuses in which money has left the wallet (CJ "Order Status" table). */
const PAID_STATUSES = new Set(["PENDING", "PROCESSING", "UNSHIPPED", "SHIPPED", "DELIVERED"]);
/** Statuses deleteOrder accepts. */
const DELETABLE_STATUSES = new Set(["CREATED", "IN_CART"]);

/** A CJ failure where money MAY have moved (or we can't tell): the gate records outcome_unknown. */
export class CjError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "CjError";
  }
}

export type CjEnv = "sandbox" | "production";

export interface CjAdapterOptions {
  apiKey?: string;
  /** "sandbox" (default): every order carries isSandbox=1. "production": real orders. */
  env?: string;
  baseUrl?: string;
  /** Origin warehouse country for quotes and orders (default CN). */
  fromCountry?: string;
  /** Pin one logistics line by name (must still be DDP). Default: the cheapest DDP line. */
  logisticName?: string;
  /** The owner's address, Zinc shape (OWNER_SHIP_TO_JSON: raw JSON, base64 JSON, or an object). */
  ownerShipTo?: string | ZincAddress;
  dutyRate?: number;
  dutyFlatCents?: number;
  /** Minimum gap between API calls (CJ free tier: 1/s). 0 in tests. */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The CJ JSON envelope. */
interface CjEnvelope<T = unknown> {
  code?: number;
  result?: boolean;
  success?: boolean;
  message?: string | null;
  data?: T;
  requestId?: string;
}

interface CjVariant {
  vid?: string;
  pid?: string;
  variantSellPrice?: number | string;
  inventories?: { countryCode?: string; totalInventory?: number }[];
}

/** One line of freightCalculate (1.1). Money fields are USD. */
export interface CjFreightLine {
  logisticName?: string;
  logisticAging?: string;
  logisticPrice?: number | string | null;
  taxesFee?: number | string | null;
  clearanceOperationFee?: number | string | null;
  totalPostageFee?: number | string | null;
}

interface CjOrderDetail {
  orderId?: string;
  orderNum?: string;
  cjOrderId?: string | null;
  cjOrderCode?: string | null;
  orderStatus?: string;
  subStatus?: string | null;
  orderAmount?: number | string | null;
  productAmount?: number | string | null;
  postageAmount?: number | string | null;
  paymentDate?: string | null;
  trackNumber?: string | null;
  trackingUrl?: string | null;
  isSandbox?: number;
  shippingCountryCode?: string;
  productList?: { vid?: string; quantity?: number }[] | null;
}

interface CjCreateResult {
  orderId?: string;
  orderNumber?: string;
  shipmentOrderId?: string;
  orderAmount?: number | string | null;
  logisticsMiss?: boolean | string | null;
  interceptOrderReasons?: { code?: number; message?: string }[] | null;
}

/** "pid:vid" or a bare CJ variant id. Ids are CJ's (numeric or UUID-ish). */
export function parseCjSku(sku: string): { pid?: string; vid: string } {
  const re = /^[A-Za-z0-9-]{1,64}$/;
  const parts = sku.split(":");
  if (parts.length === 1 && re.test(parts[0])) return { vid: parts[0] };
  if (parts.length === 2 && re.test(parts[0]) && re.test(parts[1])) return { pid: parts[0], vid: parts[1] };
  throw new CjError("cj_bad_sku");
}

/** Our external order number: the gate idempotency key when it fits CJ's 50 chars, else `ejb-` + sha256 hex. */
export async function cjOrderNumber(idempotencyKey: string): Promise<string> {
  if (new RegExp(`^[A-Za-z0-9_-]{1,${ORDER_NUMBER_MAX}}$`).test(idempotencyKey)) return idempotencyKey;
  return await hashedRef(idempotencyKey, 32);
}

/** Fallback duty estimate in cents: round((goods + shipping) × rate) + flat. Cross-check only. */
export function cjDutyEstimateCents(goodsAndShippingCents: number, rate = CJ_DEFAULT_DUTY_RATE, flatCents = CJ_DEFAULT_DUTY_FLAT_CENTS): number {
  return Math.round(goodsAndShippingCents * rate) + flatCents;
}

/** A freight line priced in cents, or why it can't be used. Pure. */
export function priceFreightLine(
  line: CjFreightLine,
  requireDdp: boolean,
): { ok: true; shippingCents: number; taxCents: number; feeCents: number } | { ok: false; reason: string } {
  const shipping = dollarsToCents(line.logisticPrice);
  if (shipping === undefined) return { ok: false, reason: "no_price" };
  const tax = line.taxesFee === null || line.taxesFee === undefined ? undefined : dollarsToCents(line.taxesFee);
  const clearance = line.clearanceOperationFee === null || line.clearanceOperationFee === undefined
    ? 0
    : dollarsToCents(line.clearanceOperationFee);
  if (clearance === undefined) return { ok: false, reason: "bad_clearance_fee" };
  if (requireDdp && (tax === undefined || tax <= 0)) return { ok: false, reason: "not_ddp" };
  const taxCents = tax ?? 0;
  let feeCents = clearance;
  // totalPostageFee = postage + taxes + clearance (+ tariff). If CJ's total is higher than our
  // sum, the difference is something we didn't itemize: count it (the safe direction).
  const total = line.totalPostageFee === null || line.totalPostageFee === undefined ? undefined : dollarsToCents(line.totalPostageFee);
  if (total !== undefined && total > shipping + taxCents + feeCents) feeCents = total - shipping - taxCents;
  return { ok: true, shippingCents: shipping, taxCents, feeCents };
}

function cents(v: unknown): number | undefined {
  return v === null || v === undefined ? undefined : dollarsToCents(v);
}

function isOk(status: number, j: CjEnvelope | undefined): boolean {
  if (status !== 200 || !j || typeof j !== "object") return false;
  if (j.success === false || j.result === false) return false;
  return j.code === undefined || j.code === 200 || j.code === 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "yyyy-MM-dd HH:mm:ss" in UTC (CJ order list paymentDate filters). */
function cjUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** CJ's UTC "yyyy-MM-dd HH:mm:ss" (or ISO) → epoch ms. */
function parseCjDate(s: unknown): number | undefined {
  if (typeof s !== "string" || !s) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(" ", "T") + "Z" : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

export class CjAdapter implements VendorAdapter {
  readonly id = "cj";
  /** CJ ships to any address, so the honest worst case is "others". */
  readonly maxReach: Reach = "others";
  paused = false;

  readonly env: CjEnv;
  readonly fromCountry: string;
  readonly logisticName?: string;
  readonly dutyRate: number;
  readonly dutyFlatCents: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly ownerShipTo?: string | ZincAddress;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private lastCallAt = 0;
  // Access token cache. Never logged, never put in `raw`, never in an error message.
  private token?: { access: string; accessExp: number; refresh?: string; refreshExp: number };

  constructor(opts: CjAdapterOptions = {}) {
    this.apiKey = opts.apiKey ?? "";
    const env = (opts.env || "sandbox").toLowerCase();
    if (env !== "sandbox" && env !== "production") throw new Error('CJ_ENV must be "sandbox" or "production"');
    this.env = env;
    this.baseUrl = checkBaseUrl(opts.baseUrl || CJ_DEFAULT_BASE_URL, "CJ_BASE_URL");
    this.fromCountry = (opts.fromCountry || CJ_DEFAULT_FROM_COUNTRY).toUpperCase();
    if (!/^[A-Z]{2}$/.test(this.fromCountry)) throw new Error("CJ_FROM_COUNTRY must be a 2-letter country code");
    if (opts.logisticName !== undefined && opts.logisticName !== "") {
      if (!/^[\w +.\-()]{1,50}$/.test(opts.logisticName)) throw new Error("CJ_LOGISTIC_NAME looks wrong");
      this.logisticName = opts.logisticName;
    }
    this.ownerShipTo = opts.ownerShipTo;
    this.dutyRate = opts.dutyRate ?? CJ_DEFAULT_DUTY_RATE;
    if (!(Number.isFinite(this.dutyRate) && this.dutyRate >= 0 && this.dutyRate < 2)) throw new Error("CJ_DUTY_RATE must be in [0, 2)");
    this.dutyFlatCents = opts.dutyFlatCents ?? CJ_DEFAULT_DUTY_FLAT_CENTS;
    if (!Number.isSafeInteger(this.dutyFlatCents) || this.dutyFlatCents < 0) throw new Error("CJ_DUTY_FLAT_CENTS must be >= 0");
    this.minIntervalMs = opts.minIntervalMs ?? CJ_DEFAULT_MIN_INTERVAL_MS;
    if (!Number.isSafeInteger(this.minIntervalMs) || this.minIntervalMs < 0) throw new Error("CJ_MIN_INTERVAL_MS must be >= 0");
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  get isSandbox(): boolean {
    return this.env === "sandbox";
  }

  /** Domestic US-warehouse shipments owe no import duty; everything else must be DDP. */
  get requiresDdp(): boolean {
    return this.fromCountry !== "US";
  }

  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "self" : "others";
  }

  /**
   * Per item: GET /product/variant/queryByVid → variantSellPrice × qty (stock at the origin
   * country required; a "pid:vid" sku must match the variant's pid). Then one
   * POST /logistic/freightCalculate for all items to the owner's ZIP. The cheapest DDP line wins
   * (or CJ_LOGISTIC_NAME). subtotal = goods, shipping = logisticPrice, tax = taxesFee,
   * fee = clearanceOperationFee (+ any unitemized part of totalPostageFee).
   */
  async quote(req: PurchaseRequest): Promise<Quote> {
    if (!req.items.length) throw new CjError("cj_no_items");
    if (req.items.length > MAX_ITEMS) throw new CjError("cj_too_many_items");
    if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) throw new CjError("cj_third_party_shipto_unsupported");
    const zip = this.ownerAddress().postal_code;
    const lines: { vid: string; quantity: number }[] = [];
    let subtotalCents = 0;
    const variants: { vid: string; pid?: string; unitCents: number; qty: number }[] = [];
    for (const it of req.items) {
      if (!Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > 100) throw new CjError("cj_bad_qty");
      const { pid, vid } = parseCjSku(it.sku);
      const v = await this.call<CjVariant>("GET", `/product/variant/queryByVid?${new URLSearchParams({ vid, features: "enable_inventory" })}`);
      if (!v || v.vid !== vid) throw new CjError("cj_variant_not_found");
      if (pid !== undefined && v.pid !== pid) throw new CjError("cj_sku_pid_mismatch");
      const unit = cents(v.variantSellPrice);
      if (unit === undefined || unit <= 0) throw new CjError("cj_variant_without_price");
      if (it.maxUnitCents !== undefined && unit > it.maxUnitCents) throw new CjError("cj_over_max_unit");
      const inv = v.inventories ?? [];
      if (inv.length && !inv.some((i) => i.countryCode === this.fromCountry && (i.totalInventory ?? 0) >= it.qty)) {
        throw new CjError("cj_no_stock_at_origin");
      }
      subtotalCents += unit * it.qty;
      variants.push({ vid, pid: v.pid, unitCents: unit, qty: it.qty });
      lines.push({ vid, quantity: it.qty });
    }

    const freight = await this.call<CjFreightLine[]>("POST", "/logistic/freightCalculate", {
      startCountryCode: this.fromCountry,
      endCountryCode: "US",
      zip,
      products: lines,
    });
    const candidates = (Array.isArray(freight) ? freight : [])
      .filter((l) => typeof l.logisticName === "string" && l.logisticName)
      .filter((l) => this.logisticName === undefined || l.logisticName === this.logisticName);
    if (!candidates.length) throw new CjError("cj_no_logistics");
    const priced = candidates
      .map((l) => ({ l, p: priceFreightLine(l, this.requiresDdp) }))
      .filter((x): x is { l: CjFreightLine; p: { ok: true; shippingCents: number; taxCents: number; feeCents: number } } =>
        x.p.ok
      );
    if (!priced.length) {
      // No line carries CJ-collected US taxes: duty would be billed at the door. Refuse.
      throw new CjError("cj_not_ddp");
    }
    const sum = (p: { shippingCents: number; taxCents: number; feeCents: number }) => p.shippingCents + p.taxCents + p.feeCents;
    // Cheapest total; ties → name order, so the pick is deterministic.
    priced.sort((a, b) => sum(a.p) - sum(b.p) || String(a.l.logisticName).localeCompare(String(b.l.logisticName)));
    const best = priced[0];
    const { shippingCents, taxCents, feeCents } = best.p;

    const dutyEstimateCents = cjDutyEstimateCents(subtotalCents + shippingCents, this.dutyRate, this.dutyFlatCents);
    if (this.requiresDdp && (taxCents + feeCents) * 2 < dutyEstimateCents) {
      // CJ's prepaid duties are under half of a rough US estimate: likely not the real duty.
      throw new CjError("cj_duty_suspicious");
    }

    return {
      subtotalCents,
      taxCents,
      shippingCents,
      feeCents,
      totalCents: subtotalCents + taxCents + shippingCents + feeCents,
      currency: "USD",
      vendorRef: `cj:${best.l.logisticName}`,
      quotedAt: new Date(this.now()).toISOString(),
      raw: {
        logisticName: best.l.logisticName,
        logisticAging: best.l.logisticAging,
        fromCountry: this.fromCountry,
        ddp: this.requiresDdp,
        dutyEstimateCents,
        variants,
        sandbox: this.isSandbox,
      },
    };
  }

  /**
   * createOrderV2 with payType 3 (create only, NO payment) and orderNumber = the gate key (or its
   * hash), then re-read the order. Refuses (deleting the unpaid order) when the total is above
   * the hard cap, below the quote's duty-inclusive floor, intercepted, or the wallet can't cover
   * it. Only then pays the whole order from the balance and confirms paymentDate.
   */
  async place(req: PurchaseRequest, q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.apiKey) throw new GuardRefused("cj_api_key_missing");
    if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) throw new GuardRefused("cj_third_party_shipto_unsupported");
    if (!Number.isSafeInteger(hardCapCents) || hardCapCents <= 0) throw new GuardRefused("bad_hard_cap");
    if (q.totalCents > hardCapCents) throw new GuardRefused("max_price_exceeded");
    const raw = (q.raw ?? {}) as { logisticName?: unknown; ddp?: unknown; sandbox?: unknown };
    const logisticName = typeof raw.logisticName === "string" && raw.logisticName ? raw.logisticName : undefined;
    if (!logisticName) throw new GuardRefused("cj_quote_missing_logistic");
    if (raw.sandbox !== this.isSandbox) throw new GuardRefused("cj_quote_env_mismatch");
    if (this.requiresDdp && raw.ddp !== true) throw new GuardRefused("cj_not_ddp");
    const a = this.ownerAddress();
    const products = req.items.map((it) => ({ vid: parseCjSku(it.sku).vid, quantity: it.qty }));
    const orderNumber = await cjOrderNumber(idempotencyKey);

    // 1. Create, unpaid.
    let created: CjCreateResult | undefined;
    let orderId: string;
    try {
      created = await this.call<CjCreateResult>("POST", "/shopping/order/createOrderV2", {
        orderNumber,
        shippingCountryCode: "US",
        shippingCountry: "United States",
        shippingProvince: a.state ?? "",
        shippingCity: a.city,
        shippingZip: a.postal_code,
        shippingPhone: a.phone_number,
        shippingCustomerName: `${a.first_name} ${a.last_name}`.slice(0, 50),
        shippingAddress: a.address_line1,
        ...(a.address_line2 ? { shippingAddress2: a.address_line2 } : {}),
        logisticName,
        fromCountryCode: this.fromCountry,
        payType: 3,
        isSandbox: this.isSandbox ? 1 : 0,
        products,
      });
      if (!created || typeof created.orderId !== "string" || !created.orderId) throw new GuardRefused("cj_malformed_create");
      orderId = created.orderId;
    } catch (e) {
      if (e instanceof CjError && e.code === `cj_${CODE_DUPLICATE_ORDER}`) {
        // An earlier attempt created it. Resume from what CJ has.
        const found = await this.detailOrUndefined(orderNumber);
        if (!found?.orderId) throw new CjError("cj_duplicate_order_not_found");
        if (this.isPaid(found)) return this.toOrder(found, orderNumber); // already paid: report it
        orderId = found.orderId;
      } else if (e instanceof CjError) {
        // payType 3 never pays, so no money moved, whatever happened.
        throw new GuardRefused(e.code);
      } else throw e;
    }

    // 2. Re-read and check before any money moves.
    const refuse = async (code: string): Promise<never> => {
      await this.deleteQuietly(orderId);
      throw new GuardRefused(code);
    };
    if (created?.interceptOrderReasons?.length) return await refuse("cj_order_intercepted");
    if (created?.logisticsMiss === true || created?.logisticsMiss === "true") return await refuse("cj_logistics_missing");
    let detail: CjOrderDetail;
    try {
      detail = await this.detail(orderId);
    } catch (e) {
      if (e instanceof CjError) return await refuse(`cj_reread_${e.code}`);
      throw e;
    }
    if (this.isPaid(detail)) return this.toOrder(detail, orderNumber);
    if ((detail.isSandbox === 1) !== this.isSandbox) return await refuse("cj_sandbox_mismatch");
    if (detail.shippingCountryCode && detail.shippingCountryCode !== "US") return await refuse("cj_order_wrong_country");
    const totalCents = cents(detail.orderAmount);
    if (totalCents === undefined || totalCents <= 0) return await refuse("cj_order_total_unknown");
    if (totalCents > hardCapCents) return await refuse("max_price_exceeded");
    // The order must still carry the prepaid duty. A total that dropped by more than half of the
    // quoted taxes + clearance fee most likely left the duty out (it would be billed at the door).
    const dutyCents = q.taxCents + (q.feeCents ?? 0);
    if (this.requiresDdp && totalCents < q.totalCents - Math.floor(dutyCents / 2)) return await refuse("cj_order_total_excludes_duties");

    // 3. Wallet check (enforced on real orders; sandbox payment is simulated and moves nothing).
    let balanceCents: number | undefined;
    try {
      balanceCents = await this.balanceCents();
    } catch (e) {
      if (e instanceof CjError) return await refuse(`cj_balance_${e.code}`);
      throw e;
    }
    if (!this.isSandbox && balanceCents < totalCents) return await refuse("insufficient_funds");

    // 4. Pay the whole order from the balance. From here on, failures may have moved money.
    const shipmentOrderId = typeof created?.shipmentOrderId === "string" && created.shipmentOrderId ? created.shipmentOrderId : undefined;
    try {
      if (shipmentOrderId) await this.call("POST", "/shopping/pay/payBalanceV2", { shipmentOrderId });
      else await this.call("POST", "/shopping/pay/payBalance", { orderId });
    } catch (e) {
      if (e instanceof CjError && e.code === `cj_${CODE_BALANCE_INSUFFICIENT}`) return await refuse("insufficient_funds");
      if (e instanceof CjError && e.code === `cj_${CODE_BALANCE_RESTRICTED}`) return await refuse("cj_balance_payment_restricted");
      throw e instanceof CjError ? e : new CjError("cj_pay_failed");
    }

    // 5. Confirm it is paid, and at what amount.
    const after = await this.detail(orderId);
    if (!this.isPaid(after)) throw new CjError("cj_pay_unconfirmed");
    const paid = cents(after.orderAmount) ?? totalCents;
    if (paid > hardCapCents) throw new CjError("cj_paid_over_cap");
    return this.toOrder(after, orderNumber, balanceCents);
  }

  /**
   * CREATED / IN_CART / UNPAID / UNSHIPPED (PENDING, PROCESSING) → open; SHIPPED → shipped;
   * DELIVERED → delivered; CANCELLED → cancelled. raw.links = the https trackingUrl.
   */
  async status(vendorOrderId: string) {
    const d = await this.detail(vendorOrderId);
    const tracking = typeof d.trackNumber === "string" && d.trackNumber ? d.trackNumber : undefined;
    const links = typeof d.trackingUrl === "string" && isHttpsUrl(d.trackingUrl) ? [d.trackingUrl] : [];
    return {
      state: mapCjStatus(d.orderStatus),
      tracking,
      raw: { status: d.orderStatus, subStatus: d.subStatus ?? undefined, isSandbox: d.isSandbox, links },
    };
  }

  /** CJ deletes only unconfirmed orders (CREATED / IN_CART). Paid or later → false. */
  async cancel(vendorOrderId: string): Promise<boolean> {
    const d = await this.detailOrUndefined(vendorOrderId);
    if (!d || !DELETABLE_STATUSES.has(String(d.orderStatus))) return false;
    try {
      await this.call("DELETE", `/shopping/order/deleteOrder?${new URLSearchParams({ orderId: String(d.orderId ?? vendorOrderId) })}`);
      return true;
    } catch (e) {
      // CJ answered with an error code (HTTP 200): it refused. Network / HTTP errors propagate.
      if (e instanceof CjError && e.status === undefined && e.code.startsWith("cj_") && e.code !== "cj_network_error") return false;
      throw e;
    }
  }

  /**
   * One charge per paid order (UNSHIPPED, SHIPPED, DELIVERED) from GET /shopping/order/list
   * filtered by paymentDate (UTC, ≤ 90-day windows), amount = orderAmount, keyed by orderId (the
   * same id place() returns). Cancelled orders are refunded and skipped. Only orders matching
   * this adapter's mode (sandbox or real) count. Wallet charges that aren't orders (paid
   * sourcing, CJ Prime) are not listed: keep those off this account.
   */
  async listCharges(sinceISO: string): Promise<Charge[]> {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) throw new CjError("cj_bad_since");
    const end = this.now();
    const out = new Map<string, Charge>();
    const WINDOW = 89 * 24 * 3600_000;
    for (let from = since; from < end; from += WINDOW) {
      const to = Math.min(from + WINDOW, end);
      for (const status of ["UNSHIPPED", "SHIPPED", "DELIVERED"]) {
        const pageSize = 50;
        for (let pageNum = 1; pageNum <= 200; pageNum++) {
          const qs = new URLSearchParams({
            pageNum: String(pageNum),
            pageSize: String(pageSize),
            status,
            paymentDateFrom: cjUtc(from),
            paymentDateTo: cjUtc(to),
          });
          const page = await this.call<{ total?: number; list?: CjOrderDetail[] }>("GET", `/shopping/order/list?${qs}`);
          const list = page?.list ?? [];
          for (const o of list) {
            if (!o.orderId) throw new CjError("cj_order_without_id");
            if ((o.isSandbox === 1) !== this.isSandbox) continue;
            const amount = cents(o.orderAmount);
            if (amount === undefined) throw new CjError("cj_order_without_amount");
            const at = parseCjDate(o.paymentDate);
            if (at === undefined) throw new CjError("cj_order_without_payment_date");
            if (at < since) continue;
            out.set(o.orderId, { vendorChargeId: o.orderId, amountCents: amount, at: new Date(at).toISOString(), vendorOrderId: o.orderId });
          }
          if (list.length < pageSize || pageNum * pageSize >= (page?.total ?? 0)) break;
        }
      }
    }
    return [...out.values()];
  }

  /** Local flag only. The real kill is deleting the API key in My CJ → Authorization → API. */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  /** Spendable wallet cents: amount − frozen (GET /shopping/pay/getBalance). */
  async balanceCents(): Promise<number> {
    const b = await this.call<{ amount?: number | string; freezeAmount?: number | string | null }>("GET", "/shopping/pay/getBalance");
    const amount = cents(b?.amount);
    if (amount === undefined) throw new CjError("cj_balance_unreadable");
    const frozen = cents(b?.freezeAmount) ?? 0;
    return Math.max(0, amount - frozen);
  }

  /**
   * Research errand only (see cjSourcingRequest): ask CJ's staff to find an off-catalog item.
   * Never called by quote() or place().
   */
  async sourcingRequest(url: string, note: string, imageUrl?: string): Promise<{ sourcingId: string }> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!isHttpsUrl(url) || url.length > 200) throw new CjError("cj_sourcing_bad_url");
    const name = note.trim();
    if (!name || name.length > 200) throw new CjError("cj_sourcing_bad_note");
    const image = imageUrl ?? url;
    if (!isHttpsUrl(image) || image.length > 200) throw new CjError("cj_sourcing_bad_image");
    const d = await this.call<{ cjSourcingId?: string }>("POST", "/product/sourcing/create", {
      productName: name,
      productImage: image,
      productUrl: url,
      remark: name,
      acceptSimilar: 0,
    });
    if (!d?.cjSourcingId) throw new CjError("cj_sourcing_malformed");
    return { sourcingId: String(d.cjSourcingId) };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private ownerAddress(): ZincAddress {
    const a = parseOwnerAddress(this.ownerShipTo);
    if (a.country !== "US") throw new GuardRefused("cj_owner_address_not_us");
    return a;
  }

  private isPaid(d: CjOrderDetail): boolean {
    return PAID_STATUSES.has(String(d.orderStatus)) || (typeof d.paymentDate === "string" && d.paymentDate !== "");
  }

  private toOrder(d: CjOrderDetail, orderNumber: string, balanceBeforeCents?: number): Order {
    const amount = cents(d.orderAmount);
    if (!d.orderId || amount === undefined) throw new CjError("cj_malformed_order");
    const links = typeof d.trackingUrl === "string" && isHttpsUrl(d.trackingUrl) ? [d.trackingUrl] : [];
    return {
      vendorOrderId: d.orderId,
      chargedCents: amount,
      raw: {
        status: d.orderStatus,
        orderNumber,
        cjOrderCode: d.cjOrderCode ?? undefined,
        isSandbox: d.isSandbox,
        balanceBeforeCents,
        links,
      },
    };
  }

  private async detail(orderId: string): Promise<CjOrderDetail> {
    const d = await this.call<CjOrderDetail>("GET", `/shopping/order/getOrderDetail?${new URLSearchParams({ orderId })}`);
    if (!d || typeof d !== "object" || !d.orderId) throw new CjError("cj_malformed_order");
    return d;
  }

  /** getOrderDetail, or undefined when CJ answers "order not found" (1600300). */
  private async detailOrUndefined(orderId: string): Promise<CjOrderDetail | undefined> {
    try {
      return await this.detail(orderId);
    } catch (e) {
      if (e instanceof CjError && e.code === "cj_1600300") return undefined;
      throw e;
    }
  }

  private async deleteQuietly(orderId: string): Promise<void> {
    try {
      await this.call("DELETE", `/shopping/order/deleteOrder?${new URLSearchParams({ orderId })}`);
    } catch { /* best effort: an unpaid order costs nothing */ }
  }

  private async pace(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const wait = this.lastCallAt + this.minIntervalMs - this.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = this.now();
  }

  private async rawFetch(method: string, path: string, body: unknown, token?: string): Promise<{ status: number; json?: CjEnvelope }> {
    await this.pace();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers["CJ-Access-Token"] = token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new CjError("cj_network_error"); // may or may not have reached CJ
    }
    const json = await res.json().catch(() => undefined) as CjEnvelope | undefined;
    return { status: res.status, json };
  }

  /** A valid access token: cached, refreshed near expiry, re-minted from the API key otherwise. */
  private async accessToken(force = false): Promise<string> {
    if (!this.apiKey) throw new CjError("cj_api_key_missing");
    const now = this.now();
    if (!force && this.token && this.token.accessExp - TOKEN_SLACK_MS > now) return this.token.access;
    if (!force && this.token?.refresh && this.token.refreshExp - TOKEN_SLACK_MS > now) {
      const r = await this.rawFetch("POST", "/authentication/refreshAccessToken", { refreshToken: this.token.refresh });
      if (isOk(r.status, r.json) && this.storeToken(r.json?.data)) return this.token!.access;
    }
    this.token = undefined;
    const r = await this.rawFetch("POST", "/authentication/getAccessToken", { apiKey: this.apiKey });
    if (!isOk(r.status, r.json) || !this.storeToken(r.json?.data)) {
      throw new CjError(`cj_auth_${typeof r.json?.code === "number" ? r.json.code : r.status}`, r.status === 200 ? undefined : r.status);
    }
    return this.token!.access;
  }

  private storeToken(d: unknown): boolean {
    const t = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
    if (typeof t.accessToken !== "string" || !t.accessToken) return false;
    const exp = (k: string, fallbackDays: number) => {
      const v = typeof t[k] === "string" ? Date.parse(t[k] as string) : NaN;
      return Number.isFinite(v) ? v : this.now() + fallbackDays * 24 * 3600_000;
    };
    this.token = {
      access: t.accessToken,
      accessExp: exp("accessTokenExpiryDate", 1),
      refresh: typeof t.refreshToken === "string" && t.refreshToken ? t.refreshToken : undefined,
      refreshExp: exp("refreshTokenExpiryDate", 1),
    };
    return true;
  }

  /**
   * An authenticated call. Success = HTTP 200 and code 200/0/absent (CJ docs; `message` is never
   * used). A bad-token answer re-mints the token once and retries (the call did not run).
   * Errors become CjError(`cj_<code>`), with `status` set only for non-200 HTTP answers.
   */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token = await this.accessToken();
    let r = await this.rawFetch(method, path, body, token);
    if (!isOk(r.status, r.json) && (CODE_BAD_TOKEN.has(Number(r.json?.code)) || r.status === 401)) {
      token = await this.accessToken(true);
      r = await this.rawFetch(method, path, body, token);
    }
    if (isOk(r.status, r.json)) return r.json?.data as T;
    const code = Number(r.json?.code);
    if (CODE_RATE.has(code)) throw new CjError("rate_limit_exceeded", r.status === 200 ? undefined : r.status);
    if (Number.isSafeInteger(code) && code !== 200) throw new CjError(`cj_${code}`, r.status === 200 ? undefined : r.status);
    throw new CjError(r.status >= 500 ? "cj_server_error" : `cj_http_${r.status}`, r.status);
  }
}

export function mapCjStatus(s: string | undefined): "open" | "shipped" | "delivered" | "cancelled" {
  switch (s) {
    case "SHIPPED":
      return "shipped";
    case "DELIVERED":
      return "delivered";
    case "CANCELLED":
      return "cancelled";
    default:
      return "open"; // CREATED, IN_CART, UNPAID, UNSHIPPED, PENDING, PROCESSING, OTHER
  }
}

/**
 * RESEARCH ERRAND, not a purchase: files a CJ sourcing request so CJ staff look for an
 * off-catalog item (a 1688 / Taobao / AliExpress link). Not wired into the gate: no agent can
 * reach it through /api, and an item it finds is bought later as a normal `cj` request once CJ
 * lists it under a variant id. Returns CJ's sourcing id. `imageUrl` defaults to `url` (CJ requires
 * an image field).
 */
export async function cjSourcingRequest(
  url: string,
  note: string,
  opts: { imageUrl?: string; adapter?: CjAdapter } = {},
): Promise<{ sourcingId: string }> {
  const a = opts.adapter ?? cjFromEnv();
  return await a.sourcingRequest(url, note, opts.imageUrl);
}

/**
 * Build from env: CJ_API_KEY, CJ_ENV (sandbox default | production), CJ_BASE_URL,
 * CJ_FROM_COUNTRY, CJ_LOGISTIC_NAME, CJ_DUTY_RATE, CJ_DUTY_FLAT_CENTS, CJ_MIN_INTERVAL_MS,
 * OWNER_SHIP_TO_JSON.
 */
export function cjFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): CjAdapter {
  const num = (k: string) => {
    const v = env(k);
    return v === undefined || v === "" ? undefined : Number(v);
  };
  return new CjAdapter({
    apiKey: env("CJ_API_KEY"),
    env: env("CJ_ENV"),
    baseUrl: env("CJ_BASE_URL"),
    fromCountry: env("CJ_FROM_COUNTRY"),
    logisticName: env("CJ_LOGISTIC_NAME"),
    ownerShipTo: env("OWNER_SHIP_TO_JSON"),
    dutyRate: num("CJ_DUTY_RATE"),
    dutyFlatCents: num("CJ_DUTY_FLAT_CENTS"),
    minIntervalMs: num("CJ_MIN_INTERVAL_MS"),
  });
}
