// Lulu Print API vendor adapter: zines and books printed on demand and mailed. Docs:
// https://api.lulu.com/docs/ (OpenAPI: https://api.lulu.com/api-docs/openapi-specs/openapi_public.yml,
// read 2026-10-11).
//
// Money facts this adapter is built on:
// - No prepaid balance. A Print-Job is charged to the card on file "when the Print-Job is sent to
//   production", i.e. after `production_delay` (60-2880 min). Until then it can be cancelled
//   (PUT /print-jobs/{id}/status/ {"name":"CANCELED"}). The vendor-side cap therefore has to be the
//   card: a merchant-locked virtual card with a monthly limit.
// - POST /print-job-cost-calculations/ prices a job (print + shipping + fulfillment + tax) without
//   creating one. quote() is that call. There is no max_price: place() re-quotes and refuses when
//   the re-quote exceeds the hard cap, and cancels a job whose returned cost exceeds it.
// - No idempotency key. place() sets `external_id` = the (≤36-char) gate key and looks it up
//   (GET /print-jobs/?search=) before creating and after an unclear failure.
// - Sandbox (default): https://api.sandbox.lulu.com, a SEPARATE account at
//   developers.sandbox.lulu.com, paid with test cards, never printed. Production only when
//   LULU_ENV=production.
// - Auth: OAuth2 client credentials. POST {base}/auth/realms/glasstree/protocol/openid-connect/token
//   with Basic base64(client_key:client_secret) → a short-lived bearer token (cached here).
import { OWNER_HOME } from "../types.ts";
import type { Charge, Item, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";
import { checkBaseUrl, dollarsToCents, isHttpsUrl } from "./money.ts";
import { parseOwnerAddress, type ZincAddress, zincIdempotencyKey } from "./zinc.ts";

export const LULU_SANDBOX_BASE_URL = "https://api.sandbox.lulu.com";
export const LULU_PRODUCTION_BASE_URL = "https://api.lulu.com";
export const LULU_TOKEN_PATH = "/auth/realms/glasstree/protocol/openid-connect/token";
export const LULU_SHIPPING_LEVELS = ["MAIL", "PRIORITY_MAIL", "GROUND", "EXPEDITED", "EXPRESS"] as const;
export type LuluShippingLevel = typeof LULU_SHIPPING_LEVELS[number];
export const LULU_DEFAULT_PRODUCTION_DELAY_MIN = 60;
const TIMEOUT_MS = 30_000;
const TOKEN_SKEW_MS = 60_000;

export interface LuluAdapterOptions {
  clientKey?: string;
  clientSecret?: string;
  /** "sandbox" (default) or "production". */
  env?: string;
  /** Tests only (a stub host). Not read from env: the host follows LULU_ENV. */
  baseUrl?: string;
  /** Lulu's `contact_email` for questions about a Print-Job (LULU_CONTACT_EMAIL). Required to place. */
  contactEmail?: string;
  shippingLevel?: string;
  /** Minutes before a job goes to production (and the card is charged): Lulu's own cancel window. */
  productionDelayMinutes?: number;
  /** The owner's address, Zinc shape (OWNER_SHIP_TO_JSON): raw JSON, base64 JSON, or an object. */
  ownerShipTo?: string | ZincAddress;
  fetchImpl?: typeof fetch;
}

/** A Lulu failure where money MAY have moved (or we can't tell): the gate records outcome_unknown. */
export class LuluError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "LuluError";
  }
}

/** Lulu's shipping address object. */
export interface LuluAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state_code: string;
  postcode: string;
  country_code: string;
  phone_number?: string;
}

/** One zine/book line, decoded from a gate Item. */
export interface LuluLine {
  podPackageId: string;
  pageCount: number;
  quantity: number;
  interiorUrl: string;
  coverUrl: string;
  title: string;
}

interface LuluCosts {
  line_item_costs?: { total_cost_excl_tax?: string }[];
  shipping_cost?: { total_cost_excl_tax?: string };
  total_cost_incl_tax?: string;
  total_tax?: string;
  currency?: string;
}

