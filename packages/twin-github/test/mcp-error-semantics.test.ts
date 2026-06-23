import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/app.js";
import { createRecorder } from "../src/recorder.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

describe("GitHub-shaped error semantics", () => {
  it("returns a loud 501 unsupported envelope and records unsupported fidelity", async () => {
    const recorder = createRecorder();
    const app = createGitHubCloneApp({ recorder, runId: "error-contract" });

    const response = await app.request(`${base}/repos/acme/api/actions/runs`, withAuth(token));
    expect(response.status).toBe(501);
    // FDRS-431: response-envelope twin metadata lives under `_twin.*` (clean
    // cutover — no bare top-level `fidelity`). The recorder event below keeps
    // its own `fidelity` tier field — that is internal tape telemetry, not the
    // response envelope.
    const body = await response.json() as {
      fidelity?: unknown;
      _twin: { fidelity: string };
    };
    expect(body).toMatchObject({
      message: "This endpoint is not supported by this GitHub twin clone.",
      _twin: { fidelity: "unsupported" }
    });
    expect(body.fidelity).toBeUndefined();

    const event = recorder.events().at(-1);
    expect(event).toMatchObject({
      path: `${base}/repos/acme/api/actions/runs`,
      status: 501,
      fidelity: "unsupported",
      state_mutation: false
    });
  });

  it("returns 422 validation envelopes for malformed requests and unknown tools", async () => {
    const app = createGitHubCloneApp();

    const malformed = await app.request(`${base}/mcp/call`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "create_issue", arguments: { owner: "acme", repo: "api" } })
    }));
    expect(malformed.status).toBe(422);
    await expect(malformed.json()).resolves.toMatchObject({
      message: "Validation Failed",
      documentation_url: "https://docs.github.com/rest",
      errors: expect.any(Array)
    });

    const unknown = await app.request(`${base}/mcp/call`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "definitely_not_a_tool", arguments: {} })
    }));
    expect(unknown.status).toBe(422);
    await expect(unknown.json()).resolves.toMatchObject({
      message: "Validation Failed",
      errors: [expect.objectContaining({ field: "tool", code: "invalid" })]
    });
  });
});
