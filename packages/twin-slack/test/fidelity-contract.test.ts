// SPDX-License-Identifier: Apache-2.0
//
// Asserts FIDELITY.md exists and stays in sync with the actual code:
//   - References every visible MCP tool
//   - Lists every shipped REST surface area
//   - Calls out the fidelity tiers
//
// If FIDELITY.md drifts from src/tools.ts the contract test fails loudly,
// which forces a deliberate doc update on any tool surface change.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toolDefinitions, MUTATING_TOOL_NAMES } from "../src/tools.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIDELITY_PATH = join(PKG_ROOT, "FIDELITY.md");

describe("FIDELITY.md contract", () => {
  it("FIDELITY.md exists in the package root", () => {
    expect(existsSync(FIDELITY_PATH)).toBe(true);
  });

  it("FIDELITY.md mentions every visible MCP tool by name", () => {
    const body = readFileSync(FIDELITY_PATH, "utf8");
    for (const tool of toolDefinitions) {
      expect(
        body.includes("`" + tool.name + "`"),
        `FIDELITY.md is missing the tool '${tool.name}'`
      ).toBe(true);
    }
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
