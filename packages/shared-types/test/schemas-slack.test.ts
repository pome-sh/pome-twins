// SPDX-License-Identifier: Apache-2.0
//
// Slack twin seed / credential surface. Ported from pome-cloud at FDRS-653 —
// the slack schemas already lived here; this brings over the coverage.
import { describe, expect, it } from "vitest";

import {
  MOUNTED_TWINS,
  createSessionResponseSchema,
  providerScopedSeedStateSchema,
  slackSeedStateSchema,
} from "../src/index.js";
import { KNOWN_TWIN_IDS } from "../src/recorder-events.js";

describe("MOUNTED_TWINS", () => {
  it("includes slack alongside github and stripe", () => {
    expect(MOUNTED_TWINS).toEqual(["github", "stripe", "slack"]);
  });
});

describe("KNOWN_TWIN_IDS", () => {
  it("includes slack for dashboard recorder pattern-matching", () => {
    expect(KNOWN_TWIN_IDS).toContain("slack");
  });
});

describe("slackSeedStateSchema", () => {
  it("accepts a minimal valid slack seed", () => {
    const parsed = slackSeedStateSchema.safeParse({
      team: { name: "Acme", domain: "acme-twin" },
      users: [{ name: "alice" }],
      channels: [{ name: "general", messages: [{ user: "U1", text: "hi" }] }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects channels without a valid name", () => {
    const parsed = slackSeedStateSchema.safeParse({
      channels: [{ name: "INVALID CHANNEL!" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("providerScopedSeedStateSchema", () => {
  it("accepts slack-only provider-scoped seed", () => {
    const parsed = providerScopedSeedStateSchema.safeParse({
      slack: {
        seed: {
          channels: [{ name: "general", messages: [{ user: "U1", text: "hi" }] }],
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects empty provider-scoped object", () => {
    const parsed = providerScopedSeedStateSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

describe("createSessionResponseSchema.provider_credentials.slack", () => {
  it("preserves slack credentials in parsed response", () => {
    const parsed = createSessionResponseSchema.safeParse({
      session_id: "ses_test",
      session_token: "ses_test",
      twin_url: "https://twins.pome.sh/s/ses_test",
      expires_at: "2099-01-01T00:00:00.000Z",
      agent_token: "eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJzZXNfdGVzdCJ9.sig",
      provider_credentials: {
        slack: {
          token: "xoxb-pome-c2VzX3Rlc3Q-abc",
          header: "Authorization",
          scheme: "Bearer",
        },
      },
      openapi_url: "https://twins.pome.sh/s/ses_test/_pome/health",
      per_twin: {
        slack: {
          api_url: "https://twins.pome.sh/s/ses_test",
          mcp_url: "https://mcp.pome.sh/s/ses_test/mcp",
          openapi_url: "https://twins.pome.sh/s/ses_test/_pome/health",
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider_credentials.slack?.token).toMatch(/^xoxb-pome-/);
    }
  });
});