interface LuluJob {
  id?: number | string;
  external_id?: string | null;
  status?: { name?: string; message?: string };
  costs?: LuluCosts | null;
  date_created?: string;
  line_items?: { tracking_id?: string | null; tracking_urls?: string[] | null }[];
}

const POD_PACKAGE_RE = /^[0-9A-Z]{4}X[0-9A-Z]{4}(\.[0-9A-Z]+){5}$|^[0-9A-Z]{27}$/;
const PHONE_RE = /^\+?[\d\s\-.\/()]{8,20}$/;

/**
 * Item fields:
 *   sku            = the pod_package_id. Verified live 2026-10-11: `0550X0850FCPRESS080CW444GXX`
 *                    (5.5x8.5 full-color saddle-stitch zine), `0600X0900BWSTDPB060UW444MXX` (6x9 B&W
 *                    paperback). Many plausible-looking ids return "Pod Package does not exist".
 *   pageCount      = interior pages (2-1200)
 *   files.interior = the interior PDF (https)
 *   files.cover    = the cover PDF (https)
 *   title          = the line-item title (defaults to "Untitled"), qty = copies (1-100)
 * Anything malformed refuses before the network.
 */
export function luluLine(item: Item): LuluLine {
  if (!POD_PACKAGE_RE.test(item.sku)) throw new GuardRefused("lulu_bad_sku");
  const pageCount = item.pageCount;
  if (pageCount === undefined) throw new GuardRefused("lulu_page_count_missing");
  if (!Number.isSafeInteger(pageCount) || pageCount < 2 || pageCount > 1200) throw new GuardRefused("lulu_bad_page_count");
  if (!Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 100) throw new GuardRefused("lulu_bad_qty");
  const interiorUrl = item.files?.interior;
  const coverUrl = item.files?.cover;
  if (!interiorUrl) throw new GuardRefused("lulu_interior_url_missing");
  if (!coverUrl) throw new GuardRefused("lulu_cover_url_missing");
  if (!isHttpsUrl(interiorUrl)) throw new GuardRefused("lulu_interior_url_invalid");
  if (!isHttpsUrl(coverUrl)) throw new GuardRefused("lulu_cover_url_invalid");
  const title = (item.title ?? "").trim().slice(0, 255) || "Untitled";
  return { podPackageId: item.sku, pageCount, quantity: item.qty, interiorUrl, coverUrl, title };
}

function lines(req: PurchaseRequest): LuluLine[] {
  if (!req.items.length) throw new GuardRefused("lulu_no_items");
  if (req.items.length > 10) throw new GuardRefused("lulu_too_many_items");
  return req.items.map(luluLine);
}

function fit(v: string, max: number, code: string): string {
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) throw new GuardRefused(`${code}_missing`);
  if (s.length > max) throw new GuardRefused(`${code}_too_long`); // validate, never truncate an address
  return s;
}

/** The owner's address (self) or the gate's third-party ShipTo (others) in Lulu's shape. */
export function luluAddress(req: PurchaseRequest, ownerShipTo: string | ZincAddress | undefined): LuluAddress {
  if (req.shipTo === undefined || req.shipTo === OWNER_HOME) {
    let a: ZincAddress;
    try {
      a = parseOwnerAddress(ownerShipTo);
    } catch (e) {
      if (e instanceof GuardRefused) throw new GuardRefused(e.code.replace(/^zinc_/, "lulu_"));
      throw e;
    }
    if (!PHONE_RE.test(a.phone_number)) throw new GuardRefused("lulu_owner_phone_invalid");
    return {
      name: fit(`${a.first_name} ${a.last_name}`, 35, "lulu_name"),
      street1: fit(a.address_line1, 30, "lulu_street1"),
      ...(a.address_line2 ? { street2: fit(a.address_line2, 30, "lulu_street2") } : {}),
      city: fit(a.city, 30, "lulu_city"),
      state_code: a.state ?? "",
      postcode: a.postal_code,
      country_code: a.country,
      phone_number: a.phone_number,
    };
  }
  const s = req.shipTo;
  // The cost calculation requires a phone; without one Lulu would print the account's own number.
  if (!s.phone || !PHONE_RE.test(s.phone)) throw new GuardRefused("lulu_shipto_phone_required");
  if (!/^\d{5}(-\d{4})?$/.test(s.zip.trim())) throw new GuardRefused("lulu_shipto_bad_zip");
  if (!/^[A-Za-z]{2}$/.test(s.state.trim())) throw new GuardRefused("lulu_shipto_bad_state");
  return {
    name: fit(s.name, 35, "lulu_name"),
    street1: fit(s.line1, 30, "lulu_street1"),
    city: fit(s.city, 30, "lulu_city"),
    state_code: s.state.trim().toUpperCase(),
    postcode: s.zip.trim(),
    country_code: "US",
    phone_number: s.phone,
  };
}

