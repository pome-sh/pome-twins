// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Stripe fidelity matrix", () => {
  it("documents supported REST and x402 product surfaces", () => {
    const matrix = readFileSync(resolve(import.meta.dirname, "..", "FIDELITY_MATRIX.md"), "utf8");
    for (const surface of [
      "`POST /v1/payment_intents`",
      "`GET /v1/payment_intents`",
      "`POST /v1/test_helpers/payment_intents/:id/simulate_crypto_deposit`",
      "`GET /x402/protected-resource`"
    ]) {
      expect(matrix).toContain(surface);
    }
    expect(matrix).toContain("Unsupported `/v1/*` paths");
    expect(matrix).toContain("Last verified");
  });
});
