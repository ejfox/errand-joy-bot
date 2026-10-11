// Slant 3D (https://slant3dapi.com) vendor adapter: on-demand FDM 3D printing (PLA / PETG / OPM),
// US print farm. Spec: https://slant3dapi.com/v2/api/openapi.json ("This spec is for automated
// tools and AI Agents"). Docs: https://slant3dapi.com/documentation/introduction.
//
// Facts this adapter is built on (read 2026-10-11, docs and spec only):
// - Server https://slant3dapi.com/v2/api, `Authorization: Bearer sl-…`. 100 req/min, max 3 keys.
// - Files: POST /files/direct-upload {name, platformId} → presigned S3 PUT (1h) → POST
//   /files/confirm-upload {filePlaceholder} → File.publicFileServiceId. Max 500 uploads/day/platform.
//   The spec's File.type enum is "stl" only; the docs prose also lists "3mf" and "obj".
// - POST /files/{id}/estimate prices one file (print cost only, no shipping). No side effects.
// - POST /orders creates a DRAFT ("will not charge your account"; needs a payment method on the
//   account and a platformId). Draft totals = printingCost + deliveryCost (decimal strings).
// - POST /orders/{id} "Process a draft order to begin production and charge payment". Billed to
//   the account's own card unless customer.publicPaymentServiceId is given ("will default to your
//   card if not provided"). No max_price and no idempotency key: the cap is enforced here by
//   re-reading the draft before processing it.
// - DELETE /orders/{id} cancels AND refunds ("if already shipped … will only refund").
// - No sales-tax field appears anywhere in the spec or the examples: UNVERIFIED whether any is added.
//
// Every quote creates a fresh draft (free; orphan drafts are never charged and listCharges skips
// them). The gate re-quotes right before placing and passes THAT quote to place(), so place()
// processes the newest draft after checking it still costs exactly what was approved.
import { OWNER_HOME } from "../types.ts";
import type { Charge, Item, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";
import { parseOwnerAddress, type ZincAddress } from "./zinc.ts";

export const SLANT3D_DEFAULT_BASE_URL = "https://slant3dapi.com/v2/api";
/** Material profiles the public API exposes (GET /filaments `profile` enum). */
export const SLANT3D_PROFILES = ["PLA", "PETG", "OPM"] as const;
export const SLANT3D_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const SLANT3D_MAX_ITEMS = 10;
const TIMEOUT_MS = 30_000;
const OWNER_ID = "errand-joy-bot";

/** Statuses where the order was processed and paid (it counts as a charge). */
const CHARGED_STATUSES = new Set([
  "PAID",
  "QUEUED",
  "PRINTING",
  "ITEMS_ON_SHELF",
  "POST_PROCESSING",
  "COMPLETED",
  "IN_REVIEW",
  "AWAITING_SHIPMENT",
  "SHIPPED",
  "DELIVERED",
]);

/** Slant's Address schema (name, line1, line2, city, state, zip, country). */
export interface Slant3dAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface Slant3dAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Platform id from the Slant account page. Required for uploads and orders. */
  platformId?: string;
  /** Email on the order's customer details (shipping notices go here). */
  customerEmail?: string;
  /** The owner's address in the Zinc shape (OWNER_SHIP_TO_JSON, raw or base64 JSON). */
  ownerShipTo?: string | ZincAddress;
  /** Local design files must live under this directory (default `$DATA_DIR/designs`). */
  designsDir?: string;
  maxFileBytes?: number;
  fetchImpl?: typeof fetch;
}

/** A Slant 3D failure where money MAY have moved, or a quote-time failure. */
export class Slant3dError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "Slant3dError";
  }
}