/**
 * Lulu cost breakdown → gate Quote parts. subtotal = Σ line totals excl. tax, shipping = shipping
 * excl. tax, tax = total_tax, fee = the residual (fulfillment fee etc.; Lulu's `fees[]` list is not
 * summed because not every entry is in the total). Refuses a breakdown that doesn't add up.
 */
export function luluCostParts(c: LuluCosts | null | undefined) {
  const total = dollarsToCents(c?.total_cost_incl_tax);
  const tax = dollarsToCents(c?.total_tax);
  const shipping = dollarsToCents(c?.shipping_cost?.total_cost_excl_tax);
  const linesExcl = (c?.line_item_costs ?? []).map((l) => dollarsToCents(l.total_cost_excl_tax));
  if (total === undefined || tax === undefined || shipping === undefined || !linesExcl.length || linesExcl.some((x) => x === undefined)) {
    return undefined;
  }
  if (c?.currency !== undefined && c.currency !== "USD") throw new LuluError("lulu_currency_not_usd");
  const subtotal = (linesExcl as number[]).reduce((a, b) => a + b, 0);
  const fee = total - subtotal - shipping - tax;
  if (fee < 0) throw new LuluError("lulu_cost_breakdown_inconsistent");
  return { subtotalCents: subtotal, shippingCents: shipping, taxCents: tax, feeCents: fee, totalCents: total };
}

/**
 * Print-Job status → gate status. REJECTED (bad files/data, never paid) → failed; CANCELED →
 * cancelled; ERROR happens after IN_PRODUCTION (money may have moved) → open, so it stays counted.
 */
export function mapLuluStatus(name: string | undefined): "open" | "shipped" | "delivered" | "cancelled" | "failed" {
  switch (name) {
    case "SHIPPED":
      return "shipped";
    case "DELIVERED":
      return "delivered";
    case "CANCELED":
      return "cancelled";
    case "REJECTED":
      return "failed";
    default: // CREATED, UNPAID, PAYMENT_IN_PROGRESS, PRODUCTION_DELAYED, PRODUCTION_READY, IN_PRODUCTION, ERROR
      return "open";
  }
}

const NEVER_CHARGED = new Set(["CANCELED", "REJECTED"]);

export class LuluAdapter implements VendorAdapter {
  readonly id = "lulu";
  /** Lulu ships to any address. */
  readonly maxReach: Reach = "others";
  paused = false;

  private readonly clientKey: string;
  private readonly clientSecret: string;
  readonly baseUrl: string;
  readonly isSandbox: boolean;
  private readonly contactEmail: string;
  readonly shippingLevel: LuluShippingLevel;
  readonly productionDelayMinutes: number;
  private readonly ownerShipTo?: string | ZincAddress;
  private readonly fetchImpl: typeof fetch;
  private token?: { value: string; expiresAt: number };

