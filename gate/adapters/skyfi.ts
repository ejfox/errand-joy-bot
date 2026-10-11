// SkyFi Platform API (https://app.skyfi.com/platform-api) vendor adapter: buys ARCHIVE satellite
// imagery (existing captures from SkyFi's catalog) for an area of interest. Spec:
// https://app.skyfi.com/platform-api/openapi.json (docs: /platform-api/docs, /platform-api/redoc;
// agent flow: https://mcp.skyfi.com/docs).
//
// Facts this adapter is built on (read 2026-10-11):
// - Auth: header `X-Skyfi-Api-Key`. One host; there is no sandbox (`whoami.isDemoAccount` flags
//   demo accounts).
// - POST /order-archive/validate takes the same body as POST /order-archive and returns
//   `{estimatedCostCents, provider, aoiSqkm}` without creating an order or charging: the quote.
//   Validation failures use the order endpoint's codes (402 = not enough budget, 403 = denied,
//   e.g. the Vantor EULA isn't accepted, 404 archive, 422 rejected, 429 order limit).
// - POST /order-archive → 201 with `orderId`, `orderCost` (cents) and `status`. No idempotency key:
//   this adapter writes its key into `orderLabel` + `metadata`, and GET /orders?search= (which
//   matches orderLabel) finds an earlier attempt before ordering again.
// - GET /orders/{id}: `status` (DeliveryStatus) and, once delivered, `downloadImageUrl`,
//   `downloadViewReadyCogUrl`, ... GET /orders lists orders (pageSize ≤ 100, newest first).
// - GET /auth/whoami: `budgetAmount` and `currentBudgetUsage` (cents). Remaining = the difference;
//   place() refuses when it can't cover the order. Billing is a card (`hasValidSharedCard`), so the
//   SkyFi budget, not a prepaid balance, is the vendor-side cap.
// - No cancel endpoint. Tasking (new captures, $200+) is OUT OF SCOPE: this adapter never calls the
//   tasking endpoints and refuses `tasking:` skus. Delivery stays `NONE` (SkyFi-hosted); bucket
//   credentials are never accepted.
//
// Items (the gate's Item has no geometry field and skus are ≤ 128 chars):
//   exactly one `archive:<archiveId>` (qty 1), plus at most one AOI item (qty 1):
//     `aoi:POLYGON((lon lat, ...))`         a simple WKT polygon (only coarse ones fit in 128 chars)
//     `point:<lat>,<lon>,<radiusKm>`        a square of side 2 × radius around the point
//     `bbox:<minLon>,<minLat>,<maxLon>,<maxLat>`
//   With no AOI item the archive's whole footprint is ordered (priced by validate like any other).
import { OWNER_HOME } from "../types.ts";
import type { Charge, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";

export const SKYFI_DEFAULT_BASE_URL = "https://app.skyfi.com/platform-api";
const IDEMPOTENCY_METADATA_KEY = "ejb_idempotency_key";
const TIMEOUT_MS = 30_000;
const MAX_VERTICES = 500; // SkyFi: orders should not have more than 500 vertices
const MAX_RADIUS_KM = 25;
const MAX_BBOX_DEG = 2;

/** A SkyFi failure where money MAY have moved (or we can't tell): the gate records outcome_unknown. */
export class SkyFiError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "SkyFiError";
  }
}

export interface SkyFiAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SkyFiOrderSpec {
  archiveId: string;
  /** WKT polygon, or undefined = the archive's own footprint. */
  aoi?: string;
}

interface SkyFiOrder {
  orderId?: string;
  id?: string;
  orderType?: string;
  orderCost?: number;
  status?: string;
  orderLabel?: string | null;
  orderCode?: string;
  createdAt?: string;
  downloadImageUrl?: string | null;
  downloadPayloadUrl?: string | null;
  downloadCogUrl?: string | null;
  downloadViewReadyCogUrl?: string | null;
  previews?: Record<string, string> | null;
  events?: { status?: string; timestamp?: string; message?: string | null }[];
}

