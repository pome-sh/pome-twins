// SPDX-License-Identifier: Apache-2.0
//
// Fidelity contract (F-730): the structured inventory is the hub — it must
// match the live tool list exactly, and the FIDELITY.md tables must match
// the inventory 1:1 (tier included). This replaces the old soft "docs
// mention the tool name" check, which could not see undocumented surfaces.
// The slack-specific doc pins (tier vocabulary, required REST surfaces, ts
// invariant, mutating tool set) stay.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareToolNames,
  lintFidelityInventory,
  loadFidelityInventory,
} from "@pome-sh/sdk/parity";
import { listTools, MUTATING_TOOL_NAMES } from "../src/tools.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIDELITY_PATH = join(PKG_ROOT, "FIDELITY.md");

describe("FIDELITY.md contract", () => {
  it("FIDELITY.md exists in the package root", () => {
    expect(existsSync(FIDELITY_PATH)).toBe(true);
  });

  it("keeps fidelity.inventory.json 1:1 with the live tool list", () => {
    const inventory = loadFidelityInventory(join(PKG_ROOT, "fidelity.inventory.json"));
    expect(
      compareToolNames(
        inventory.tools.map((tool) => tool.name),
        listTools().map((tool) => tool.name)
      )
    ).toEqual({ missing: [], extra: [] });
  });

  it("keeps the FIDELITY.md tables 1:1 with fidelity.inventory.json", () => {
    const inventory = loadFidelityInventory(join(PKG_ROOT, "fidelity.inventory.json"));
    const body = readFileSync(FIDELITY_PATH, "utf8");
    expect(
      lintFidelityInventory(inventory, [
        { label: "FIDELITY.md", kind: "tool", markdown: body },
        { label: "FIDELITY.md", kind: "rest", markdown: body },
      ])
    ).toEqual([]);
  });

  it("FIDELITY.md declares the three fidelity tiers", () => {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    expect(body).toMatch(/`semantic`/);
    expect(body).toMatch(/`shape`/);
    expect(body).toMatch(/`unsupported`/);
  });

  it("FIDELITY.md references all 12 fidelity-required REST surfaces", () => {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    const required = [
      "auth.test",
      "chat.postMessage",
      "chat.update",
      "chat.delete",
      "conversations.list",
      "conversations.info",
      "conversations.create",
      "conversations.history",
      "conversations.replies",
      "reactions.add",
      "users.list",
      "users.profile.get",
    ];
    for (const route of required) {
      expect(body.includes("`" + route + "`"), `FIDELITY.md is missing the route '${route}'`).toBe(true);
    }
  });

  it("FIDELITY.md documents the workspace-unique ts invariant", () => {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    expect(body).toMatch(/workspace-globally-unique/);
  });

  it("FIDELITY.md documents the mutating MCP tool set", () => {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    for (const name of MUTATING_TOOL_NAMES) {
      expect(body.includes(name)).toBe(true);
    }
  });
});