  constructor(opts: LuluAdapterOptions = {}) {
    this.clientKey = opts.clientKey ?? "";
    this.clientSecret = opts.clientSecret ?? "";
    const env = opts.env || "sandbox";
    if (env !== "sandbox" && env !== "production") throw new Error('LULU_ENV must be "sandbox" or "production"');
    this.isSandbox = env === "sandbox";
    this.baseUrl = checkBaseUrl(opts.baseUrl || (this.isSandbox ? LULU_SANDBOX_BASE_URL : LULU_PRODUCTION_BASE_URL), "lulu baseUrl");
    this.contactEmail = (opts.contactEmail ?? "").trim();
    const level = opts.shippingLevel || "MAIL";
    if (!(LULU_SHIPPING_LEVELS as readonly string[]).includes(level)) throw new Error("LULU_SHIPPING_LEVEL is not a Lulu shipping level");
    this.shippingLevel = level as LuluShippingLevel;
    this.productionDelayMinutes = opts.productionDelayMinutes ?? LULU_DEFAULT_PRODUCTION_DELAY_MIN;
    if (!Number.isSafeInteger(this.productionDelayMinutes) || this.productionDelayMinutes < 60 || this.productionDelayMinutes > 2880) {
      throw new Error("LULU_PRODUCTION_DELAY_MINUTES must be an integer in [60, 2880]");
    }
    this.ownerShipTo = opts.ownerShipTo;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Mailed to the owner's home is "self"; to anyone else, "others" (always asks). */
  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "self" : "others";
  }

  /** POST /print-job-cost-calculations/: print + shipping + fulfillment + tax, no job created. */
  async quote(req: PurchaseRequest): Promise<Quote> {
    const ls = lines(req);
    const parts = await this.costCalc(req, ls);
    return {
      ...parts,
      currency: "USD",
      vendorRef: `lulu:${this.isSandbox ? "sandbox" : "production"}:${this.shippingLevel}`,
      quotedAt: new Date().toISOString(),
      raw: { shippingLevel: this.shippingLevel, lines: ls.map((l) => ({ pod: l.podPackageId, pages: l.pageCount, qty: l.quantity })) },
    };
  }

