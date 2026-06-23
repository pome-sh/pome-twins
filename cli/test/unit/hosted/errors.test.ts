import { describe, it, expect } from "vitest";
import {
  HostedAuthError,
  HostedQuotaError,
  HostedOrchError,
  HostedUsageError,
  exitCodeFor,
} from "../../../src/hosted/errors.js";

describe("hosted/errors", () => {
  // F0-5 — regression test for the documented `pome run` exit-code contract:
  // 0 pass / 1 below-threshold / 2 twin-orch / 3 auth / 4 quota / 5 usage.
  // Walkthrough P2.24-25-27 found 3 paths landing on the wrong code.
  it("maps each error type to the documented CLI exit code (F0-5)", () => {
    expect(exitCodeFor(new HostedAuthError("bad key"))).toBe(3);
    expect(exitCodeFor(new HostedQuotaError("over limit"))).toBe(4);
    expect(exitCodeFor(new HostedOrchError("twin spawn failed"))).toBe(2);
    expect(exitCodeFor(new HostedUsageError("scenario not found"))).toBe(5);
    expect(exitCodeFor(new Error("unknown"))).toBe(2);
  });

  it("preserves message + optional request_id from the cloud error envelope", () => {
    const err = new HostedAuthError("bad key", "req_abc");
    expect(err.message).toBe("bad key");
    expect(err.requestId).toBe("req_abc");
  });
});
