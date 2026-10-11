// Tree-Nation (https://tree-nation.com) vendor adapter: plant N trees of one species from the
// account's prepaid planting credit. Docs: https://docs.tree-nation.com/llms-full.txt, spec:
// https://docs.tree-nation.com/openapi.json, flow + sandbox host:
// https://docs.tree-nation.com/tree-nation-api-gifting-trees-integration-guide.md
//
// Facts this adapter is built on (read 2026-10-11):
// - Live host https://tree-nation.com; test host https://youcannevertestenough.tree-nation.com
//   (the integration guide's sandbox, with its own test token). This adapter DEFAULTS TO THE TEST
//   HOST: going live means setting TREENATION_BASE_URL=https://tree-nation.com explicitly.
// - Species and project endpoints are public (no token). Prices are EUR per tree (`price`), and only
//   species with `stock > 0` can be planted.
// - POST /api/plant {species_id, quantity, order_id, recipients?} plants from the prepaid credit.
//   HTTP 200 even for business errors: branch on `status` (ok | error | processing) and `errorCode`.
//   `order_id` is the idempotency key (a repeat → errorCode `already_processed`).
//   The guide's example response carries `trees[{collect_url, certificate_url}]`; the OpenAPI
//   PlantResponse lists only `payment_id`, so the URLs are parsed when present, never required.
// - There is NO order-status, payments-list, cancel or balance endpoint. Planting is immediate, so
//   status() reports `delivered`; listCharges() can't see anything (reconcile is blind here: the
//   prepaid credit is the cap). POST /api/credit (buy credit) exists; this adapter never calls it.
// - `recipients[].email` makes Tree-Nation email a certificate to that person. The gate's
//   PurchaseRequest has no recipient field yet, so this adapter never sends `recipients`: the API
//   user is the sole recipient, nobody else is contacted, and reach is "world".
import { OWNER_HOME } from "../types.ts";
import type { Charge, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";

export const TREENATION_LIVE_BASE_URL = "https://tree-nation.com";
export const TREENATION_SANDBOX_BASE_URL = "https://youcannevertestenough.tree-nation.com";
/** Conservative EUR→USD rate for quotes (Quote is USD-only). Over-counting is the safe direction. */
export const TREENATION_DEFAULT_EUR_USD = 1.25;
export const TREENATION_MAX_TREES = 1000;
const TIMEOUT_MS = 20_000;

/** A Tree-Nation failure where trees MAY have been planted (or we can't tell): outcome_unknown. */
export class TreeNationError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "TreeNationError";
  }
}

/** POST /api/plant errorCodes the spec documents as validation failures: nothing was planted. */
const DEFINITE_REJECTIONS = new Set(["recipients", "tree_template", "quantity", "species", "planter"]);

export interface TreeNationAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** USD per EUR used to convert the EUR species price into the gate's USD quote. */
  eurUsdRate?: number;
  fetchImpl?: typeof fetch;
}

interface TnSpecies {
  id?: number;
  name?: string;
  project_id?: number;
  price?: number;
  stock?: number;
}

interface TnTree {
  id?: number;
  collect_url?: string;
  certificate_url?: string;
}

interface TnPlantResponse {
  status?: string;
  payment_id?: number | string;
  trees?: TnTree[];
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** `species:<id>` or `project:<id>` (the cheapest in-stock species of that project). */
export function parseTreeSku(sku: string): { kind: "species" | "project"; id: number } {
  const m = /^(species|project):([1-9]\d{0,9})$/.exec(sku);
  if (!m) throw new TreeNationError("treenation_bad_sku");
  return { kind: m[1] as "species" | "project", id: Number(m[2]) };
}

/** Tree-Nation's order_id: the gate key if it is short and plain, else a sha256-derived hex id. */
export async function treeNationOrderId(key: string): Promise<string> {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(key)) return key;
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return "ejb-" + [...h.slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** EUR price per tree (a JSON number such as 0.3) → whole euro-cents. */
function eurCents(price: unknown): number | undefined {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 10_000) return undefined;
  return Math.round(price * 100);
}

function httpsUrl(u: unknown): string | undefined {
  return typeof u === "string" && /^https:\/\/[^\s@]+$/.test(u) && u.length <= 2000 ? u : undefined;
}

export class TreeNationAdapter implements VendorAdapter {
  readonly id = "treenation";
  /** Trees are planted in the world; no person is contacted (no recipients are ever sent). */
  readonly maxReach: Reach = "world";
  paused = false;

  private readonly apiKey: string;
  readonly baseUrl: string;
  readonly eurUsdRate: number;
  private readonly fetchImpl: typeof fetch;
  /** Links from place() in this process, so status().raw can repeat them for the why-note. */
  private readonly links = new Map<string, string[]>();