  /**
   * Re-quotes and refuses over the hard cap BEFORE creating anything; reuses an existing job with
   * the same external_id; creates the Print-Job. An unclear failure (network, 5xx) is resolved by
   * looking the job up by external_id; if it can't be found it stays a LuluError (outcome_unknown).
   * chargedCents = the job's own costs.total_cost_incl_tax when Lulu returns it, else the re-quote.
   * A job whose returned cost exceeds the cap is cancelled (it is still inside production_delay).
   */
  async place(req: PurchaseRequest, _q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.clientKey || !this.clientSecret) throw new GuardRefused("lulu_credentials_missing");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.contactEmail)) throw new GuardRefused("lulu_contact_email_missing");
    const ls = lines(req);
    const address = luluAddress(req, this.ownerShipTo);
    let requote: number;
    try {
      requote = (await this.costCalc(req, ls)).totalCents;
    } catch (e) {
      if (e instanceof GuardRefused) throw e;
      throw new GuardRefused(`lulu_requote_failed:${e instanceof LuluError ? e.code : "error"}`);
    }
    if (requote > hardCapCents) throw new GuardRefused("max_price_exceeded");
    const key = await zincIdempotencyKey(idempotencyKey);

    let existing: LuluJob | undefined;
    try {
      existing = await this.findByExternalId(key);
    } catch {
      throw new GuardRefused("lulu_lookup_failed"); // nothing created yet
    }
    if (existing) return this.toOrder(existing, requote, hardCapCents);

    const body = {
      contact_email: this.contactEmail,
      external_id: key,
      line_items: ls.map((l, i) => ({
        external_id: `${key}-${i + 1}`,
        printable_normalization: {
          cover: { source_url: l.coverUrl },
          interior: { source_url: l.interiorUrl },
          pod_package_id: l.podPackageId,
        },
        quantity: l.quantity,
        title: l.title,
      })),
      production_delay: this.productionDelayMinutes,
      shipping_address: address,
      shipping_level: this.shippingLevel,
    };

    let status = 0;
    let json: unknown;
    try {
      ({ status, json } = await this.send("POST", "/print-jobs/", body));
    } catch (e) {
      if (e instanceof GuardRefused) throw e; // token refused: nothing was sent
      status = -1; // network: may or may not have reached Lulu
    }
    if (status === 200 || status === 201) return this.toOrder(json as LuluJob, requote, hardCapCents);
    // Lulu answers bad input with 400 + field errors and creates no job; auth errors create nothing.
    if (status === 400 || status === 401 || status === 403) throw new GuardRefused(`lulu_rejected_${status}`);
    const found = await this.findByExternalId(key).catch(() => undefined);
    if (found) return this.toOrder(found, requote, hardCapCents);
    throw new LuluError(status === -1 ? "lulu_network_error" : status >= 500 ? "lulu_server_error" : `lulu_http_${status}`, status);
  }

  async status(vendorOrderId: string) {
    const job = await this.json("GET", `/print-jobs/${this.jobId(vendorOrderId)}/`) as LuluJob;
    const li = (job.line_items ?? []).find((l) => l.tracking_id || (l.tracking_urls ?? []).length);
    return {
      state: mapLuluStatus(job.status?.name),
      tracking: li?.tracking_id || li?.tracking_urls?.[0] || undefined,
      // Tracking pages for the delivery why-note (the gate keeps https ones only).
      raw: {
        status: job.status?.name,
        links: (job.line_items ?? []).flatMap((l) => l.tracking_urls ?? []).filter((u) => typeof u === "string"),
      },
    };
  }

  /** PUT /print-jobs/{id}/status/ {"name":"CANCELED"}: only before production. A 400 (invalid transition) → false. */
  async cancel(vendorOrderId: string): Promise<boolean> {
    const { status, json } = await this.send("PUT", `/print-jobs/${this.jobId(vendorOrderId)}/status/`, { name: "CANCELED" });
    if (status === 200) return (json as { name?: string } | undefined)?.name === "CANCELED";
    if (status === 400 || status === 404 || status === 409) return false;
    throw new LuluError(status >= 500 ? "lulu_server_error" : `lulu_http_${status}`, status);
  }

  /**
   * GET /print-jobs/?created_after=…&exclude_line_items=true, every page. One charge per job that is
   * not CANCELED or REJECTED (never charged), amount = costs.total_cost_incl_tax. Jobs whose cost
   * Lulu hasn't computed yet are skipped until it has (the card isn't charged before that either).
   */
  async listCharges(sinceISO: string): Promise<Charge[]> {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) throw new LuluError("lulu_bad_since");
    const out: Charge[] = [];
    for (let page = 1; page <= 200; page++) {
      const qs = new URLSearchParams({
        // Lulu documents second precision with a Z; no milliseconds.
        created_after: new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z"),
        exclude_line_items: "true",
        page: String(page),
        page_size: "100",
      });
      const body = await this.json("GET", `/print-jobs/?${qs}`) as { results?: LuluJob[]; next?: string | null };
      for (const j of body.results ?? []) {
        if (NEVER_CHARGED.has(j.status?.name ?? "")) continue;
        const amount = dollarsToCents(j.costs?.total_cost_incl_tax);
        if (amount === undefined) continue;
        const t = Date.parse(j.date_created ?? "");
        if (!Number.isFinite(t)) throw new LuluError("lulu_job_without_date");
        if (t < since) continue;
        const id = String(j.id ?? "");
        if (!id) throw new LuluError("lulu_job_without_id");
        out.push({ vendorChargeId: id, amountCents: amount, at: new Date(t).toISOString(), vendorOrderId: id });
      }
      if (!body.next) break;
    }
    return out;
  }

  /** Local flag only. The real kills: pause the Privacy card, then regenerate the client secret. */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  private async costCalc(req: PurchaseRequest, ls: LuluLine[]) {
    const body = {
      line_items: ls.map((l) => ({ page_count: l.pageCount, pod_package_id: l.podPackageId, quantity: l.quantity })),
      shipping_address: luluAddress(req, this.ownerShipTo),
      shipping_option: this.shippingLevel,
    };
    const c = await this.json("POST", "/print-job-cost-calculations/", body) as LuluCosts;
    const parts = luluCostParts(c);
    if (!parts) throw new LuluError("lulu_quote_malformed");
    return parts;
  }

  private async toOrder(job: LuluJob, requote: number, hardCapCents: number): Promise<Order> {
    const id = typeof job?.id === "number" || typeof job?.id === "string" ? String(job.id) : "";
    if (!/^\d{1,18}$/.test(id)) throw new LuluError("lulu_malformed_job");
    const charged = dollarsToCents(job.costs?.total_cost_incl_tax) ?? requote;
    if (charged > hardCapCents) {
      // Still inside production_delay, so the card hasn't been charged: cancel, then fail loudly.
      const cancelled = await this.cancel(id).catch(() => false);
      throw new LuluError(cancelled ? "lulu_cost_over_cap_cancelled" : "lulu_cost_over_cap");
    }
    return { vendorOrderId: id, chargedCents: charged, raw: { status: job.status?.name } };
  }

  private async findByExternalId(key: string): Promise<LuluJob | undefined> {
    const qs = new URLSearchParams({ search: key, exclude_line_items: "true", page_size: "10" });
    const body = await this.json("GET", `/print-jobs/?${qs}`) as { results?: LuluJob[] };
    const hits = (body.results ?? []).filter((j) => j.external_id === key);
    if (hits.length > 1) throw new LuluError("lulu_duplicate_external_id");
    return hits[0];
  }

  private jobId(vendorOrderId: string): string {
    if (!/^\d{1,18}$/.test(vendorOrderId)) throw new LuluError("lulu_bad_order_id");
    return vendorOrderId;
  }

  /** A cached client-credentials token. A refused token is GuardRefused: nothing else was sent. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.clientKey || !this.clientSecret) throw new GuardRefused("lulu_credentials_missing");
    const res = await this.fetchImpl(`${this.baseUrl}${LULU_TOKEN_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${this.clientKey}:${this.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = await res.json().catch(() => undefined) as { access_token?: string; expires_in?: number } | undefined;
    if (!res.ok || typeof j?.access_token !== "string" || !j.access_token) {
      if (res.status >= 400 && res.status < 500) throw new GuardRefused("lulu_auth_failed");
      throw new LuluError("lulu_token_unavailable", res.status);
    }
    const ttl = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in * 1000 : 300_000;
    this.token = { value: j.access_token, expiresAt: Date.now() + Math.max(ttl - TOKEN_SKEW_MS, 10_000) };
    return j.access_token;
  }

  private async send(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) this.token = undefined;
    return { status: res.status, json: await res.json().catch(() => undefined) };
  }

  /** A call that must answer 2xx. Lulu's error bodies are never echoed (they can hold addresses). */
  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const { status, json } = await this.send(method, path, body);
    if (status < 200 || status >= 300) {
      throw new LuluError(
        status === 401 ? "lulu_unauthorized" : status === 404 ? "lulu_not_found" : status >= 500 ? "lulu_server_error" : `lulu_http_${status}`,
        status,
      );
    }
    return json;
  }
}

/**
 * Build from env: LULU_CLIENT_KEY, LULU_CLIENT_SECRET, LULU_ENV (sandbox | production; default
 * sandbox), LULU_CONTACT_EMAIL, LULU_SHIPPING_LEVEL (default MAIL), LULU_PRODUCTION_DELAY_MINUTES
 * (default 60), OWNER_SHIP_TO_JSON.
 */
export function luluFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): LuluAdapter {
  const delay = env("LULU_PRODUCTION_DELAY_MINUTES");
  return new LuluAdapter({
    clientKey: env("LULU_CLIENT_KEY"),
    clientSecret: env("LULU_CLIENT_SECRET"),
    env: env("LULU_ENV"),
    contactEmail: env("LULU_CONTACT_EMAIL"),
    shippingLevel: env("LULU_SHIPPING_LEVEL"),
    productionDelayMinutes: delay ? Number(delay) : undefined,
    ownerShipTo: env("OWNER_SHIP_TO_JSON"),
  });
}
