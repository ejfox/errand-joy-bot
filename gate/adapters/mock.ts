// Deterministic in-memory vendor (zero vendor keys, no network, moves no money).
import { OWNER_HOME } from "../types.ts";
import type { Charge, Order, PurchaseRequest, Quote, Reach, VendorAdapter } from "../types.ts";

/** Default mock sales tax, applied to the subtotal only. Override with `taxRate` (config `[mock] tax_rate`). */
export const MOCK_TAX_RATE = 0.08;
/** Shipping rule: $5.99 flat, free when the subtotal is at least $35.00. */
export const MOCK_SHIPPING_CENTS = 599;
export const MOCK_FREE_SHIPPING_MIN_CENTS = 3_500;

export type MockFailure = "max_price_exceeded" | "declined" | null;

export interface MockAdapterOptions {
  /** sku → unit cents; wins over the hash price. */
  prices?: Record<string, number>;
  /** Scripted place() failure. "max_price_exceeded" also fires on its own when drift breaks the hard cap. */
  failPlaceWith?: MockFailure;
  /** Place-time total = quoted total × (1 + pct/100). */
  priceDriftPct?: number;
  /** Charges with no matching order, appended to listCharges. */
  phantomCharges?: Charge[];
  /** Categories whose effects reach the world (e.g. "tree", "telescope"). */
  worldCategories?: string[];
  /** Sales tax rate applied to the subtotal (0 ≤ rate < 1). Default MOCK_TAX_RATE. */
  taxRate?: number;
}

type OrderState = Awaited<ReturnType<VendorAdapter["status"]>>["state"];
const ADVANCE: Record<OrderState, OrderState> = {
  open: "shipped",
  shipped: "delivered",
  delivered: "delivered",
  cancelled: "cancelled",
  failed: "failed",
};

interface MockOrder {
  vendorOrderId: string;
  chargedCents: number;
  at: string;
  state: OrderState;
  polled: boolean;
}

/** FNV-1a 32-bit. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic mock vendor. Unit price per SKU = `prices[sku]` or 100 + fnv1a(sku) % 9900 cents
 * ($1.00–$99.99). Tax = round(subtotal × taxRate) (default 8%). Shipping = $5.99, free at subtotal ≥ $35.
 */
export class MockAdapter implements VendorAdapter {
  readonly id = "mock";
  readonly maxReach: Reach = "others";
  readonly simulated = true;
  paused = false;

  private readonly o: Required<MockAdapterOptions>;
  private readonly orders = new Map<string, MockOrder>();
  private readonly byKey = new Map<string, MockOrder>();
  private seq = 0;

  constructor(opts: MockAdapterOptions = {}) {
    this.o = {
      prices: {},
      failPlaceWith: null,
      priceDriftPct: 0,
      phantomCharges: [],
      worldCategories: ["tree", "telescope"],
      ...opts,
      taxRate: opts.taxRate ?? MOCK_TAX_RATE,
    };
    if (!(Number.isFinite(this.o.taxRate) && this.o.taxRate >= 0 && this.o.taxRate < 1)) {
      throw new Error("mock taxRate must be in [0, 1)");
    }
  }

  unitPriceCents(sku: string): number {
    return this.o.prices[sku] ?? 100 + (fnv1a(sku) % 9_900);
  }

  reachFor(req: PurchaseRequest): Reach {
    if (req.shipTo !== undefined && req.shipTo !== OWNER_HOME) return "others";
    if (req.category && this.o.worldCategories.includes(req.category)) return "world";
    return "self";
  }

  quote(req: PurchaseRequest): Promise<Quote> {
    const subtotalCents = req.items.reduce((sum, it) => sum + this.unitPriceCents(it.sku) * it.qty, 0);
    const taxCents = Math.round(subtotalCents * this.o.taxRate);
    const shippingCents = subtotalCents >= MOCK_FREE_SHIPPING_MIN_CENTS ? 0 : MOCK_SHIPPING_CENTS;
    return Promise.resolve({
      subtotalCents,
      taxCents,
      shippingCents,
      totalCents: subtotalCents + taxCents + shippingCents,
      currency: "USD",
      vendorRef: `mockq-${fnv1a(JSON.stringify(req.items)).toString(16)}`,
      quotedAt: new Date().toISOString(),
    });
  }

  place(_req: PurchaseRequest, q: Quote, hardCapCents: number, idempotencyKey: string): Promise<Order> {
    if (this.paused) return Promise.reject(new Error("vendor_paused"));
    const prior = this.byKey.get(idempotencyKey);
    if (prior) return Promise.resolve(toOrder(prior));

    const totalCents = Math.round(q.totalCents * (1 + this.o.priceDriftPct / 100));
    if (totalCents > hardCapCents) return Promise.reject(new Error("max_price_exceeded"));
    if (this.o.failPlaceWith) return Promise.reject(new Error(this.o.failPlaceWith));

    const o: MockOrder = {
      vendorOrderId: `mock-${++this.seq}`,
      chargedCents: totalCents,
      at: new Date().toISOString(),
      state: "open",
      polled: false,
    };
    this.orders.set(o.vendorOrderId, o);
    this.byKey.set(idempotencyKey, o);
    return Promise.resolve(toOrder(o));
  }

  /** Each call advances open → shipped → delivered (sticks at delivered / cancelled). */
  status(vendorOrderId: string) {
    const o = this.orders.get(vendorOrderId);
    if (!o) return Promise.reject(new Error("unknown_order"));
    if (o.polled) o.state = ADVANCE[o.state];
    o.polled = true;
    const tracking = o.state === "shipped" || o.state === "delivered" ? `MOCKTRK${o.vendorOrderId}` : undefined;
    return Promise.resolve({ state: o.state, tracking });
  }

  cancel(vendorOrderId: string): Promise<boolean> {
    const o = this.orders.get(vendorOrderId);
    if (!o || o.state !== "open") return Promise.resolve(false);
    o.state = "cancelled";
    return Promise.resolve(true);
  }

  /** Real placed (non-cancelled) orders plus scripted phantoms, filtered to `at >= sinceISO`. */
  listCharges(sinceISO: string): Promise<Charge[]> {
    const real: Charge[] = [...this.orders.values()]
      .filter((o) => o.state !== "cancelled")
      .map((o) => ({
        vendorChargeId: `ch-${o.vendorOrderId}`,
        amountCents: o.chargedCents,
        at: o.at,
        vendorOrderId: o.vendorOrderId,
      }));
    return Promise.resolve([...real, ...this.o.phantomCharges].filter((c) => c.at >= sinceISO));
  }

  pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }
}

function toOrder(o: MockOrder): Order {
  return { vendorOrderId: o.vendorOrderId, chargedCents: o.chargedCents };
}
