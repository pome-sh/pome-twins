// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  KNOWN_TWIN_IDS,
  MOUNTED_TWINS,
  createSessionResponseSchema,
  gmailSeedStateSchema,
  providerScopedSeedStateSchema,
  recorderEventSchema,
} from "../src/index.js";

const mailbox = {
  email: "POME-Agent@POME-TWIN.TEST",
  messages: [
    {
      id: "msg_seed",
      threadId: "thread_seed",
      from: "alice@example.com",
      to: ["pome-agent@pome-twin.test"],
      subject: "Seed message",
      text: "hello",
      labels: ["INBOX", "UNREAD"],
    },
  ],
};

describe("Gmail first-party registrations", () => {
  it("mounts and renders gmail under its canonical id", () => {
    expect(MOUNTED_TWINS).toEqual(["github", "stripe", "slack", "gmail"]);
    expect(KNOWN_TWIN_IDS).toEqual(["github", "stripe", "slack", "gmail"]);
  });
});

describe("gmailSeedStateSchema", () => {
  it("accepts canonical mailbox ids and normalizes email identity", () => {
    const parsed = gmailSeedStateSchema.parse({ primaryMailbox: mailbox });
    expect(parsed.primaryMailbox.email).toBe("pome-agent@pome-twin.test");
    expect(parsed.primaryMailbox.messages[0]).toMatchObject({
      id: "msg_seed",
      threadId: "thread_seed",
      labels: ["INBOX", "UNREAD"],
    });
    expect(parsed.deliveryMode).toBe("sender-only");
  });

  it("accepts gmail in the provider-scoped seed envelope", () => {
    expect(
      providerScopedSeedStateSchema.safeParse({
        gmail: { seed: { primaryMailbox: mailbox } },
      }).success,
    ).toBe(true);
  });
});

describe("Gmail tolerant readers", () => {
  it("keeps old session responses valid without Gmail provider credentials", () => {
    const parsed = createSessionResponseSchema.parse({
      session_id: "ses_old",
      twin_url: "https://api.pome.sh/gmail/ses_old",
      expires_at: "2099-01-01T00:00:00.000Z",
      agent_token: "edt_old",
      openapi_url: "https://api.pome.sh/gmail/ses_old/openapi.json",
    });
    expect(parsed.provider_credentials).toEqual({});
    expect(parsed.per_twin.gmail?.api_url).toContain("/gmail/");
  });

  it("still accepts legacy and community recorder twin ids", () => {
    const base = {
      ts: "2026-07-20T00:00:00.000Z",
      run_id: "run_1",
      request_id: "req_1",
      method: "GET",
      path: "/",
      request_body: null,
      status: 200,
      response_body: {},
      latency_ms: 1,
      fidelity: "semantic" as const,
      state_mutation: false,
      state_delta: null,
      step_id: null,
      tool_call_id: null,
      error: null,
    };
    expect(recorderEventSchema.parse({ ...base, twin: "github" }).twin).toBe("github");
    expect(recorderEventSchema.parse({ ...base, twin: "gmail" }).twin).toBe("gmail");
    expect(recorderEventSchema.parse({ ...base, twin: "community-mail" }).twin).toBe(
      "community-mail",
    );
  });
});