/** "PLA:black" → { profile: "PLA", color: "black" }. Color may contain spaces ("matte black"). */
export function parseSlantSku(sku: string): { profile: string; color: string } {
  const m = /^\s*([A-Za-z]+)\s*:\s*([A-Za-z][A-Za-z ]{0,38}[A-Za-z]|[A-Za-z])\s*$/.exec(sku);
  if (!m) throw new Slant3dError("slant3d_bad_sku");
  const profile = m[1].toUpperCase();
  if (!(SLANT3D_PROFILES as readonly string[]).includes(profile)) throw new Slant3dError("slant3d_bad_profile");
  return { profile, color: m[2].toLowerCase().replace(/\s+/g, " ") };
}

/**
 * Exact USD → cents. Slant sends money as decimal strings ("35.53"); parse them without floats.
 * Numbers (the draft's `totals`) are rounded. Anything else → undefined.
 */
export function usdToCents(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : undefined;
  if (typeof v !== "string") return undefined;
  const m = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(v);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** Cheap shape check of a design file. Full validation is tools/design/validate_stl.ts. */
export function sniffDesign(bytes: Uint8Array, ext: "stl" | "3mf"): void {
  if (bytes.length === 0) throw new Slant3dError("slant3d_empty_file");
  if (ext === "3mf") {
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
      throw new Slant3dError("slant3d_bad_3mf");
    }
    return;
  }
  if (bytes.length >= 84) {
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (n > 0 && 84 + 50 * n === bytes.length) return; // binary STL
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).trimStart().toLowerCase();
  if (head.startsWith("solid") && /\bfacet\b/.test(head) && /\bvertex\b/.test(head)) return; // ASCII STL
  throw new Slant3dError("slant3d_bad_stl");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface SlantOrder {
  publicId?: string;
  status?: string;
  paymentId?: string | null;
  processedAt?: string | null;
  createdAt?: string;
  printingCost?: string;
  deliveryCost?: string;
  fulfillment?: Record<string, unknown> | null;
  items?: SlantOrderItem[];
}

interface SlantOrderItem {
  type?: string;
  quantity?: number;
  price?: string;
  publicFileServiceId?: string;
  filamentId?: string;
}

interface SlantFilament {
  publicId: string;
  profile: string;
  color: string;
  available?: boolean;
}

interface Envelope {
  success?: boolean;
  message?: string;
  data?: unknown;
  count?: number;
  pagination?: { totalPages?: number };
}

/** Docs and spec disagree on whether order responses wrap in `data.order`; accept both. */
function orderOf(env: Envelope | undefined): SlantOrder {
  const d = (env?.data && typeof env.data === "object") ? env.data as Record<string, unknown> : {};
  const o = (d.order && typeof d.order === "object") ? d.order as SlantOrder : d as SlantOrder;
  if (!o.items && Array.isArray(d.items)) o.items = d.items as SlantOrderItem[];
  return o;
}

/** printingCost + deliveryCost in cents, or undefined if either is missing or malformed. */
export function orderTotalCents(o: SlantOrder): { printing: number; delivery: number; total: number } | undefined {
  const printing = usdToCents(o.printingCost);
  const delivery = usdToCents(o.deliveryCost);
  if (printing === undefined || delivery === undefined) return undefined;
  return { printing, delivery, total: printing + delivery };
}

export function mapSlantStatus(status: string | undefined): "open" | "shipped" | "delivered" | "cancelled" | "failed" {
  switch (status) {
    case "SHIPPED":
      return "shipped";
    case "DELIVERED":
      return "delivered";
    case "CANCELED":
      return "cancelled";
    case "PAYMENT_ERROR":
      return "failed";
    default:
      return "open"; // DRAFT, PAID, QUEUED, PRINTING, … AWAITING_SHIPMENT, and anything new
  }
}

interface QuotedItem {
  fileId: string;
  filamentId: string;
  qty: number;
  sha256: string;
}

export class Slant3dAdapter implements VendorAdapter {
  readonly id = "slant3d";
  /** Can ship to any address, so the honest worst case is "others". */
  readonly maxReach: Reach = "others";
  paused = false;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly platformId: string;
  private readonly customerEmail: string;
  private readonly ownerShipTo?: string | ZincAddress;
  readonly designsDir: string;
  readonly maxFileBytes: number;
  private readonly fetchImpl: typeof fetch;
  /** sha256 of a design → publicFileServiceId, so a re-quote doesn't upload the same file again. */
  private readonly uploaded = new Map<string, string>();

  constructor(opts: Slant3dAdapterOptions = {}) {
    this.apiKey = opts.apiKey ?? "";
    const base = (opts.baseUrl || SLANT3D_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const u = new URL(base);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
      throw new Error("SLANT3D_BASE_URL must be https (http only on loopback)");
    }
    this.baseUrl = base;
    this.platformId = opts.platformId ?? "";
    this.customerEmail = opts.customerEmail ?? "";
    this.ownerShipTo = opts.ownerShipTo;
    this.designsDir = (opts.designsDir || "./data/designs").replace(/\/+$/, "");
    this.maxFileBytes = opts.maxFileBytes ?? SLANT3D_MAX_FILE_BYTES;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "self" : "others";
  }

  /**
   * Upload (or reuse) each item's design, resolve its filament from the sku ("PLA:black"), then
   * draft ONE order (no charge) to learn the exact print + shipping cost. vendorRef = draft id.
   */
  async quote(req: PurchaseRequest): Promise<Quote> {
    if (!req.items.length) throw new Slant3dError("slant3d_no_items");
    if (req.items.length > SLANT3D_MAX_ITEMS) throw new Slant3dError("slant3d_too_many_items");
    this.requireSetup();
    const address = this.addressFor(req);
    const filaments = await this.filaments();
    const quoted: QuotedItem[] = [];
    for (const it of req.items) {
      if (!Number.isSafeInteger(it.qty) || it.qty < 1 || it.qty > 100) throw new Slant3dError("slant3d_bad_qty");
      const filamentId = pickFilament(filaments, it.sku);
      const { fileId, sha256 } = await this.ensureFile(it);
      quoted.push({ fileId, filamentId, qty: it.qty, sha256 });
    }
    const body = {
      platformId: this.platformId,
      customer: { platformId: this.platformId, details: { email: this.customerEmail, address } },
      items: quoted.map((q) => ({
        type: "PRINT",
        publicFileServiceId: q.fileId,
        filamentId: q.filamentId,
        quantity: q.qty,
      })),
    };
    const order = orderOf(await this.call("POST", "/orders", body) as Envelope);
    if (typeof order.publicId !== "string" || !order.publicId) throw new Slant3dError("slant3d_malformed_draft");
    if (order.status !== undefined && order.status !== "DRAFT") throw new Slant3dError("slant3d_draft_not_draft");
    const t = orderTotalCents(order);
    if (!t) throw new Slant3dError("slant3d_draft_without_costs");
    // maxUnitCents: the item `price` is read as a per-unit price (the stricter reading).
    for (const [i, it] of req.items.entries()) {
      if (it.maxUnitCents === undefined) continue;
      const line = (order.items ?? []).find((x) => x.publicFileServiceId === quoted[i].fileId);
      const unit = usdToCents(line?.price);
      if (unit === undefined || unit > it.maxUnitCents) throw new Slant3dError("slant3d_over_max_unit");
    }
    return {
      subtotalCents: t.printing,
      taxCents: 0,
      shippingCents: t.delivery,
      totalCents: t.total,
      currency: "USD",
      vendorRef: order.publicId,
      quotedAt: new Date().toISOString(),
      raw: { draftId: order.publicId, items: quoted },
    };
  }

  /**
   * Process the draft named by the quote. Before the money call it re-reads the draft and refuses
   * (GuardRefused: nothing charged) unless it is still a DRAFT, costs exactly the quoted total, is
   * within the hard cap and holds exactly the quoted files. A draft that is already processed is
   * returned as-is (a retry of our own earlier call; each draft comes from one quote).
   */
  async place(_req: PurchaseRequest, q: Quote, hardCapCents: number, _idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.apiKey) throw new GuardRefused("slant3d_api_key_missing");
    const draftId = q.vendorRef;
    if (typeof draftId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(draftId)) {
      throw new GuardRefused("slant3d_quote_without_draft");
    }
    if (q.totalCents > hardCapCents) throw new GuardRefused("max_price_exceeded");
    // The address travels on the draft; place() never needs it (a stale env must not trip STOP).

    let draft: SlantOrder;
    try {
      draft = orderOf(await this.call("GET", `/orders/${encodeURIComponent(draftId)}`) as Envelope);
    } catch {
      throw new GuardRefused("slant3d_draft_unreadable"); // a read only; nothing was charged
    }
    const t = orderTotalCents(draft);
    if (draft.status !== "DRAFT") {
      if (draft.status && CHARGED_STATUSES.has(draft.status) && t) return this.toOrder(draftId, draft, hardCapCents);
      throw new GuardRefused(`slant3d_draft_${(draft.status ?? "unknown").toLowerCase()}`);
    }
    if (!t) throw new GuardRefused("slant3d_draft_without_costs");
    if (t.total !== q.totalCents) throw new GuardRefused("slant3d_draft_changed");
    if (t.total > hardCapCents) throw new GuardRefused("max_price_exceeded");
    const want = ((q.raw as { items?: QuotedItem[] } | undefined)?.items ?? [])
      .map((x) => `${x.fileId}|${x.filamentId}|${x.qty}`).sort().join(",");
    const have = (draft.items ?? []).filter((x) => x.type === undefined || x.type === "PRINT")
      .map((x) => `${x.publicFileServiceId}|${x.filamentId}|${x.quantity ?? 1}`).sort().join(",");
    if (!want || want !== have) throw new GuardRefused("slant3d_draft_items_mismatch");

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/orders/${encodeURIComponent(draftId)}`, {
        method: "POST",
        headers: this.headers(false),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Slant3dError("slant3d_network_error"); // may or may not have reached Slant
    }
    const json = await res.json().catch(() => undefined) as Envelope | undefined;
    if (res.ok) {
      const o = orderOf(json);
      // The process response may omit costs; fall back to a fresh read, then to the draft.
      if (orderTotalCents(o)) return this.toOrder(draftId, o, hardCapCents);
      try {
        const again = orderOf(await this.call("GET", `/orders/${encodeURIComponent(draftId)}`) as Envelope);
        if (orderTotalCents(again)) return this.toOrder(draftId, again, hardCapCents);
      } catch { /* use the draft's figures */ }
      return this.toOrder(draftId, draft, hardCapCents);
    }
    if (res.status >= 400 && res.status < 500) {
      // A 4xx with the order still a DRAFT means nothing was charged.
      try {
        const after = orderOf(await this.call("GET", `/orders/${encodeURIComponent(draftId)}`) as Envelope);
        if (after.status === "DRAFT") throw new GuardRefused(`slant3d_process_http_${res.status}`);
      } catch (e) {
        if (e instanceof GuardRefused) throw e;
      }
    }
    throw new Slant3dError(`slant3d_process_http_${res.status}`, res.status);
  }

  async status(vendorOrderId: string) {
    const o = orderOf(await this.call("GET", `/orders/${encodeURIComponent(vendorOrderId)}`) as Envelope);
    const f = o.fulfillment ?? {};
    const tr = f.tracking_number ?? f.trackingNumber ?? (f.shipment as Record<string, unknown> | undefined)?.trackingNumber;
    return {
      state: mapSlantStatus(o.status),
      tracking: typeof tr === "string" && tr ? tr : undefined,
      raw: { status: o.status },
    };
  }

  /** DELETE cancels and refunds (before production; after shipping it only refunds). 4xx → false. */
  async cancel(vendorOrderId: string): Promise<boolean> {
    if (!this.apiKey) throw new Slant3dError("slant3d_api_key_missing");
    const res = await this.fetchImpl(`${this.baseUrl}/orders/${encodeURIComponent(vendorOrderId)}`, {
      method: "DELETE",
      headers: this.headers(false),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => undefined) as Envelope | undefined;
    if (res.ok) return json?.success !== false;
    if (res.status >= 400 && res.status < 500) return false;
    throw new Slant3dError(`slant3d_http_${res.status}`, res.status);
  }

  /**
   * Every processed, non-refunded order on the ACCOUNT (all platforms, so a hand-placed order
   * shows up as a phantom): amount = printingCost + deliveryCost, at = processedAt. `startDate`
   * is a date filter on the vendor side, so it starts a week early and filters here.
   */
  async listCharges(sinceISO: string): Promise<Charge[]> {
    const since = Date.parse(sinceISO);
    if (!Number.isFinite(since)) throw new Slant3dError("slant3d_bad_since");
    const startDate = new Date(since - 7 * 86_400_000).toISOString().slice(0, 10);
    const out: Charge[] = [];
    const limit = 100;
    for (let page = 1; page <= 500; page++) {
      const qs = new URLSearchParams({ startDate, page: String(page), limit: String(limit) });
      const env = await this.call("GET", `/orders?${qs}`) as Envelope;
      const d = env?.data as unknown;
      const orders: SlantOrder[] = Array.isArray(d)
        ? d
        : (d && typeof d === "object" && Array.isArray((d as { orders?: unknown }).orders))
        ? (d as { orders: SlantOrder[] }).orders
        : [];
      for (const o of orders) {
        if (!o.status || !CHARGED_STATUSES.has(o.status)) continue; // DRAFT, CANCELED, PAYMENT_ERROR
        const t = orderTotalCents(o);
        if (!t) throw new Slant3dError("slant3d_order_without_costs");
        const at = Date.parse(o.processedAt ?? o.createdAt ?? "");
        if (!Number.isFinite(at)) throw new Slant3dError("slant3d_order_without_date");
        if (at < since || typeof o.publicId !== "string") continue;
        out.push({
          vendorChargeId: o.paymentId || o.publicId,
          amountCents: t.total,
          at: new Date(at).toISOString(),
          vendorOrderId: o.publicId,
        });
      }
      const pages = env?.pagination?.totalPages;
      if (orders.length < limit || (pages !== undefined && page >= pages)) break;
    }
    return out;
  }

  /** Local flag only. The real kill: revoke the key on the Slant account page, pause the card. */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  /** GET /files/{id}/estimate: print cost for one file (no shipping, no side effects). */
  async estimate(fileId: string, filamentId?: string, quantity = 1): Promise<{ totalCents: number; raw: unknown }> {
    const options: Record<string, unknown> = { quantity };
    if (filamentId) options.filamentId = filamentId;
    const env = await this.call("POST", `/files/${encodeURIComponent(fileId)}/estimate`, { options }) as Envelope;
    const d = (env?.data ?? {}) as Record<string, unknown>;
    const total = usdToCents(d.total);
    if (total === undefined) throw new Slant3dError("slant3d_malformed_estimate");
    return { totalCents: total, raw: d };
  }

  /** The upload half of quote(), exposed for the live test. Returns the publicFileServiceId. */
  async ensureFile(it: Pick<Item, "url">): Promise<{ fileId: string; sha256: string }> {
    const { bytes, name, ext } = await this.loadDesign(it.url);
    sniffDesign(bytes, ext);
    const sha256 = await sha256Hex(bytes);
    const cached = this.uploaded.get(sha256);
    if (cached) return { fileId: cached, sha256 };

    const init: Record<string, unknown> = { name, platformId: this.platformId, ownerId: OWNER_ID };
    if (ext !== "stl") init.type = ext; // docs prose; the spec's File.type enum lists only "stl"
    const up = await this.call("POST", "/files/direct-upload", init) as Envelope;
    const d = (up?.data ?? {}) as { presignedUrl?: unknown; filePlaceholder?: unknown };
    if (typeof d.presignedUrl !== "string" || !d.filePlaceholder || typeof d.filePlaceholder !== "object") {
      throw new Slant3dError("slant3d_malformed_upload_url");
    }
    const target = new URL(d.presignedUrl);
    if (target.protocol !== "https:") throw new Slant3dError("slant3d_upload_url_not_https");
    // The presigned URL carries its own auth. Never send the API key to the storage host.
    const put = await this.fetchImpl(target.href, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as BodyInit,
      signal: AbortSignal.timeout(TIMEOUT_MS * 4),
    });
    await put.body?.cancel();
    if (!put.ok) throw new Slant3dError(`slant3d_upload_http_${put.status}`, put.status);
    const conf = await this.call("POST", "/files/confirm-upload", { filePlaceholder: d.filePlaceholder }) as Envelope;
    const file = (conf?.data ?? {}) as { publicFileServiceId?: unknown };
    if (typeof file.publicFileServiceId !== "string" || !file.publicFileServiceId) {
      throw new Slant3dError("slant3d_malformed_file");
    }
    this.uploaded.set(sha256, file.publicFileServiceId);
    return { fileId: file.publicFileServiceId, sha256 };
  }

  /** GET /filaments (also a cheap key check). */
  async filaments(): Promise<SlantFilament[]> {
    const env = await this.call("GET", "/filaments") as Envelope;
    if (!Array.isArray(env?.data)) throw new Slant3dError("slant3d_malformed_filaments");
    return env.data as SlantFilament[];
  }

  /** Item.url → bytes: an https URL the gate fetches, or a file under designsDir. */
  private async loadDesign(url: string | undefined): Promise<{ bytes: Uint8Array; name: string; ext: "stl" | "3mf" }> {
    if (!url) throw new Slant3dError("slant3d_item_url_missing");
    const extOf = (p: string): "stl" | "3mf" => {
      const m = /\.(stl|3mf)$/i.exec(p);
      if (!m) throw new Slant3dError("slant3d_unsupported_file_type");
      return m[1].toLowerCase() as "stl" | "3mf";
    };
    const nameOf = (p: string) => {
      const base = decodeURIComponent(p.split("/").pop() ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
      return base || "design.stl";
    };

    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new Slant3dError("slant3d_item_url_invalid");
      }
      if (u.protocol !== "https:" || u.username || u.password) throw new Slant3dError("slant3d_item_url_invalid");
      const ext = extOf(u.pathname);
      const res = await this.fetchImpl(u.href, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Slant3dError(`slant3d_design_fetch_http_${res.status}`, res.status);
      }
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > this.maxFileBytes) {
        await res.body?.cancel();
        throw new Slant3dError("slant3d_file_too_large");
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > this.maxFileBytes) throw new Slant3dError("slant3d_file_too_large");
      return { bytes, name: nameOf(u.pathname), ext };
    }

    // Local path: absolute, or relative to designsDir; must resolve INSIDE designsDir.
    const ext = extOf(url);
    let root: string;
    let real: string;
    try {
      root = await Deno.realPath(this.designsDir);
      real = await Deno.realPath(url.startsWith("/") ? url : `${this.designsDir}/${url}`);
    } catch {
      throw new Slant3dError("slant3d_design_not_found");
    }
    if (!real.startsWith(root + "/")) throw new Slant3dError("slant3d_design_outside_designs_dir");
    const st = await Deno.stat(real);
    if (!st.isFile) throw new Slant3dError("slant3d_design_not_found");
    if (st.size > this.maxFileBytes) throw new Slant3dError("slant3d_file_too_large");
    return { bytes: await Deno.readFile(real), name: nameOf(real), ext };
  }

  private requireSetup(): void {
    if (!this.apiKey) throw new Slant3dError("slant3d_api_key_missing");
    if (!this.platformId) throw new Slant3dError("slant3d_platform_id_missing");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.customerEmail)) throw new Slant3dError("slant3d_customer_email_missing");
  }

  /** owner-home → OWNER_SHIP_TO_JSON; a third-party ShipTo maps 1:1 onto Slant's Address (US). */
  private addressFor(req: PurchaseRequest): Slant3dAddress {
    const s = req.shipTo;
    if (s === undefined || s === OWNER_HOME) {
      let a: ZincAddress;
      try {
        a = parseOwnerAddress(this.ownerShipTo);
      } catch (e) {
        throw new Slant3dError(e instanceof GuardRefused ? e.code.replace(/^zinc_/, "slant3d_") : "slant3d_owner_address_invalid");
      }
      return {
        name: `${a.first_name} ${a.last_name}`.trim(),
        line1: a.address_line1,
        ...(a.address_line2 ? { line2: a.address_line2 } : {}),
        city: a.city,
        state: a.state ?? "",
        zip: a.postal_code,
        country: a.country,
      };
    }
    if (typeof s !== "object") throw new Slant3dError("slant3d_bad_shipto");
    const t = (v: unknown) => typeof v === "string" ? v.trim() : "";
    const out = { name: t(s.name), line1: t(s.line1), city: t(s.city), state: t(s.state).toUpperCase(), zip: t(s.zip), country: "US" };
    if (!out.name || !out.line1 || !out.city) throw new Slant3dError("slant3d_bad_shipto");
    if (!/^[A-Z]{2}$/.test(out.state) || !/^\d{5}(-\d{4})?$/.test(out.zip)) throw new Slant3dError("slant3d_bad_shipto");
    return out;
  }

  private toOrder(draftId: string, o: SlantOrder, hardCapCents: number): Order {
    const t = orderTotalCents(o);
    if (!t) throw new Slant3dError("slant3d_malformed_order");
    // Money moved above the cap: not a GuardRefused. outcome_unknown + STOP, a human looks.
    if (t.total > hardCapCents) throw new Slant3dError("slant3d_charged_over_cap");
    return { vendorOrderId: o.publicId || draftId, chargedCents: t.total, raw: { status: o.status, paymentId: o.paymentId } };
  }

  private headers(json: boolean): HeadersInit {
    const h: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.apiKey) throw new Slant3dError("slant3d_api_key_missing");
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => undefined) as Envelope | undefined;
    if (!res.ok || json?.success === false) {
      throw new Slant3dError(res.ok ? "slant3d_unsuccessful" : `slant3d_http_${res.status}`, res.status);
    }
    return json;
  }
}

/**
 * sku "PLA:black" → filament publicId. Exact color match first ("black" never silently becomes
 * "matte black"), then a unique partial match. Unavailable filaments are skipped.
 */
export function pickFilament(filaments: SlantFilament[], sku: string): string {
  const { profile, color } = parseSlantSku(sku);
  const usable = filaments.filter((f) => f.profile?.toUpperCase() === profile && f.available !== false);
  const exact = usable.filter((f) => f.color?.toLowerCase() === color);
  if (exact.length >= 1) return exact[0].publicId;
  const partial = usable.filter((f) => f.color?.toLowerCase().includes(color));
  if (partial.length === 1) return partial[0].publicId;
  throw new Slant3dError(partial.length ? "slant3d_filament_ambiguous" : "slant3d_filament_not_found");
}

/**
 * Build from env: SLANT3D_API_KEY, SLANT3D_BASE_URL, SLANT3D_PLATFORM_ID, SLANT3D_CUSTOMER_EMAIL,
 * OWNER_SHIP_TO_JSON (shared with zinc), DATA_DIR (designs live in $DATA_DIR/designs).
 */
export function slant3dFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): Slant3dAdapter {
  return new Slant3dAdapter({
    apiKey: env("SLANT3D_API_KEY"),
    baseUrl: env("SLANT3D_BASE_URL"),
    platformId: env("SLANT3D_PLATFORM_ID"),
    customerEmail: env("SLANT3D_CUSTOMER_EMAIL"),
    ownerShipTo: env("OWNER_SHIP_TO_JSON"),
    designsDir: `${(env("DATA_DIR") || "./data").replace(/\/+$/, "")}/designs`,
  });
}
