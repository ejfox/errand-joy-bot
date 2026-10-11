// Vendor money helpers shared by adapters whose APIs speak decimal-dollar strings ("0.88",
// "214.4200", "2257.37"). Never parseFloat money: a string is split on "." and read as integers.

/**
 * "12.34" | 12.34 → 1234 cents. Digits past the second decimal place are truncated (vendors pad
 * balances to 4 places, "214.4200"). Returns undefined for anything that isn't a plain
 * non-negative decimal amount.
 */
export function dollarsToCents(v: unknown): number | undefined {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return undefined;
    s = v.toFixed(4);
  } else if (typeof v === "string") {
    s = v.trim();
  } else {
    return undefined;
  }
  const m = /^(\d{1,9})(?:\.(\d{0,6}))?$/.exec(s);
  if (!m) return undefined;
  const frac = (m[2] ?? "").padEnd(2, "0").slice(0, 2);
  const cents = Number(m[1]) * 100 + Number(frac);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/** True when `url` is an absolute https URL (http only to loopback, for tests). */
export function isHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/** A configured vendor base URL: https, or http only on loopback. Trailing slashes removed. */
export function checkBaseUrl(base: string, envName: string): string {
  const b = base.replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(b);
  } catch {
    throw new Error(`${envName} must be a URL`);
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error(`${envName} must be https (http only on loopback)`);
  }
  return b;
}