  constructor(opts: TreeNationAdapterOptions = {}) {
    this.apiKey = opts.apiKey ?? "";
    const base = (opts.baseUrl || TREENATION_SANDBOX_BASE_URL).replace(/\/+$/, "");
    const u = new URL(base);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
      throw new Error("TREENATION_BASE_URL must be https (http only on loopback)");
    }
    this.baseUrl = base;
    this.eurUsdRate = opts.eurUsdRate ?? TREENATION_DEFAULT_EUR_USD;
    if (!(Number.isFinite(this.eurUsdRate) && this.eurUsdRate >= 0.5 && this.eurUsdRate <= 3)) {
      throw new Error("TREENATION_EUR_USD_RATE must be between 0.5 and 3");
    }
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** True unless the base URL is the live host. */
  get isSandbox(): boolean {
    return new URL(this.baseUrl).hostname !== "tree-nation.com";
  }

  reachFor(req: PurchaseRequest): Reach {
    // A third-party shipTo would mean planting "for" someone: others (place() refuses it anyway).
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "world" : "others";
  }

  /**
   * One item, `species:<id>` or `project:<id>`, qty = trees. Price from the public species
   * endpoints (EUR) × qty, converted at eurUsdRate and rounded UP to whole US cents. No tax,
   * shipping or fee. The species actually quoted is pinned in vendorRef for place().
   */
  async quote(req: PurchaseRequest): Promise<Quote> {
    const { sku, qty } = this.oneItem(req);
    const ref = parseTreeSku(sku);
    const species = ref.kind === "species"
      ? await this.species(ref.id)
      : await this.cheapestInProject(ref.id, qty);
    const unitEurCents = eurCents(species.price);
    if (unitEurCents === undefined) throw new TreeNationError("treenation_species_without_price");
    if (!(typeof species.stock === "number" && species.stock >= qty)) throw new TreeNationError("treenation_out_of_stock");
    if (req.items[0].maxUnitCents !== undefined && this.usd(unitEurCents) > req.items[0].maxUnitCents) {
      throw new TreeNationError("treenation_over_max_unit");
    }
    const subtotalEurCents = unitEurCents * qty;
    const totalCents = this.usd(subtotalEurCents);
    return {
      subtotalCents: totalCents,
      taxCents: 0,
      shippingCents: 0,
      totalCents,
      currency: "USD",
      vendorRef: `treenation:species:${species.id}`,
      quotedAt: new Date().toISOString(),
      raw: {
        speciesId: species.id,
        speciesName: species.name,
        projectId: species.project_id,
        unitEurCents,
        subtotalEurCents,
        eurUsdRate: this.eurUsdRate,
        sandbox: this.isSandbox,
      },
    };
  }

  /**
   * Re-reads the pinned species, refuses if its EUR price × qty now converts above the quote or
   * the hard cap, then POST /api/plant {species_id, quantity, order_id, language}. No recipients,
   * no message (the certificate page is public). chargedCents = the quoted USD total.
   */
  async place(req: PurchaseRequest, q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (!this.apiKey) throw new GuardRefused("treenation_api_key_missing");
    if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) {
      // Planting "for" a named person needs a recipient field the gate doesn't have yet.
      throw new GuardRefused("treenation_recipient_unsupported");
    }
    let sku: string, qty: number, ref: ReturnType<typeof parseTreeSku>;
    try {
      ({ sku, qty } = this.oneItem(req));
      ref = parseTreeSku(sku);
    } catch (e) {
      throw new GuardRefused(e instanceof TreeNationError ? e.code : "treenation_bad_request");
    }
    const pinned = /^treenation:species:([1-9]\d{0,9})$/.exec(q.vendorRef ?? "");
    if (!pinned) throw new GuardRefused("treenation_quote_without_species");
    const speciesId = Number(pinned[1]);
    if (ref.kind === "species" && ref.id !== speciesId) throw new GuardRefused("treenation_species_mismatch");

    let species: TnSpecies;
    try {
      species = await this.species(speciesId);
    } catch {
      throw new GuardRefused("treenation_species_unavailable"); // nothing was planted yet
    }
    if (ref.kind === "project" && species.project_id !== ref.id) throw new GuardRefused("treenation_species_mismatch");
    const unit = eurCents(species.price);
    if (unit === undefined) throw new GuardRefused("treenation_species_without_price");
    if (!(typeof species.stock === "number" && species.stock >= qty)) throw new GuardRefused("treenation_out_of_stock");
    const nowCents = this.usd(unit * qty);
    if (nowCents > q.totalCents) throw new GuardRefused("treenation_price_changed");
    if (nowCents > hardCapCents) throw new GuardRefused("max_price_exceeded");

