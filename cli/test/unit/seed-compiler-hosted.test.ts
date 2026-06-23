// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileSeedHosted } from "../../src/scenario/seed-compiler-hosted.js";
import { HostedAuthError, HostedOrchError, HostedQuotaError } from "../../src/hosted/errors.js";

const VALID_SEED = {
  repositories: [
    {
      owner: "acme",
      name: "api",
      labels: [],
      collaborators: ["alice"],
      issues: [
        { number: 1, title: "test", body: "", labels: [], assignee: null }
      ]
    }
  ]
};

const validResponse = {
  seed: VALID_SEED,
  source_hash: "sha256:abc",
  model: "claude-opus-4-7",
  compiled_at: "2026-05-22T00:00:00.000Z",
  cached: false,
  input_tokens: 2000,
  output_tokens: 200
};

function mockFetchOnce(impl: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(impl));
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

/** Shape returned by the cloud's `apiError()` helper. Documented at
 *  `cli/src/hosted/client.ts:110` and verified against pome-cloud PR #131. */
function cloudErr(type: string, message: string, requestId?: string) {
  return { error: { type, message, ...(requestId ? { request_id: requestId } : {}) } };
}

describe("compileSeedHosted", () => {
  beforeEach(() => {
    process.env.POME_API_KEY = "test_api_key";
    process.env.POME_API_URL = "https://api.pome.test";
  });
  afterEach(() => {
    delete process.env.POME_API_KEY;
    delete process.env.POME_API_URL;
    vi.unstubAllGlobals();
  });

  it("calls /v1/scenarios/compile-seed with x-api-key header and returns CompileResult", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return json(validResponse);
      })
    );

    // F0-6: caller's apiBaseUrl wins (env folding happens in main.ts before
    // reaching the runner). Use the matching URL so the test isn't asserting
    // an env-vs-input divergence that doesn't happen in production.
    const result = await compileSeedHosted("prose body", {
      apiBaseUrl: "https://api.pome.test",
      scenarioPath: "scenarios/x.md"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.pome.test/v1/scenarios/compile-seed");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test_api_key");
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.prose).toBe("prose body");
    expect(body.twin).toBe("github");
    expect(body.scenario_path).toBe("scenarios/x.md");

    expect(result.model).toBe("claude-opus-4-7");
    expect(result.inputTokens).toBe(2000);
    expect(result.outputTokens).toBe(200);
    expect(result.seed).toBeDefined();
  });

  it("maps 401 with nested error envelope to HostedAuthError", async () => {
    mockFetchOnce(() => json(cloudErr("unauthorized", "API key not recognized"), { status: 401 }));
    await expect(compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" })).rejects.toBeInstanceOf(
      HostedAuthError
    );
  });

  it("maps 402 with nested error envelope to HostedQuotaError", async () => {
    mockFetchOnce(() => json(cloudErr("quota_exceeded", "out of credits"), { status: 402 }));
    await expect(compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" })).rejects.toBeInstanceOf(
      HostedQuotaError
    );
  });

  it("maps 429 with nested error envelope to HostedQuotaError", async () => {
    mockFetchOnce(() => json(cloudErr("rate_limited", "slow down"), { status: 429 }));
    await expect(compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" })).rejects.toBeInstanceOf(
      HostedQuotaError
    );
  });

  it("maps 500 with nested error envelope to HostedOrchError", async () => {
    mockFetchOnce(() => json(cloudErr("internal_error", "boom"), { status: 500 }));
    await expect(compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" })).rejects.toBeInstanceOf(
      HostedOrchError
    );
  });

  // F29 — a 502 leaks "vercel.com/d?to=..." and "Free tier users do not have
  // access to this model..." into the CLI surface. Hide that behind a
  // user-actionable hint (drop --hosted / retry).
  it("wraps 502 with a friendly hint and hides the upstream Vercel message (F29)", async () => {
    mockFetchOnce(() =>
      json(
        cloudErr(
          "internal_error",
          "Free tier users do not have access to this model, including via BYOK. https://vercel.com/d?to=...",
        ),
        { status: 502 },
      ),
    );
    const err = await compileSeedHosted("prose", {
      apiBaseUrl: "https://api.pome.test",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HostedOrchError);
    const msg = (err as HostedOrchError).message;
    expect(msg).toMatch(/temporary capacity limit/);
    expect(msg).toMatch(/--hosted|BYOK|ANTHROPIC_API_KEY/);
    expect(msg).not.toMatch(/vercel\.com/);
    expect(msg).not.toMatch(/Free tier users/);
  });

  it("maps fetch-level failures to HostedOrchError", async () => {
    mockFetchOnce(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" })).rejects.toThrow(
      /Could not reach the Pome control plane/
    );
  });

  it("maps malformed JSON to HostedOrchError", async () => {
    mockFetchOnce(
      () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    await expect(compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" })).rejects.toThrow(
      /could not parse/
    );
  });

  it("re-validates the seed locally and rejects schema-invalid responses", async () => {
    mockFetchOnce(() =>
      json({
        ...validResponse,
        seed: { repositories: [] } // empty repos violates seedStateSchema min(1)
      })
    );
    await expect(compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" })).rejects.toThrow();
  });

  describe("nested error envelope round-trip", () => {
    it("surfaces 422 validation_failed detail in the HostedOrchError message", async () => {
      mockFetchOnce(() =>
        json(cloudErr("validation_failed", "seed references nonexistent label 'bug'"), { status: 422 })
      );
      await expect(
        compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" })
      ).rejects.toThrowError(/seed references nonexistent label 'bug'/);
    });

    it("propagates error.request_id from the nested envelope onto HostedAuthError", async () => {
      mockFetchOnce(() =>
        json(cloudErr("unauthorized", "bad key", "req_abc123"), { status: 401 })
      );
      const err = await compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" }).catch(
        (e) => e
      );
      expect(err).toBeInstanceOf(HostedAuthError);
      expect((err as HostedAuthError).requestId).toBe("req_abc123");
    });

    it("falls back to x-request-id header when nested envelope omits request_id", async () => {
      mockFetchOnce(
        () =>
          new Response(JSON.stringify(cloudErr("internal_error", "boom")), {
            status: 502,
            headers: { "content-type": "application/json", "x-request-id": "req_header_only" }
          })
      );
      const err = await compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" }).catch(
        (e) => e
      );
      expect(err).toBeInstanceOf(HostedOrchError);
      expect((err as HostedOrchError).requestId).toBe("req_header_only");
    });

    it("falls back to HTTP <status> when body has no error envelope", async () => {
      // 502 specifically is now wrapped with a friendly capacity-limit hint
      // (F29), so probe the fallback path with a generic 503 instead.
      mockFetchOnce(() => json({}, { status: 503 }));
      await expect(
        compileSeedHosted("prose", { apiBaseUrl: "https://api.pome.test" })
      ).rejects.toThrowError(/HTTP 503/);
    });
  });
});
