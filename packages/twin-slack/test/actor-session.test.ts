import { beforeEach, describe, expect, it } from "vitest";
import { mintProviderToken } from "@pome-sh/sdk/server";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_AUTH_SECRET, TEST_SID, withAuth } from "./_authHelper.js";

// Provider-token minting goes through the engine (F-712 row 10).
const SLACK_TOKEN_SPEC = { provider: "slack", prefixes: ["xoxb-pome-", "xoxp-pome-"] } as const;
function signSlackProviderToken(sid: string, secret: string, prefix: "xoxb" | "xoxp" = "xoxb") {
  return mintProviderToken(SLACK_TOKEN_SPEC, { sid, secret, prefix: `${prefix}-pome-` });
}

const base = `/s/${TEST_SID}`;

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return { app: createSlackTwinApp({ db, domain, runId: "actor" }), db, domain };
}

describe("actor identity via JWT login claim", () => {
  let aliceToken: string;
  let bobToken: string;

  beforeEach(async () => {
    aliceToken = await signTestToken({ login: "alice" });
    bobToken = await signTestToken({ login: "bob" });
  });

  it("attributes chat.postMessage to alice when login claim is alice", async () => {
    const { app } = freshApp();
    const res = await app.request(
      `${base}/chat.postMessage`,
      withAuth(aliceToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C_GENERAL", text: "from alice" }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { user: string } };
    expect(body.message.user).toBe("U_ALICE");
  });

  it("bob cannot delete alice's message", async () => {
    const { app } = freshApp();
    const post = await app.request(
      `${base}/chat.postMessage`,
      withAuth(aliceToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C_GENERAL", text: "protected" }),
      })
    );
    const posted = (await post.json()) as { ts: string };
    const del = await app.request(
      `${base}/chat.delete`,
      withAuth(bobToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C_GENERAL", ts: posted.ts }),
      })
    );
    // Slack-shaped app errors return HTTP 200 with {ok:false, error}.
    expect(del.status).toBe(200);
    const body = (await del.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("cant_delete_message");
  });

  it("provider-shape token resolves to pome-agent via auth.test", async () => {
    const { app } = freshApp();
    const token = signSlackProviderToken(TEST_SID, TEST_AUTH_SECRET, "xoxb");
    const res = await app.request(`${base}/auth.test`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string; user: string };
    expect(body.user_id).toBe("U_PRIMARY");
    expect(body.user).toBe("pome-agent");
  });
});
