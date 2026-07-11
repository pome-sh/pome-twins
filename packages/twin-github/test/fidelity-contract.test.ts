// SPDX-License-Identifier: Apache-2.0
//
// Fidelity contract (F-730): the structured inventory is the hub — it must
// match the live tool list exactly, and the FIDELITY doc tables must match
// the inventory 1:1 (tier included). This replaces the old soft "docs
// mention the tool name" check, which could not see undocumented surfaces.
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
const matrix = readFileSync(resolve(root, "FIDELITY_MATRIX.md"), "utf8");

describe("fidelity contract documentation", () => {
  it("keeps fidelity.inventory.json 1:1 with the live tool list", () => {
    expect(
      compareToolNames(
        inventory.tools.map((tool) => tool.name),
        listTools().map((tool) => tool.name)
      )
    ).toEqual({ missing: [], extra: [] });
  });

  it("keeps the FIDELITY doc tables 1:1 with fidelity.inventory.json", () => {
    expect(
      lintFidelityInventory(inventory, [
        { label: "FIDELITY.md", kind: "tool", markdown: fidelity },
        { label: "FIDELITY_MATRIX.md", kind: "rest", markdown: matrix },
      ])
    ).toEqual([]);
  });

  it("documents the fidelity tier vocabulary and a verification date", () => {
    expect(fidelity).toContain("semantic");
    expect(fidelity).toContain("shape");
    expect(fidelity).toContain("unsupported");
    expect(fidelity).toContain("Last verified");
  });

  it("keeps a route-level matrix for product-supported REST behavior", () => {
    for (const surface of [
      "`GET /repos/:owner/:repo`",
      "`POST /repos/:owner/:repo/issues`",
      "`GET /repos/:owner/:repo/collaborators/:username`",
      "`POST /mcp/call`"
    ]) {
      expect(matrix).toContain(surface);
    }
    expect(matrix).toContain("unsupported");
    expect(matrix).toContain("Last verified");
  });
});
