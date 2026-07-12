// SPDX-License-Identifier: Apache-2.0
//
// Fidelity contract (F-730): the structured inventory is the hub — it must
// match the live tool list exactly, and the FIDELITY.md tables must match
// the inventory 1:1 (tier included). The old matrix-only check missed the
// refunds chain shipping without docs; that gap is now declared as
// doc_drift in fidelity.inventory.json (reconciliation owned by F-733) and
// this test fails the moment the declaration goes stale.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareToolNames,
  lintFidelityInventory,
  loadFidelityInventory,
} from "@pome-sh/sdk/parity";
import { listTools } from "../src/tools.js";

const root = resolve(import.meta.dirname, "..");
const inventory = loadFidelityInventory(resolve(root, "fidelity.inventory.json"));
const fidelity = readFileSync(resolve(root, "FIDELITY.md"), "utf8");

describe("Stripe fidelity contract", () => {
  it("keeps fidelity.inventory.json 1:1 with the live tool list", () => {
    expect(
      compareToolNames(
        inventory.tools.map((tool) => tool.name),
        listTools().map((tool) => tool.name)
      )
    ).toEqual({ missing: [], extra: [] });
  });

  it("keeps the FIDELITY.md tables 1:1 with fidelity.inventory.json", () => {
    expect(
      lintFidelityInventory(inventory, [
        { label: "FIDELITY.md", kind: "tool", markdown: fidelity },
        { label: "FIDELITY.md", kind: "rest", markdown: fidelity },
      ])
    ).toEqual([]);
  });

  it("documents supported REST and x402 product surfaces", () => {
    const matrix = readFileSync(resolve(root, "FIDELITY_MATRIX.md"), "utf8");
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
