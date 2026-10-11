// Closed vendor allowlist + the guard every adapter is wrapped in.
// A vendor not registered here cannot be bought from, and the registry hands out ONLY guarded
// adapters, so no vendor adapter (present or future) can skip the hard cap, pause, STOP, DRY_RUN
// or reach-floor checks. Adapters may keep their own checks too (the mock does): belt and braces.
import { OWNER_HOME, type PurchaseRequest, type Reach, REACH_RANK, type VendorAdapter } from "../types.ts";
import { MockAdapter } from "./mock.ts";
import { zincFromEnv } from "./zinc.ts";
import { slant3dFromEnv } from "./slant3d.ts";

// Future adapters (not built; each needs its own key, spend limit and reachFor):
//   mouser / craftcloud / pcbway          self when shipTo is owner-home, otherwise others
//   lob / stannp / goody                  others (mails or gifts a third party)
//   tree-nation / skyfi                   world

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
  slant3d: () => slant3dFromEnv(),
};

export function knownVendors(): string[] {
  return Object.keys(VENDOR_FACTORIES);
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