/** Map SkyFi's HTTP errors (`{detail}` bodies) to stable codes. */
export function readSkyFiError(status: number, body: unknown): string {
  const detail = body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string"
    ? (body as { detail: string }).detail
    : "";
  if (status === 401) return "skyfi_unauthorized";
  if (status === 402) return "skyfi_budget_exceeded";
  if (status === 403) return /eula/i.test(detail) ? "skyfi_vantor_eula_required" : "skyfi_forbidden";
  if (status === 404) return "skyfi_not_found";
  if (status === 422) return "skyfi_order_rejected";
  if (status === 429) return "skyfi_order_limit";
  if (status === 503) return "skyfi_ordering_disabled";
  if (status >= 500) return "skyfi_server_error";
  return `skyfi_http_${status}`;
}

/**
 * POST /order-archive answers where the spec says no order was created (validation runs first and
 * "validation failures surface with the same status codes"). These become GuardRefused, so the
 * request is `failed`, not `outcome_unknown`. 5xx other than 503, and network errors, stay SkyFiError.
 */
const DEFINITE_REJECTION_STATUSES = new Set([400, 401, 402, 403, 404, 422, 429, 503]);

const FAILED = new Set(["PAYMENT_FAILED", "PLATFORM_FAILED", "PROVIDER_FAILED", "PROCESSING_FAILED", "DELIVERY_FAILED"]);
const NOT_STARTED = new Set(["CREATED", "STARTED", "PROVIDER_PENDING"]);

function num(s: string): number {
  if (!/^-?\d{1,3}(\.\d{1,12})?$/.test(s)) return NaN;
  return Number(s);
}

const fmt = (n: number) => n.toFixed(6).replace(/\.?0+$/, "");

/** Validate a simple WKT polygon (one closed ring, lon/lat in range, ≤ 500 vertices); normalized. */
export function parseWktPolygon(wkt: string): string {
  const m = /^\s*POLYGON\s*\(\(\s*([^()]+?)\s*\)\)\s*$/i.exec(wkt);
  if (!m) throw new SkyFiError("skyfi_bad_aoi");
  const pts = m[1].split(",").map((p) => p.trim().split(/\s+/));
  if (pts.length < 4 || pts.length > MAX_VERTICES + 1) throw new SkyFiError("skyfi_bad_aoi");
  const coords = pts.map((p) => {
    if (p.length !== 2) throw new SkyFiError("skyfi_bad_aoi");
    const [lon, lat] = [num(p[0]), num(p[1])];
    if (!(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)) throw new SkyFiError("skyfi_bad_aoi");
    return [lon, lat];
  });
  const [f, l] = [coords[0], coords[coords.length - 1]];
  if (f[0] !== l[0] || f[1] !== l[1]) throw new SkyFiError("skyfi_aoi_not_closed");
  return `POLYGON ((${coords.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(", ")}))`;
}

function rect(minLon: number, minLat: number, maxLon: number, maxLat: number): string {
  const r = [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
  return `POLYGON ((${r.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(", ")}))`;
}

/** `point:<lat>,<lon>,<radiusKm>` → a square WKT polygon with half-side radiusKm. */
export function pointToWkt(lat: number, lon: number, radiusKm: number): string {
  if (!(lat >= -85 && lat <= 85 && lon >= -180 && lon <= 180)) throw new SkyFiError("skyfi_bad_point");
  if (!(radiusKm >= 0.05 && radiusKm <= MAX_RADIUS_KM)) throw new SkyFiError("skyfi_bad_radius");
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  if (lon - dLon < -180 || lon + dLon > 180) throw new SkyFiError("skyfi_bad_point");
  return rect(lon - dLon, lat - dLat, lon + dLon, lat + dLat);
}

/** Read the request's items into one archive order. Throws SkyFiError with a clear code. */
export function parseSkyFiItems(req: PurchaseRequest): SkyFiOrderSpec {
  let archiveId: string | undefined;
  let aoi: string | undefined;
  if (!req.items.length || req.items.length > 2) throw new SkyFiError("skyfi_bad_items");
  for (const it of req.items) {
    if (it.qty !== 1) throw new SkyFiError("skyfi_qty_must_be_1");
    const sku = it.sku.trim();
    const [prefix, ...rest] = sku.split(":");
    const value = rest.join(":");
    switch (prefix) {
      case "tasking":
        throw new SkyFiError("skyfi_tasking_refused");
      case "archive":
        if (archiveId !== undefined) throw new SkyFiError("skyfi_one_archive_only");
        if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) throw new SkyFiError("skyfi_bad_archive_id");
        archiveId = value;
        break;
      case "aoi":
      case "point":
      case "bbox": {
        if (aoi !== undefined) throw new SkyFiError("skyfi_one_aoi_only");
        if (prefix === "aoi") aoi = parseWktPolygon(value);
        else {
          const n = value.split(",").map((s) => num(s.trim()));
          if (n.some((x) => !Number.isFinite(x))) throw new SkyFiError(`skyfi_bad_${prefix}`);
          if (prefix === "point") {
            if (n.length !== 3) throw new SkyFiError("skyfi_bad_point");
            aoi = pointToWkt(n[0], n[1], n[2]);
          } else {
            if (n.length !== 4) throw new SkyFiError("skyfi_bad_bbox");
            const [minLon, minLat, maxLon, maxLat] = n;
            const ok = minLon >= -180 && maxLon <= 180 && minLat >= -90 && maxLat <= 90 && minLon < maxLon &&
              minLat < maxLat && maxLon - minLon <= MAX_BBOX_DEG && maxLat - minLat <= MAX_BBOX_DEG;
            if (!ok) throw new SkyFiError("skyfi_bad_bbox");
            aoi = rect(minLon, minLat, maxLon, maxLat);
          }
        }
        break;
      }
      default:
        throw new SkyFiError("skyfi_bad_sku");
    }
  }
  if (archiveId === undefined) throw new SkyFiError("skyfi_archive_required");
  return { archiveId, aoi };
}

