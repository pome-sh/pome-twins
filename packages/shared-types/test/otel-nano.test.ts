// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { UINT64_MAX, compareUint64, isUint64, msToNanos, nanosToIso } from "../src/otel/nano.js";

describe("isUint64", () => {
  it("accepts in-range decimal strings (incl. leading zeros and 2^64-1)", () => {
    expect(isUint64("0")).toBe(true);
    expect(isUint64("000")).toBe(true);
    expect(isUint64("1700000000000000000")).toBe(true);
    expect(isUint64("18446744073709551614")).toBe(true); // 20-digit, just below max
    expect(isUint64(UINT64_MAX)).toBe(true);
  });

  it("rejects overflow, non-digits, and negatives", () => {
    expect(isUint64("18446744073709551616")).toBe(false); // 2^64
    expect(isUint64("184467440737095516150")).toBe(false); // longer than max
    expect(isUint64("12.3")).toBe(false);
    expect(isUint64("-1")).toBe(false);
    expect(isUint64("")).toBe(false);
    expect(isUint64("12a")).toBe(false);
  });
});

describe("compareUint64", () => {
  it("orders by magnitude regardless of leading zeros", () => {
    expect(compareUint64("100", "99")).toBeGreaterThan(0);
    expect(compareUint64("099", "100")).toBeLessThan(0);
    expect(compareUint64("00100", "100")).toBe(0);
    expect(compareUint64("5", "5")).toBe(0);
    expect(compareUint64(UINT64_MAX, "1")).toBeGreaterThan(0);
    // equal-length, differing value (the path the reversed-span guard relies on near max)
    expect(compareUint64("999", "998")).toBeGreaterThan(0);
    expect(compareUint64("18446744073709551614", "18446744073709551615")).toBeLessThan(0);
  });
});

describe("msToNanos / nanosToIso", () => {
  it("appends six zeros for ms→nanos (exact, no BigInt)", () => {
    expect(msToNanos(1780401600000)).toBe("1780401600000000000");
    expect(msToNanos(0)).toBe("0000000");
  });

  it("floors nanos to ms ISO (UTC), tolerating <1ms strings", () => {
    expect(nanosToIso("1700000000000000000")).toBe("2023-11-14T22:13:20.000Z");
    expect(nanosToIso("1700000000123456789")).toBe("2023-11-14T22:13:20.123Z");
    expect(nanosToIso("0")).toBe("1970-01-01T00:00:00.000Z");
    expect(nanosToIso("123")).toBe("1970-01-01T00:00:00.000Z");
  });

  it("never throws RangeError for an in-range uint64", () => {
    expect(() => nanosToIso(UINT64_MAX)).not.toThrow();
  });
});
