// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { createRecorderStore } from "@pome-sh/sdk/server";
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  createLinearTwinApp,
  openLinearTwinDatabase,
  type LinearStateSeed,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

const SID = DEFAULT_LINEAR_SID;
const SECRET = "linear-canary-matrix-secret-32!!";
const OAUTH_CANARY = "CANARY-OAUTH-CLIENT-SECRET-9f3a-linear";
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  token = await sign(
    {
      sid: SID,
      team_id: "team_canary",
      linear_email: DEFAULT_LINEAR_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SECRET
  );
});

function canarySeed(): LinearStateSeed {
  return testSeed({
    oauthApps: [
      {
        id: "oauth_canary",
        clientId: "lin_canary_client",
        clientSecret: OAUTH_CANARY,
        name: "Canary App",
        redirectUris: ["http://localhost:3000/callback"],
        scopes: ["read", "write", "issues:create", "comments:create", "admin"],
        actor: "app",
        assignable: true,
        mentionable: true,
        appUserId: "user_agent",
      },
    ],
  });
}

describe("canary matrix across recorder sinks", () => {
  it("keeps seeded oauth client_secret canary out of /_pome/state and events after oauth/token", async () => {
    const recorder = createRecorderStore();
    const db = openLinearTwinDatabase(":memory:");
    const app = createLinearTwinApp({
      db,
      seed: canarySeed(),
      recorder,
      runId: "canary-matrix",
    });

    const tokenRes = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "lin_canary_client",
        client_secret: OAUTH_CANARY,
        scope: "read write",
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const issued = (await tokenRes.json()) as { access_token: string };
    expect(issued.access_token).toBeTruthy();

    const stateRes = await app.request(`/s/${SID}/_pome/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stateRes.status).toBe(200);
    const stateText = await stateRes.text();
    expect(stateText).not.toContain(OAUTH_CANARY);

    const eventsRes = await app.request(`/s/${SID}/_pome/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(eventsRes.status).toBe(200);
    const eventsText = await eventsRes.text();
    expect(eventsText).not.toContain(OAUTH_CANARY);
    expect(JSON.stringify(recorder.events())).not.toContain(OAUTH_CANARY);
    // Public OAuth is mounted outside recorder.handle — token grant must not
    // appear as a GraphQL/MCP mutation event carrying the client secret.
    expect(
      recorder.events().some((event) => event.path === "/oauth/token" && event.state_mutation)
    ).toBe(false);
  });
});
