// Closed vendor allowlist + the guard every adapter is wrapped in.
// A vendor not registered here cannot be bought from, and the registry hands out ONLY guarded
// adapters, so no vendor adapter (present or future) can skip the hard cap, pause, STOP, DRY_RUN
// or reach-floor checks. Adapters may keep their own checks too (the mock does): belt and braces.
import { OWNER_HOME, type PurchaseRequest, type Reach, REACH_RANK, type VendorAdapter } from "../types.ts";
import { MockAdapter } from "./mock.ts";
import { skyFiFromEnv } from "./skyfi.ts";
import { treeNationFromEnv } from "./treenation.ts";
import { zincFromEnv } from "./zinc.ts";
import { stannpFromEnv } from "./stannp.ts";
import { luluFromEnv } from "./lulu.ts";
import { slant3dFromEnv } from "./slant3d.ts";
import { prodigiFromEnv } from "./prodigi.ts";
import { mouserFromEnv } from "./mouser.ts";

// Future adapters (not built; each needs its own key, spend limit and reachFor):
//   craftcloud / pcbway                   self when shipTo is owner-home, otherwise others
//   lob / goody                           others (mails or gifts a third party)

/** place() was refused by the guard BEFORE the vendor was called: no money can have moved. */
export class GuardRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GuardRefused";
  }
}

export interface GuardOptions {
  /** Live STOP check, consulted on every place(). Throwing counts as stopped (fail closed). */
  isStopped(): boolean | Promise<boolean>;
  /** DRY_RUN: place() is refused on every adapter that is not `simulated`. */
  dryRun: boolean;
  /** Categories whose effects reach the world; the guard raises reach to at least "world". */
  worldCategories?: readonly string[];
}

export interface GuardedAdapter extends VendorAdapter {
  readonly guarded: true;
  readonly inner: VendorAdapter;
  isPaused(): boolean;
  /** Clears the guard's own pause flag (STOP cleared by a human). The inner adapter's pause is its own. */
  resume(): void;
}

function maxReach(a: Reach, b: Reach): Reach {
  return REACH_RANK[a] >= REACH_RANK[b] ? a : b;
}

/** The reach no adapter may go below: a third-party address is "others", a world category is "world". */
export function reachFloor(req: PurchaseRequest, worldCategories: readonly string[] = []): Reach {
  if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) return "others";
  if (req.category !== undefined && worldCategories.includes(req.category)) return "world";
  return "self";
}

export function guarded(inner: VendorAdapter, opts: GuardOptions): GuardedAdapter {
  if ((inner as Partial<GuardedAdapter>).guarded) return inner as GuardedAdapter;
  let paused = false;
  const world = opts.worldCategories ?? [];
  return {
    guarded: true,
    inner,
    id: inner.id,
    maxReach: inner.maxReach,
    simulated: inner.simulated === true,
    isPaused: () => paused,
    resume: () => {
      paused = false;
    },
    reachFor(req) {
      let r: Reach;
      try {
        r = inner.reachFor(req);
      } catch {
        return "others"; // can't tell → the strictest reach
      }
      if (!(r in REACH_RANK)) return "others";
      return maxReach(r, reachFloor(req, world));
    },
    quote: (req) => inner.quote(req),
    async place(req, q, hardCapCents, idempotencyKey) {
      if (!Number.isSafeInteger(hardCapCents) || hardCapCents <= 0) throw new GuardRefused("bad_hard_cap");
      if (!q || !Number.isSafeInteger(q.totalCents) || q.totalCents < 0) throw new GuardRefused("bad_quote");
      if (q.totalCents > hardCapCents) throw new GuardRefused("max_price_exceeded");
      if (paused) throw new GuardRefused("vendor_paused");
      let stopped = true;
      try {
        stopped = Boolean(await opts.isStopped());
      } catch { /* unknown → stopped */ }
      if (stopped) throw new GuardRefused("stopped");
      if (opts.dryRun && inner.simulated !== true) throw new GuardRefused("dry_run");
      const order = await inner.place(req, q, hardCapCents, idempotencyKey);
      if (
        !order || typeof order.vendorOrderId !== "string" || !order.vendorOrderId ||
        !Number.isSafeInteger(order.chargedCents) || order.chargedCents < 0
      ) {
        // The vendor was called, so money may have moved: NOT a GuardRefused.
        throw new Error("vendor returned a malformed order");
      }
      return order;
    },
    status: (id) => inner.status(id),
    cancel: (id) => inner.cancel(id),
    listCharges: (since) => inner.listCharges(since),
    async pause() {
      paused = true;
      await inner.pause();
    },
  };
}

