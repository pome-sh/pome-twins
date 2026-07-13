import { describe, it, expect } from "vitest";
import {
  createSessionResponseSchema,
  type CreateSessionResponse,
} from "@pome-sh/shared-types";
import { buildAgentEnv } from "../../../src/runner/runScenarioHosted.js";
import { rawBodyHadPerTwin } from "../../../src/hosted/client.js";

// Regression: single-twin runs against an OLD cloud (no `per_twin` in the wire
// body) must stay BYTE-IDENTICAL to origin/main's hosted env. The schema
// synthesizes a `per_twin` entry whose `mcp_url` host-rewrites
// api.pome.sh→mcp.pome.sh with NO `/mcp` suffix; the fan-out must NOT trust
// that synthesized value and must fall back to `${twin_url}/mcp`, exactly as
// main did. It must also keep injecting the github + stripe vars unconditionally
// (main set them on every hosted run regardless of twin).

const AGENT_TOKEN = "edt_fake.jwt.token";
const GITHUB_PROVIDER_TOKEN = "ght_provider_x";
const EXPIRES_AT = "2026-05-11T00:10:00.000Z";
const TWIN_URL = "https://api.pome.sh/github/s/ses_old";
const OPENAPI_URL = "https://api.pome.sh/github/openapi.json";

const ENV_SCAFFOLD = {
  prompt: "Do the thing.",
  otlpEndpoint: "http://127.0.0.1:9/v1/sessions/ses_old/traces",
  apiKey: "pme_test",
  agentId: "agt_test",
  runId: "ses_old",
  artifactsDir: "runs",
  slug: "scn",
  signalsPath: "/tmp/signals.jsonl",
} as const;

/** Reproduce the env origin/main produced for a single-twin github session —
 *  the acceptance bar for byte-identity. Mirrors main's env object literal
 *  (keys AND insertion order) exactly. */
function originMainEnv(session: CreateSessionResponse): Record<string, string> {
  const { agentId, runId } = ENV_SCAFFOLD;
  return {
    POME_TASK: ENV_SCAFFOLD.prompt,
    POME_TWIN_NAMES: "github",
    POME_OTEL_EXPORTER_OTLP_ENDPOINT: ENV_SCAFFOLD.otlpEndpoint,
    POME_OTEL_EXPORTER_OTLP_HEADERS: `x-api-key=${ENV_SCAFFOLD.apiKey}`,
    OTEL_SERVICE_NAME: agentId,
    OTEL_RESOURCE_ATTRIBUTES: `pome.session_id=${session.session_id},pome.run_id=${runId},pome.agent_id=${agentId}`,
    POME_TWIN_BASE_URL: session.twin_url,
    POME_GITHUB_REST_URL: session.twin_url,
    POME_GITHUB_MCP_URL: `${session.twin_url}/mcp`,
    POME_GITHUB_TOKEN:
      session.provider_credentials.github?.token ?? session.agent_token,
    POME_STRIPE_API_BASE: session.twin_url,
    POME_STRIPE_API_KEY: session.agent_token,
    POME_AUTH_TOKEN: session.agent_token,
    POME_RUN_ID: runId,
    POME_ARTIFACTS_DIR: `runs/scn/${runId}`,
    POME_ADAPTER_SIGNALS_PATH: ENV_SCAFFOLD.signalsPath,
  };
}

function oldCloudBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "ses_old",
    // NOTE: no session_token, no per_twin — the schema synthesizes both.
    twin_url: TWIN_URL,
    expires_at: EXPIRES_AT,
    agent_token: AGENT_TOKEN,
    openapi_url: OPENAPI_URL,
    provider_credentials: {
      github: {
        token: GITHUB_PROVIDER_TOKEN,
        header: "Authorization",
        scheme: "Bearer",
      },
    },
    ...extra,
  };
}