    const orderId = await treeNationOrderId(idempotencyKey);
    const body = { species_id: speciesId, quantity: qty, order_id: orderId, language: "en" };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/plant`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new TreeNationError("treenation_network_error"); // may or may not have planted
    }
    const json = await res.json().catch(() => undefined) as TnPlantResponse | undefined;
    if (res.status === 401 || res.status === 403) throw new GuardRefused(`treenation_http_${res.status}`);
    if (!res.ok) throw new TreeNationError(res.status >= 500 ? "treenation_server_error" : `treenation_http_${res.status}`, res.status);
    if (!json || typeof json !== "object") throw new TreeNationError("treenation_malformed_response");

    if (json.status === "error") {
      const code = typeof json.errorCode === "string" ? json.errorCode : "unknown";
      // already_processed: an earlier attempt planted, and there is no endpoint to look it up.
      // Unknown codes (e.g. out of credit, not in the spec's enum) can't be proven harmless either.
      if (DEFINITE_REJECTIONS.has(code)) throw new GuardRefused(`treenation_${code}`);
      throw new TreeNationError(`treenation_${code}`);
    }
    if (json.status !== "ok" && json.status !== "processing") throw new TreeNationError("treenation_malformed_response");
    const paymentId = typeof json.payment_id === "number" || typeof json.payment_id === "string"
      ? String(json.payment_id)
      : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(paymentId)) throw new TreeNationError("treenation_malformed_order");

    const trees = Array.isArray(json.trees) ? json.trees : [];
    const certificateUrls = trees.map((t) => httpsUrl(t?.certificate_url)).filter((u): u is string => !!u);
    const collectUrls = trees.map((t) => httpsUrl(t?.collect_url)).filter((u): u is string => !!u);
    const links = [...certificateUrls, ...collectUrls];
    this.links.set(paymentId, links);
    return {
      vendorOrderId: paymentId,
      chargedCents: q.totalCents,
      raw: {
        status: json.status,
        orderId,
        speciesId,
        trees: qty,
        certificateUrls,
        collectUrls,
        /** For the delivery why-note: certificate pages first, then collect links. */
        links,
      },
    };
  }

  /** No status endpoint exists: a payment_id means the trees were planted (planted = delivered). */
  status(vendorOrderId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(vendorOrderId)) {
      return Promise.reject(new TreeNationError("treenation_bad_order_id"));
    }
    const links = this.links.get(vendorOrderId) ?? [];
    return Promise.resolve({ state: "delivered" as const, raw: { paymentId: vendorOrderId, links } });
  }

  /** Planting can't be undone and there is no cancel endpoint. */
  cancel(_vendorOrderId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Tree-Nation exposes no payment history, so this is always empty and reconcile cannot catch a
   * planting the gate didn't make. The vendor-side cap is the prepaid credit (auto-recharge OFF).
   */
  listCharges(_sinceISO: string): Promise<Charge[]> {
    return Promise.resolve([]);
  }

  /** Local flag only. The real kill is revoking the token (ask Tree-Nation) or emptying the credit. */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  /** GET /api/authcheck: is the token valid and the account active? No side effects. For ops. */
  async authCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    const res = await this.fetchImpl(`${this.baseUrl}/api/authcheck`, {
      headers: this.headers(false),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => undefined) as { status?: string } | undefined;
    return res.ok && json?.status === "ok";
  }

  private usd(eurCentsAmount: number): number {
    return Math.ceil(eurCentsAmount * this.eurUsdRate);
  }

  private oneItem(req: PurchaseRequest): { sku: string; qty: number } {
    if (req.items.length !== 1) throw new TreeNationError("treenation_one_item_only");
    const { sku, qty } = req.items[0];
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > TREENATION_MAX_TREES) throw new TreeNationError("treenation_bad_qty");
    return { sku, qty };
  }

  private async species(id: number): Promise<TnSpecies> {
    const s = await this.get(`/api/species/${id}`) as TnSpecies;
    if (!s || typeof s !== "object" || s.id !== id) throw new TreeNationError("treenation_malformed_species");
    return s;
  }

  private async cheapestInProject(projectId: number, qty: number): Promise<TnSpecies> {
    const body = await this.get(`/api/projects/${projectId}/species`);
    const list = (Array.isArray(body) ? body : (body as { result?: unknown })?.result) as TnSpecies[] | undefined;
    if (!Array.isArray(list)) throw new TreeNationError("treenation_malformed_species");
    const ok = list.filter((s) =>
      typeof s?.id === "number" && eurCents(s.price) !== undefined && typeof s.stock === "number" && s.stock >= qty
    );
    if (!ok.length) throw new TreeNationError("treenation_out_of_stock");
    return ok.reduce((a, b) => (eurCents(a.price)! <= eurCents(b.price)! ? a : b));
  }

  private headers(json: boolean): HeadersInit {
    const h: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  /** Public catalog GETs: no token is sent (the species and project endpoints don't need one). */
  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => undefined);
    if (res.status === 404) throw new TreeNationError("treenation_not_found", 404);
    if (!res.ok) throw new TreeNationError(`treenation_http_${res.status}`, res.status);
    return json;
  }
}

/** Build from env: TREENATION_API_KEY, TREENATION_BASE_URL (default: sandbox), TREENATION_EUR_USD_RATE. */
export function treeNationFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): TreeNationAdapter {
  const rate = env("TREENATION_EUR_USD_RATE");
  return new TreeNationAdapter({
    apiKey: env("TREENATION_API_KEY"),
    baseUrl: env("TREENATION_BASE_URL"),
    eurUsdRate: rate ? Number(rate) : undefined,
  });
}