export interface RegistryOptions extends GuardOptions {
  mockTaxRate?: number;
}

/** Every vendor this build knows how to talk to. config `vendors` must be a subset. */
export const VENDOR_FACTORIES: Readonly<Record<string, (o: RegistryOptions) => VendorAdapter>> = {
  mock: (o) => new MockAdapter({ taxRate: o.mockTaxRate, worldCategories: [...(o.worldCategories ?? [])] }),
  zinc: () => zincFromEnv(),
  treenation: () => treeNationFromEnv(),
  skyfi: () => skyFiFromEnv(),
  stannp: () => stannpFromEnv(),
  lulu: () => luluFromEnv(),
  slant3d: () => slant3dFromEnv(),
  prodigi: () => prodigiFromEnv(),
  mouser: () => mouserFromEnv(),
};

export function knownVendors(): string[] {
  return Object.keys(VENDOR_FACTORIES);
}

/**
 * The API hosts each vendor's adapter talks to with its DEFAULT base URLs (live and sandbox both,
 * so flipping LULU_ENV / PRODIGI_ENV / TREENATION_BASE_URL needs no reinstall). ops/install.sh
 * adds these to Deno's --allow-net for the vendors enabled in config.toml (gate/vendor_hosts.ts).
 * A custom *_BASE_URL host still goes in `install.sh --allow-net`.
 */
export const VENDOR_HOSTS: Readonly<Record<string, readonly string[]>> = {
  mock: [],
  zinc: ["api.zinc.com"],
  treenation: ["tree-nation.com", "youcannevertestenough.tree-nation.com"],
  skyfi: ["app.skyfi.com"],
  stannp: ["api-us1.stannp.com"],
  lulu: ["api.lulu.com", "api.sandbox.lulu.com"],
  // File uploads go to a presigned S3 URL whose host Slant 3D picks (not documented, not yet
  // observed live). Pass it with `install.sh --allow-net <bucket host>` once seen.
  // Design uploads go to a presigned S3 PUT on this bucket (observed 2026-10-11).
  slant3d: ["slant3dapi.com", "slant-gatekeeper.s3.us-west-2.amazonaws.com"],
  prodigi: ["api.prodigi.com", "api.sandbox.prodigi.com"],
  mouser: ["api.mouser.com"],
};

/** Deduped --allow-net hosts for the enabled vendors. Unknown vendors throw (closed allowlist). */
export function vendorHosts(enabled: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of enabled) {
    if (!Object.hasOwn(VENDOR_HOSTS, v)) throw new Error(`unknown vendor "${v}"`);
    for (const h of VENDOR_HOSTS[v]) if (!out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * Build the guarded adapters for the enabled vendors (one instance each per process, so orders
 * placed through one show up in its listCharges). `overrides` substitutes an instance (tests);
 * it is guarded all the same. Unknown vendors throw.
 */
export function buildRegistry(
  enabled: readonly string[],
  opts: RegistryOptions,
  overrides: Record<string, VendorAdapter> = {},
): Record<string, GuardedAdapter> {
  const out: Record<string, GuardedAdapter> = {};
  for (const id of enabled) {
    if (!Object.hasOwn(VENDOR_FACTORIES, id)) throw new Error(`unknown vendor "${id}"`);
    const inner = Object.hasOwn(overrides, id) ? overrides[id] : VENDOR_FACTORIES[id](opts);
    if (inner.id !== id) throw new Error(`adapter id mismatch: ${inner.id} registered as ${id}`);
    out[id] = guarded(inner, opts);
  }
  return out;
}