describe("buildAgentEnv — single-twin old-cloud byte-identity", () => {
  it("omitted per_twin: POME_GITHUB_MCP_URL === twin_url + '/mcp' (not the mcp.pome.sh synthesis)", () => {
    const raw = oldCloudBody();
    // The schema synthesizes per_twin.github.mcp_url as the mcp.pome.sh host
    // rewrite — the value we must NOT leak into the agent env.
    const session = createSessionResponseSchema.parse(raw);
    expect(session.per_twin.github?.mcp_url).toBe(
      "https://mcp.pome.sh/github/s/ses_old",
    );
    // Client stamps perTwinFromCloud=false for a body with no per_twin key.
    expect(rawBodyHadPerTwin(raw)).toBe(false);

    const env = buildAgentEnv({
      session,
      twins: ["github"],
      perTwinFromCloud: rawBodyHadPerTwin(raw),
      ...ENV_SCAFFOLD,
    });

    expect(env.POME_GITHUB_MCP_URL).toBe(`${TWIN_URL}/mcp`);
    expect(env.POME_GITHUB_MCP_URL).not.toContain("mcp.pome.sh");
  });

  it("omitted per_twin: FULL env is byte-identical to origin/main (values + key order)", () => {
    const raw = oldCloudBody();
    const session = createSessionResponseSchema.parse(raw);
    const env = buildAgentEnv({
      session,
      twins: ["github"],
      perTwinFromCloud: rawBodyHadPerTwin(raw),
      ...ENV_SCAFFOLD,
    });

    const expected = originMainEnv(session);
    expect(env).toEqual(expected);
    // Insertion order matters for byte-identity of any serialized env dump.
    expect(Object.keys(env)).toEqual(Object.keys(expected));
    // Stripe vars injected unconditionally even for a github-only session.
    expect(env.POME_STRIPE_API_BASE).toBe(TWIN_URL);
    expect(env.POME_STRIPE_API_KEY).toBe(AGENT_TOKEN);
  });

  it("empty per_twin ({}): FULL env is byte-identical to the omitted-per_twin case", () => {
    const rawEmpty = oldCloudBody({ per_twin: {} });
    const sessionEmpty = createSessionResponseSchema.parse(rawEmpty);
    // Empty per_twin still counts as cloud-returned, but there is no github
    // entry to trust — so the fan-out falls back to `${twin_url}/mcp` anyway.
    expect(rawBodyHadPerTwin(rawEmpty)).toBe(true);
    const envEmpty = buildAgentEnv({
      session: sessionEmpty,
      twins: ["github"],
      perTwinFromCloud: rawBodyHadPerTwin(rawEmpty),
      ...ENV_SCAFFOLD,
    });

    const rawOmitted = oldCloudBody();
    const sessionOmitted = createSessionResponseSchema.parse(rawOmitted);
    const envOmitted = buildAgentEnv({
      session: sessionOmitted,
      twins: ["github"],
      perTwinFromCloud: rawBodyHadPerTwin(rawOmitted),
      ...ENV_SCAFFOLD,
    });

    expect(envEmpty).toEqual(envOmitted);
    expect(envEmpty).toEqual(originMainEnv(sessionEmpty));
  });

  it("new cloud with real per_twin: trusts mcp_url + applies ensureMcpSuffix", () => {
    const raw = oldCloudBody({
      per_twin: {
        github: {
          api_url: "https://api.pome.sh/github/s/ses_new",
          // No /mcp suffix on the wire — ensureMcpSuffix must append it.
          mcp_url: "https://mcp.pome.sh/github/s/ses_new",
          openapi_url: "https://api.pome.sh/github/openapi.json",
        },
      },
    });
    const session = createSessionResponseSchema.parse(raw);
    expect(rawBodyHadPerTwin(raw)).toBe(true);
    const env = buildAgentEnv({
      session,
      twins: ["github"],
      perTwinFromCloud: rawBodyHadPerTwin(raw),
      ...ENV_SCAFFOLD,
    });
    expect(env.POME_GITHUB_REST_URL).toBe("https://api.pome.sh/github/s/ses_new");
    expect(env.POME_GITHUB_MCP_URL).toBe(
      "https://mcp.pome.sh/github/s/ses_new/mcp",
    );
  });
});
