import { beforeEach, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";
import { toolDefinitions } from "../src/tools.js";
import { signTestToken, TEST_SID, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return createSlackTwinApp({ db, domain, runId: "mcp-legacy" });
}

describe("legacy MCP routes", () => {
  let token: string;
  beforeEach(async () => {
    token = await signTestToken();
  });

  it("GET /mcp/tools lists 8 tools", async () => {
    const app = freshApp();
    const res = await app.request(`${base}/mcp/tools`, withAuth(token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string }> };
    expect(body.tools.map((t) => t.name).sort()).toEqual(toolDefinitions.map((t) => t.name).sort());
  });

  it("POST /mcp/call slack_list_channels succeeds", async () => {
    const app = freshApp();
    const res = await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "slack_list_channels", arguments: { limit: 2 } }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; channels: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.channels.length).toBe(2);
  });

  it("POST /mcp/call slack_post_message mutates channel", async () => {
    const app = freshApp();
    const res = await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "slack_post_message",
          arguments: { channel_id: "C_GENERAL", text: "via legacy mcp" },
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: string };
    expect(body.ok).toBe(true);
    expect(body.ts).toMatch(/^\d+\.\d{6}$/);
  });
});
