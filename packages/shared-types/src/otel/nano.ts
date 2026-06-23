// SPDX-License-Identifier: Apache-2.0
/**
 * otel/nano — uint64 decimal-string arithmetic + nanosecond↔ISO conversion
 * (M1.1 / FDRS-480).
 *
 * OTLP encodes `*_unix_nano` timestamps as uint64 decimal STRINGS because the
 * values exceed Number.MAX_SAFE_INTEGER. These helpers validate and compare
 * them WITHOUT `BigInt` — the dashboard compiles this source directly under a
 * pre-ES2020 target where `BigInt` literals fail to typecheck (review-era
 * portability fix). Everything here is pure and deterministic.
 */

// 2^64 - 1. A unix-nano timestamp must fit in a uint64; a longer/larger decimal
// string is rejected so it can never reach `nanosToIso` and throw a RangeError
// (review finding #4).
export const UINT64_MAX = "18446744073709551615";

// Strip leading zeros, keeping a single "0" for an all-zero string. The
// `(?=\d)` lookahead guarantees at least one digit remains, so for any digit
// string (callers validate via the `^\d+$` test first) the result is non-empty.
// Lets us compare normalized decimals by (length, then lexicographic).
function normalizeDigits(value: string): string {
  return value.replace(/^0+(?=\d)/, "");
}

/** True iff `value` is a non-negative decimal integer string within uint64. */
export function isUint64(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const normalized = normalizeDigits(value);
  if (normalized.length !== UINT64_MAX.length) {
    return normalized.length < UINT64_MAX.length;
  }
  return normalized <= UINT64_MAX;
}

/**
 * Compare two uint64 decimal strings. Returns <0 if a<b, 0 if equal, >0 if a>b.
 * Assumes both are valid digit strings (callers validate via `isUint64` first).
 */
export function compareUint64(a: string, b: string): number {
  const na = normalizeDigits(a);
  const nb = normalizeDigits(b);
  if (na.length !== nb.length) return na.length - nb.length;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

// Unix-milliseconds → uint64 unix-nanoseconds decimal string. Legacy timestamps
// are millisecond-precision, so this is exact: append six zeros. Deterministic.
export function msToNanos(millis: number): string {
  return `${millis}000000`;
}

/**
 * uint64 nanoseconds → ISO-8601 (UTC). Floors to milliseconds by dropping the
 * last 6 decimal digits of the (uint64-validated) integer string. The resulting
 * ms value is within Date's safe range for any valid uint64, so this never
 * throws for input that passed `isUint64`. String-slicing avoids `BigInt`.
 */
export function nanosToIso(unixNano: string): string {
  const millis = Number(unixNano.slice(0, -6) || "0");
  return new Date(millis).toISOString();
}
