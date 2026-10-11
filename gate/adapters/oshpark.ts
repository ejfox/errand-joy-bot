// OSH Park (https://oshpark.com) PCB adapter: a HANDOFF adapter. No money moves through the gate.
//
// OSH Park has no quote or order API. What it documents (https://docs.oshpark.com/tips+tricks/api/,
// read 2026-10-11) is an anonymous upload: `POST https://oshpark.com/import.json` with a multipart
// `file` field answers `{"token": "<id>", "url": "https://oshpark.com/uploads/<id>"}`. The docs say
// the upload cannot return previews or warnings, nor add the project to an account. So:
//
// - quote()  computes the price locally from the published table (https://docs.oshpark.com/services/,
//            verified 2026-10-11): $/sq in of the outline's bounding box, per set of 3 boards, free
//            shipping. The board size comes from the Gerber zip (oshpark_gerber.ts).
// - place()  DOES NOT SPEND MONEY. It uploads the zip and returns an Order with chargedCents = 0,
//            vendorOrderId = the upload token, raw.links = [the uploads URL], raw.handoff = true and
//            raw.blocked = "handoff" (the gate's one "order needs you" DM). THE OWNER does the
//            checkout on oshpark.com with their own card: review the render, pick the address, pay.
// - status() "open" until the owner drops a marker file: `$DATA_DIR/oshpark/<token>.delivered` or
//            `<token>.cancelled` (the adapter has no database, and OSH Park has no order API).
// - listCharges() is always []: the card charge happens at OSH Park, outside the gate. Count it in
//            the ledger with POST /internal/import-order if it should use budget.
//
// The upload reaches OSH Park, so place() still needs DRY_RUN=0 (this adapter is not `simulated`).
import { OWNER_HOME } from "../types.ts";
import type { Charge, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";
// Used only inside functions (registry.ts imports this module), so the import cycle is safe.
import { GuardRefused } from "./registry.ts";
import { type BoardSize, boardSizeFromZip, GerberError } from "./oshpark_gerber.ts";

export const OSHPARK_DEFAULT_BASE_URL = "https://oshpark.com";
export const OSHPARK_PRICING_URL = "https://docs.oshpark.com/services/";
export const OSHPARK_PRICING_VERIFIED = "2026-10-11";
/** Boards come in sets of this many. */
export const OSHPARK_SET_SIZE = 3;
/** Most boards one request may ask for (10 sets). Bigger runs are Medium Run, not handled here. */
export const OSHPARK_MAX_BOARDS = 30;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
/** The vendor-side block code the gate turns into ONE "order needs you" DM. */
export const OSHPARK_HANDOFF_CODE = "handoff";

export interface OshParkService {
  layers: 2 | 4 | 6;
  /** Price in cents per square inch, per set of 3 boards. */
  centsPerSqInPerSet: number;
  label: string;
  leadTime: string;
}

/**
 * The per-sq-in services from docs.oshpark.com/services (verified 2026-10-11). Item `sku` picks one.
 * Not offered: Flex ("temporarily suspended") and Medium Run (100 sq in minimum, a different model).
 */
export const OSHPARK_SERVICES: Readonly<Record<string, OshParkService>> = {
  "2layer": { layers: 2, centsPerSqInPerSet: 500, label: "2-layer prototype, 1.6mm 1oz", leadTime: "9-12 calendar days" },
  "2layer-swift": { layers: 2, centsPerSqInPerSet: 1000, label: "2-layer Super Swift", leadTime: "4-5 business days" },
  "2layer-2oz": { layers: 2, centsPerSqInPerSet: 500, label: "2-layer 2oz 0.8mm", leadTime: "12-21 calendar days" },
  "2layer-afterdark": { layers: 2, centsPerSqInPerSet: 500, label: "2-layer After Dark", leadTime: "12-21 calendar days" },
  "4layer": { layers: 4, centsPerSqInPerSet: 1000, label: "4-layer prototype", leadTime: "9-14 calendar days" },
  "4layer-swift": { layers: 4, centsPerSqInPerSet: 2000, label: "4-layer Super Swift", leadTime: "5-6 business days" },
  "6layer": { layers: 6, centsPerSqInPerSet: 1500, label: "6-layer prototype", leadTime: "12-21 calendar days" },
};

/**
 * The published formula: rate × bounding-box area (sq in) × sets, sets = ceil(boards / 3),
 * rounded ONCE to the cent for the whole order. Pure; this is what the tiers see.
 */
export function oshParkPriceCents(areaSqIn: number, service: string, boards: number): { cents: number; sets: number } {
  if (!Object.hasOwn(OSHPARK_SERVICES, service)) throw new GuardRefused("oshpark_unknown_service");
  if (!(Number.isFinite(areaSqIn) && areaSqIn > 0)) throw new GuardRefused("oshpark_bad_area");
  if (!Number.isSafeInteger(boards) || boards < 1 || boards > OSHPARK_MAX_BOARDS) throw new GuardRefused("oshpark_bad_qty");
  const sets = Math.ceil(boards / OSHPARK_SET_SIZE);
  return { cents: Math.round(OSHPARK_SERVICES[service].centsPerSqInPerSet * areaSqIn * sets), sets };
}

export interface OshParkAdapterOptions {
  baseUrl?: string;
  /** Gerber zips must live under this directory (default `$DATA_DIR/designs`, shared with slant3d). */
  designsDir?: string;
  /** Owner-written status markers (default `$DATA_DIR/oshpark`). */
  stateDir?: string;
  fetchImpl?: typeof fetch;
}

/** A quote-time failure (bad file, unreadable outline). */
export class OshParkError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OshParkError";
  }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
  return [...h].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class OshParkAdapter implements VendorAdapter {
  readonly id = "oshpark";
  /** place() refuses any shipTo but owner-home, and the owner types the address at checkout. */
  readonly maxReach: Reach = "self";
  paused = false;

  private readonly baseUrl: string;
  readonly designsDir: string;
  readonly stateDir: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OshParkAdapterOptions = {}) {
    const base = (opts.baseUrl || OSHPARK_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const u = new URL(base);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
      throw new Error("OSHPARK_BASE_URL must be https (http only on loopback)");
    }
    this.baseUrl = base;
    this.designsDir = (opts.designsDir || "./data/designs").replace(/\/+$/, "");
    this.stateDir = (opts.stateDir || "./data/oshpark").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  reachFor(req: PurchaseRequest): Reach {
    return req.shipTo === undefined || req.shipTo === OWNER_HOME ? "self" : "others";
  }

  /**
   * One item: `sku` = a key of OSHPARK_SERVICES, `qty` = boards (rounded up to whole sets of 3),
   * `url` = the Gerber zip (path under designsDir). No network. vendorRef binds the zip's sha256,
   * so place() uploads exactly the file that was priced.
   */
  async quote(req: PurchaseRequest): Promise<Quote> {
    if (req.items.length !== 1) throw new OshParkError("oshpark_one_board_per_request");
    const it = req.items[0];
    if (!Object.hasOwn(OSHPARK_SERVICES, it.sku)) throw new OshParkError("oshpark_unknown_service");
    const { bytes, name } = await this.loadZip(it.url);
    const size = await this.sizeOf(bytes);
    const { cents, sets } = oshParkPriceCents(size.areaSqIn, it.sku, it.qty);
    const svc = OSHPARK_SERVICES[it.sku];
    return {
      subtotalCents: cents,
      taxCents: 0, // OSH Park's checkout is authoritative and may add sales tax; the gate never sees it
      shippingCents: 0, // free shipping, worldwide (docs)
      totalCents: cents,
      currency: "USD",
      vendorRef: `oshpark:${it.sku}:${await sha256Hex(bytes)}`,
      quotedAt: new Date().toISOString(),
      raw: {
        handoff: true,
        file: name,
        service: it.sku,
        serviceLabel: svc.label,
        leadTime: svc.leadTime,
        outlineFile: size.outlineFile,
        widthMm: size.widthMm,
        heightMm: size.heightMm,
        areaSqIn: Math.round(size.areaSqIn * 10_000) / 10_000,
        sets,
        boards: sets * OSHPARK_SET_SIZE,
        centsPerSqInPerSet: svc.centsPerSqInPerSet,
        pricing: `${OSHPARK_PRICING_URL} (verified ${OSHPARK_PRICING_VERIFIED})`,
      },
    };
  }

  /**
   * Uploads the zip (anonymous, documented) and hands the order to the owner. Spends nothing:
   * chargedCents = 0. Every refusal is a GuardRefused, since no path here can move money.
   */
  async place(req: PurchaseRequest, q: Quote, hardCapCents: number, _idempotencyKey: string): Promise<Order> {
    if (this.paused) throw new GuardRefused("vendor_paused");
    if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) {
      // The owner types the address at OSH Park's checkout; a third-party order is not a handoff.
      throw new GuardRefused("oshpark_third_party_shipto_unsupported");
    }
    if (q.totalCents > hardCapCents) throw new GuardRefused("max_price_exceeded");
    if (req.items.length !== 1) throw new GuardRefused("oshpark_one_board_per_request");
    const it = req.items[0];
    let file: { bytes: Uint8Array; name: string };
    try {
      file = await this.loadZip(it.url);
    } catch (e) {
      throw new GuardRefused(e instanceof OshParkError ? e.code : "oshpark_file_unreadable");
    }
    if (q.vendorRef !== `oshpark:${it.sku}:${await sha256Hex(file.bytes)}`) throw new GuardRefused("oshpark_file_changed");

    const form = new FormData();
    form.append("file", new Blob([file.bytes as BlobPart], { type: "application/zip" }), file.name);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/import.json`, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GuardRefused("oshpark_upload_network_error"); // at worst an orphan upload; nothing billed
    }
    const json = await res.json().catch(() => undefined) as { token?: unknown } | undefined;
    if (!res.ok) throw new GuardRefused(`oshpark_upload_http_${res.status}`);
    const token = json?.token;
    if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new GuardRefused("oshpark_upload_malformed");
    // The link is always rebuilt from the token (docs: url = https://oshpark.com/uploads/<token>),
    // never copied from the response, so a vendor payload can't put an arbitrary URL in a DM.
    return { vendorOrderId: token, chargedCents: 0, raw: this.handoffRaw(token, { service: it.sku }) };
  }

  /**
   * open (still waiting on the owner, with the handoff link) until the owner writes a marker:
   * `<stateDir>/<token>.delivered` → delivered, `<token>.cancelled` → cancelled.
   */
  async status(vendorOrderId: string) {
    if (!TOKEN_RE.test(vendorOrderId)) throw new OshParkError("oshpark_bad_order_id");
    const has = async (suffix: string) => {
      try {
        return (await Deno.stat(`${this.stateDir}/${vendorOrderId}.${suffix}`)).isFile;
      } catch {
        return false;
      }
    };
    if (await has("cancelled")) return { state: "cancelled" as const, raw: { handoff: true } };
    if (await has("delivered")) {
      return { state: "delivered" as const, raw: { handoff: true, links: [this.uploadUrl(vendorOrderId)] } };
    }
    return { state: "open" as const, raw: this.handoffRaw(vendorOrderId) };
  }

  /** Nothing to cancel at OSH Park: an upload that nobody checks out is never made or billed. */
  cancel(_vendorOrderId: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** Always []: no money moves through the gate. The owner's card charge happens at OSH Park. */
  listCharges(_sinceISO: string): Promise<Charge[]> {
    return Promise.resolve([]);
  }

  /** Local flag only. There is no key to revoke: uploads are anonymous and spend nothing. */
  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  uploadUrl(token: string): string {
    return `${this.baseUrl}/uploads/${encodeURIComponent(token)}`;
  }

  private handoffRaw(token: string, extra: Record<string, unknown> = {}) {
    return { handoff: true, blocked: OSHPARK_HANDOFF_CODE, links: [this.uploadUrl(token)], ...extra };
  }

  private async sizeOf(bytes: Uint8Array): Promise<BoardSize> {
    try {
      return await boardSizeFromZip(bytes);
    } catch (e) {
      if (e instanceof GerberError) throw new OshParkError(`oshpark_${e.code}`);
      throw new OshParkError("oshpark_gerber_unreadable");
    }
  }

  /** A path (absolute, or relative to designsDir) that must resolve INSIDE designsDir, ending .zip. */
  private async loadZip(url: string | undefined): Promise<{ bytes: Uint8Array; name: string }> {
    if (!url) throw new OshParkError("oshpark_zip_missing");
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) throw new OshParkError("oshpark_zip_must_be_local_path");
    if (!/\.zip$/i.test(url)) throw new OshParkError("oshpark_not_a_zip");
    let root: string;
    let real: string;
    try {
      root = await Deno.realPath(this.designsDir);
      real = await Deno.realPath(url.startsWith("/") ? url : `${this.designsDir}/${url}`);
    } catch {
      throw new OshParkError("oshpark_zip_not_found");
    }
    if (!real.startsWith(root + "/")) throw new OshParkError("oshpark_zip_outside_designs_dir");
    const st = await Deno.stat(real);
    if (!st.isFile) throw new OshParkError("oshpark_zip_not_found");
    if (st.size > MAX_FILE_BYTES) throw new OshParkError("oshpark_zip_too_large");
    return { bytes: await Deno.readFile(real), name: real.split("/").pop() ?? "board.zip" };
  }
}

/** Build from env: OSHPARK_BASE_URL (tests), DATA_DIR (designs/ and oshpark/ live under it). */
export function oshParkFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): OshParkAdapter {
  const data = (env("DATA_DIR") || "./data").replace(/\/+$/, "");
  return new OshParkAdapter({
    baseUrl: env("OSHPARK_BASE_URL"),
    designsDir: `${data}/designs`,
    stateDir: `${data}/oshpark`,
  });
}
