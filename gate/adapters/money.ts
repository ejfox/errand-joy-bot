// Decimal money strings → integer cents, without float math. Shared by the card-paid adapters
// (Prodigi returns "11.10", Mouser returns "$0.0123" price breaks and "$1,234.56" order totals).

const MICROS_PER_CENT = 10_000; // 1 cent = 10^4 micro-dollars

/**
 * Parse a USD-ish decimal ("11.10", "$1,234.5", "-3.00", "US$0.0123", or a finite number) into an
 * integer count of micro-dollars (10^-6). At most 6 decimals. Returns undefined for anything else.
 */
export function moneyToMicros(v: unknown): number | undefined {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    s = v.toFixed(6);
  } else if (typeof v === "string") {
    s = v.trim().replace(/^(US)?\$/i, "").replace(/\s+/g, "").replace(/,/g, "");
  } else return undefined;
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return undefined;
  const micros = Number(m[2]) * 1_000_000 + Number((m[3] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micros)) return undefined;
  return m[1] === "-" ? -micros : micros;
}

/** Micro-dollars → cents. "ceil" rounds a fraction of a cent up (the safe direction for a quote). */
export function microsToCents(micros: number, mode: "ceil" | "round" = "round"): number {
  const c = micros / MICROS_PER_CENT;
  return mode === "ceil" ? Math.ceil(c) : Math.round(c);
}

/** Decimal → cents (rounded half-up), or undefined when unparseable. */
export function moneyToCents(v: unknown): number | undefined {
  const m = moneyToMicros(v);
  return m === undefined ? undefined : microsToCents(m);
}

/** Deterministic short reference derived from the gate idempotency key: `ejb-` + `hexChars` hex of sha256. */
export async function hashedRef(key: string, hexChars = 32): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return "ejb-" + [...h].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, hexChars);
}
