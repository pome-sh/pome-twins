import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listTools } from "../src/tools.js";

describe("fidelity contract documentation", () => {
  it("documents every MCP tool with a fidelity tier and backing surface", () => {
    const fidelity = readFileSync(resolve(import.meta.dirname, "..", "FIDELITY.md"), "utf8");
    for (const tool of listTools()) {
      expect(fidelity).toContain(`\`${tool.name}\``);
    }
    expect(fidelity).toContain("semantic");
    expect(fidelity).toContain("shape");
    expect(fidelity).toContain("unsupported");
    expect(fidelity).toContain("Last verified");
  });

  it("keeps a route-level matrix for product-supported REST behavior", () => {
    const matrix = readFileSync(resolve(import.meta.dirname, "..", "FIDELITY_MATRIX.md"), "utf8");
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