/** orderLabel carrying the gate key: `ejb-<key>` if plain and short, else a sha256-derived id. */
export async function skyFiLabel(key: string): Promise<string> {
  if (/^[A-Za-z0-9_-]{1,60}$/.test(key)) return `ejb-${key}`;
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return "ejb-" + [...h.slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function httpsUrl(u: unknown): string | undefined {
  return typeof u === "string" && /^https:\/\/[^\s@]+$/.test(u) && u.length <= 4000 ? u : undefined;
}

/** Download links on an order, best for a human first (view-ready COG, then image, COG, payload). */
export function skyFiLinks(o: SkyFiOrder): string[] {
  return [o.downloadViewReadyCogUrl, o.downloadImageUrl, o.downloadCogUrl, o.downloadPayloadUrl]
    .map(httpsUrl)
    .filter((u): u is string => !!u);
}

export function mapSkyFiStatus(o: SkyFiOrder): "open" | "shipped" | "delivered" | "failed" {
  const s = o.status ?? "";
  if (FAILED.has(s)) return "failed";
  if (s === "DELIVERY_COMPLETED") return skyFiLinks(o).length ? "delivered" : "shipped";
  if (NOT_STARTED.has(s) || !s) return "open";
  return "shipped"; // the provider has it / processing / delivery pending
}

function cents(n: unknown): number | undefined {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export class SkyFiAdapter implements VendorAdapter {
  readonly id = "skyfi";
  /** Imagery of a place: it reaches the world, not a person. */
  readonly maxReach: Reach = "world";
  paused = false;

  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SkyFiAdapterOptions = {}) {
    this.apiKey = opts.apiKey ?? "";
    const base = (opts.baseUrl || SKYFI_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const u = new URL(base);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
      throw new Error("SKYFI_BASE_URL must be https (http only on loopback)");
    }
    this.baseUrl = base;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "world" : "others";
  }

  /** POST /order-archive/validate: the exact price, no order, no charge. */
  async quote(req: PurchaseRequest): Promise<Quote> {
    const spec = parseSkyFiItems(req);
    const aoi = spec.aoi ?? await this.footprint(spec.archiveId);
    const v = await this.validate(spec.archiveId, aoi);
    const archiveItem = req.items.find((i) => i.sku.trim().startsWith("archive:"))!;
    if (archiveItem.maxUnitCents !== undefined && v.estimatedCostCents > archiveItem.maxUnitCents) {
      throw new SkyFiError("skyfi_over_max_unit");
    }
    return {
      subtotalCents: v.estimatedCostCents,
      taxCents: 0,
      shippingCents: 0,
      totalCents: v.estimatedCostCents,
      currency: "USD",
      vendorRef: `skyfi:archive:${spec.archiveId}`,
      quotedAt: new Date().toISOString(),
      raw: { archiveId: spec.archiveId, aoi, provider: v.provider, aoiSqkm: v.aoiSqkm, estimatedCostCents: v.estimatedCostCents },
    };
  }

  /**
   * Looks for an earlier attempt by orderLabel (returned as-is), re-validates (price must equal the
   * quote and fit the hard cap), checks the SkyFi budget, then POST /order-archive.
   * chargedCents = `orderCost`.
   */
  async place(req: PurchaseRequest, q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.apiKey) throw new GuardRefused("skyfi_api_key_missing");
    if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) throw new GuardRefused("skyfi_third_party_unsupported");
    let spec: SkyFiOrderSpec;
    try {
      spec = parseSkyFiItems(req);
    } catch (e) {
      throw new GuardRefused(e instanceof SkyFiError ? e.code : "skyfi_bad_items");
    }
    if (q.vendorRef !== `skyfi:archive:${spec.archiveId}`) throw new GuardRefused("skyfi_quote_mismatch");

    // An earlier attempt first: its order already used budget / an order slot, so re-validating
    // before this lookup would refuse a retry whose money already moved.
    const label = await skyFiLabel(idempotencyKey);
    let earlier: SkyFiOrder | undefined;
    try {
      earlier = await this.findByLabel(label);
    } catch {
      throw new GuardRefused("skyfi_lookup_failed");
    }
    if (earlier) return this.toOrder(earlier);

    // Everything up to POST /order-archive is read-only: any failure means nothing was ordered.
    let aoi: string, estimate: number, remaining: number;
    try {
      aoi = spec.aoi ?? await this.footprint(spec.archiveId);
      estimate = (await this.validate(spec.archiveId, aoi)).estimatedCostCents;
      remaining = (await this.budget()).remainingCents;
    } catch (e) {
      throw new GuardRefused(e instanceof SkyFiError ? e.code : "skyfi_precheck_failed");
    }
    if (estimate > hardCapCents) throw new GuardRefused("max_price_exceeded");
    if (estimate !== q.totalCents) throw new GuardRefused("skyfi_price_changed");
    if (remaining < estimate) throw new GuardRefused("skyfi_budget_insufficient");

    const body = {
      aoi,
      archiveId: spec.archiveId,
      deliveryDriver: "NONE",
      label,
      orderLabel: label,
      metadata: { [IDEMPOTENCY_METADATA_KEY]: label, task_id: req.taskId.slice(0, 200) },
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/order-archive`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SkyFiError("skyfi_network_error"); // may or may not have reached SkyFi
    }
    const json = await res.json().catch(() => undefined);
    if (res.ok) return this.toOrder(json as SkyFiOrder);
    const code = readSkyFiError(res.status, json);
    if (DEFINITE_REJECTION_STATUSES.has(res.status)) throw new GuardRefused(code);
    throw new SkyFiError(code, res.status);
  }

  /**
   * CREATED / STARTED / PROVIDER_PENDING → open; provider and processing stages → shipped;
   * DELIVERY_COMPLETED with a download link → delivered (links in raw for the why-note);
   * any *_FAILED → failed.
   */
  async status(vendorOrderId: string) {
    const o = await this.call("GET", `/orders/${encodeURIComponent(vendorOrderId)}`) as SkyFiOrder;
    const last = (o.events ?? []).at(-1);
    return {
      state: mapSkyFiStatus(o),
      raw: {
        status: o.status,
        orderCode: o.orderCode,
        links: skyFiLinks(o),
        previews: o.previews ?? undefined,
        lastEvent: last?.message ?? undefined,
      },
    };
  }

  /** SkyFi has no cancel endpoint. */
  cancel(_vendorOrderId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * GET /orders (all types, newest first, 100 per page) back to `sinceISO`: one charge per orderId
   * (item costs summed), amount = `orderCost`, matching place(). PAYMENT_FAILED orders were never
   * charged and are skipped. Orders placed by hand in the SkyFi app show up too and trip STOP.
   */
  async listCharges(sinceISO: string): Promise<Charge[]> {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) throw new SkyFiError("skyfi_bad_since");
    const byOrder = new Map<string, Charge>();
    for (let page = 0; page < 100; page++) {
      const qs = new URLSearchParams({ pageNumber: String(page), pageSize: "100", sortColumns: "created_at", sortDirections: "desc" });
      const body = await this.call("GET", `/orders?${qs}`) as { orders?: SkyFiOrder[] };
      const orders = body.orders ?? [];
      let older = false;
      for (const o of orders) {
        const t = Date.parse(o.createdAt ?? "");
        if (!Number.isFinite(t)) throw new SkyFiError("skyfi_order_without_created_at");
        if (t < since) {
          older = true;
          continue;
        }
        if (o.status === "PAYMENT_FAILED") continue;
        const id = o.orderId ?? o.id;
        const cost = cents(o.orderCost);
        if (!id || cost === undefined) throw new SkyFiError("skyfi_malformed_order");
        const prev = byOrder.get(id);
        if (prev) prev.amountCents += cost;
        else byOrder.set(id, { vendorChargeId: id, amountCents: cost, at: new Date(t).toISOString(), vendorOrderId: id });
      }
      if (older || orders.length < 100) break;
    }
    return [...byOrder.values()];
  }

  /** Local flag only. The real kill is deleting the API key in the SkyFi app (or zeroing the budget). */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  /** GET /auth/whoami: the SkyFi budget (cents). remaining = budgetAmount − currentBudgetUsage. */
  async budget(): Promise<
    { budgetCents: number; usedCents: number; remainingCents: number; hasValidSharedCard: boolean; isDemoAccount: boolean }
  > {
    const w = await this.call("GET", "/auth/whoami") as {
      budgetAmount?: number;
      currentBudgetUsage?: number;
      hasValidSharedCard?: boolean;
      isDemoAccount?: boolean;
    };
    const budgetCents = cents(w.budgetAmount);
    const usedCents = cents(w.currentBudgetUsage);
    if (budgetCents === undefined || usedCents === undefined) throw new SkyFiError("skyfi_malformed_whoami");
    return {
      budgetCents,
      usedCents,
      remainingCents: Math.max(0, budgetCents - usedCents),
      hasValidSharedCard: w.hasValidSharedCard === true,
      isDemoAccount: w.isDemoAccount === true,
    };
  }

  private async footprint(archiveId: string): Promise<string> {
    const a = await this.call("GET", `/archives/${encodeURIComponent(archiveId)}`) as { footprint?: unknown };
    if (typeof a?.footprint !== "string") throw new SkyFiError("skyfi_archive_without_footprint");
    return parseWktPolygon(a.footprint);
  }

  private async validate(archiveId: string, aoi: string): Promise<{ estimatedCostCents: number; provider?: string; aoiSqkm?: number }> {
    const v = await this.call("POST", "/order-archive/validate", { aoi, archiveId, deliveryDriver: "NONE" }) as {
      estimatedCostCents?: number;
      provider?: string;
      aoiSqkm?: number;
    };
    const c = cents(v?.estimatedCostCents);
    if (c === undefined) throw new SkyFiError("skyfi_malformed_validation");
    return { estimatedCostCents: c, provider: v.provider, aoiSqkm: v.aoiSqkm };
  }

  private async findByLabel(label: string): Promise<SkyFiOrder | undefined> {
    const qs = new URLSearchParams({ search: label, pageSize: "10" });
    const body = await this.call("GET", `/orders?${qs}`) as { orders?: SkyFiOrder[] };
    const hits = (body.orders ?? []).filter((o) => o.orderLabel === label);
    const ids = new Set(hits.map((o) => o.orderId ?? o.id));
    if (ids.size > 1) throw new SkyFiError("skyfi_duplicate_label");
    return hits[0];
  }

  private toOrder(o: SkyFiOrder): Order {
    const id = o?.orderId ?? o?.id;
    const cost = cents(o?.orderCost);
    if (!o || typeof id !== "string" || !id || cost === undefined) throw new SkyFiError("skyfi_malformed_order");
    return { vendorOrderId: id, chargedCents: cost, raw: { status: o.status, orderCode: o.orderCode, links: skyFiLinks(o) } };
  }

  private headers(json: boolean): HeadersInit {
    const h: Record<string, string> = { "X-Skyfi-Api-Key": this.apiKey, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.apiKey) throw new SkyFiError("skyfi_api_key_missing");
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new SkyFiError(readSkyFiError(res.status, json), res.status);
    return json;
  }
}

/** Build from env: SKYFI_API_KEY, SKYFI_BASE_URL (default https://app.skyfi.com/platform-api). */
export function skyFiFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): SkyFiAdapter {
  return new SkyFiAdapter({ apiKey: env("SKYFI_API_KEY"), baseUrl: env("SKYFI_BASE_URL") });
}
