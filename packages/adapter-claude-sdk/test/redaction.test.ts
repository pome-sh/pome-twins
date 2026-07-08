// SPDX-License-Identifier: Apache-2.0
// Co-located guard for the adapter redaction surface (FDRS-588 / FDRS-608):
// since M6 it re-exports @pome-sh/shared-types/redaction — these cases pin
// the shapes the adapter relies on staying redacted.
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redaction.js";

describe("redaction mirror — provider secret shapes", () => {
  it("redacts the 12-char body Stripe seed key sk_test_pome_default", () => {
    const key = "sk_test_pome_default";
    const out = redactSecrets({ note: `secret ${key}` }) as { note: string };
    expect(out.note).not.toContain(key);
    expect(out.note).toContain("[REDACTED]");
  });

  it("redacts short Pome Stripe secret and restricted seed keys", () => {
    const secretKey = "sk_test_pome_a";
    const restrictedKey = "rk_test_pome_default";
    const out = redactSecrets(`${secretKey} ${restrictedKey}`) as string;
    expect(out).toBe("[REDACTED] [REDACTED]");
  });

  it("redacts live Stripe secret keys", () => {
    const key = "sk_live_" + "51H".repeat(8);
    const out = redactSecrets(key) as string;
    expect(out).toBe("[REDACTED]");
  });

  it("redacts Slack app-level tokens (xapp-...)", () => {
    const key = "xapp-1-A01B2C3D4E5-" + "1".repeat(20) + "-deadbeef";
    const out = redactSecrets(key) as string;
    expect(out).toBe("[REDACTED]");
  });

  it("redacts Google API keys (AIza...)", () => {
    const key = "AIza" + "SyD-abc123DEF456ghi789jklMNO_pqrstu";
    const out = redactSecrets(key) as string;
    expect(out).toBe("[REDACTED]");
  });

  it("fires inside nested tool_use / JSON shapes", () => {
    const key = "sk_test_pome_default";
    const out = redactSecrets({
      type: "tool_use",
      input: { headers: { authorization: "Bearer x" }, body: `k=${key}` },
    });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  it("does not over-redact benign lookalikes", () => {
    expect(redactSecrets({ msg: "task_test_pipeline_default" })).toEqual({
      msg: "task_test_pipeline_default",
    });
    expect(redactSecrets({ msg: "task-management-service-endpoint-handler" })).toEqual({
      msg: "task-management-service-endpoint-handler",
    });
    expect(redactSecrets("The sky is blue and skills matter.")).toBe(
      "The sky is blue and skills matter.",
    );
  });
});
