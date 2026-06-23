import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callJudge, JudgeHttpError } from "../../../src/evaluator/probabilistic/client.js";

const cfg = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  source: "pome_llm" as const,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callJudge", () => {
  it("posts chat completion to baseUrl + /chat/completions with bearer auth", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"status":"pass","confidence":0.9,"explanation":"ok"}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200 },
      ),
    );

    const result = await callJudge(cfg, "system", "user");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          authorization: "Bearer sk-test",
        }),
      }),
    );
    expect(result.text).toBe('{"status":"pass","confidence":0.9,"explanation":"ok"}');
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(20);
    expect(result.hasUsage).toBe(true);
  });

  it("uses x-api-key for Anthropic source", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"status":"pass","confidence":0.9,"explanation":"ok"}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200 },
      ),
    );

    await callJudge({ ...cfg, source: "anthropic_env" }, "system", "user");
    const headers = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBeDefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("returns hasUsage=false when response omits usage", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"status":"pass","confidence":0.9,"explanation":"ok"}' } }],
        }),
        { status: 200 },
      ),
    );
    const result = await callJudge(cfg, "s", "u");
    expect(result.hasUsage).toBe(false);
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });

  it("throws JudgeHttpError with status + message on non-2xx", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{"error":{"message":"Unauthorized"}}', { status: 401 }),
    );
    await expect(callJudge(cfg, "s", "u")).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("Unauthorized"),
    });
  });

  it("throws JudgeHttpError on network failure", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));
    const error = await callJudge(cfg, "s", "u").catch((e) => e);
    expect(error).toBeInstanceOf(JudgeHttpError);
    expect(error.status).toBe(0);
    expect(error.message).toContain("ECONNREFUSED");
  });

  it("throws JudgeHttpError with timeout message on AbortController abort", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(abortError);

    const error = await callJudge(cfg, "s", "u").catch((e) => e);
    expect(error).toBeInstanceOf(JudgeHttpError);
    expect(error.status).toBe(0);
    expect(error.message).toContain("timed out");
    expect(error.message).not.toContain("network error:");
  });

  it("throws JudgeHttpError when response.text() fails", async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      text: vi.fn().mockRejectedValue(new Error("connection reset")),
    } as unknown as Response;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(fakeResponse);

    const error = await callJudge(cfg, "s", "u").catch((e) => e);
    expect(error).toBeInstanceOf(JudgeHttpError);
    expect(error.status).toBe(0);
    expect(error.message).toContain("failed to read response body");
  });
});
