// SPDX-License-Identifier: Apache-2.0
// Unit tests for the shared upload/finalize helpers (FDRS-656 review fixes).

import { describe, it, expect } from "vitest";
import { redactJsonl } from "../../../src/hosted/uploadAndFinalize.js";

describe("redactJsonl (FDRS-656 review)", () => {
  it("drops whitespace-only lines so validation and upload agree on row counts", () => {
    // validateJsonl trims lines before parsing, so a " " line passes
    // validation — it must never reach cloud as a non-JSON row.
    const out = redactJsonl('   \n{"a":1}\n\t\n');
    expect(out).toBe('{"a":1}\n');
  });

  it("keeps redacting secrets per line", () => {
    const out = redactJsonl('{"api_key":"redaction_fixture_secret"}\n');
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("redaction_fixture_secret");
  });

  it("returns empty string for whitespace-only payloads", () => {
    expect(redactJsonl(" \n  \n")).toBe("");
  });
});
