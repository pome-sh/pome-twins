// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_TOKEN,
  LinearDomain,
  createLinearTwinApp,
  defaultSeedState,
  openLinearTwinDatabase,
  type LinearStateSeed,
} from "../src/index.js";

const SECRET = "linear-webhooks-test-secret-32chars!";
let receiver: Server;
let receiverUrl: string;
let deliveries: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = [];

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  // The test receiver binds 127.0.0.1; opt in to loopback delivery (the SSRF
  // default-deny policy blocks it otherwise — covered by webhook-policy.test.ts).
  process.env.LINEAR_TWIN_ALLOW_PRIVATE_WEBHOOKS = "1";
  receiver = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      deliveries.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address() as AddressInfo;
  receiverUrl = `http://127.0.0.1:${address.port}/hooks`;
});

afterAll(async () => {
  delete process.env.LINEAR_TWIN_ALLOW_PRIVATE_WEBHOOKS;
  if (receiver) {
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

function seedWithoutWebhooks(): LinearStateSeed {
  const base = defaultSeedState();
  return { ...base, webhooks: [] };
}

async function graphql(
  app: ReturnType<typeof createLinearTwinApp>,
  query: string,
  variables?: Record<string, unknown>
) {
  const response = await app.request("/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { data?: Record<string, unknown>; errors?: unknown[] },
  };
}

describe("Linear webhooks", () => {
  it("creates a webhook, delivers on issue mutate, and logs delivery", async () => {
    deliveries = [];
    const db = openLinearTwinDatabase(":memory:");
    const app = createLinearTwinApp({
      db,
      seed: seedWithoutWebhooks(),
      runId: "webhooks-test",
    });

    const createdHook = await graphql(
      app,
      `mutation($input: WebhookCreateInput!) {
        webhookCreate(input: $input) { success webhook { id url } }
      }`,
      {
        input: {
          url: receiverUrl,
          label: "Test hook",
          resourceTypes: ["Issue"],
          teamId: "team_eng",
          secret: "whsec_local",
        },
      }
    );
    expect(createdHook.body.errors).toBeUndefined();
    const webhookId = (
      createdHook.body.data?.webhookCreate as { webhook: { id: string } }
    ).webhook.id;

    const createdIssue = await graphql(
      app,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { id identifier } }
      }`,
      { input: { teamId: "team_eng", title: "Webhook trigger" } }
    );
    expect(createdIssue.body.errors).toBeUndefined();

    // Allow the async fetch to complete.
    for (let i = 0; i < 20 && deliveries.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0]!.headers["linear-event"]).toBe("Issue");
    expect(deliveries[0]!.body).toContain("Webhook trigger");

    const commands = new LinearDomain(db);
    const state = commands.exportState();
    const logged = state.webhookDeliveries as Array<{ webhookId: string; event: string }>;
    expect(logged.some((row) => row.webhookId === webhookId && row.event === "Issue")).toBe(true);
  });

  it("rejects non-http webhook URLs and credentials in the URL", () => {
    const db = openLinearTwinDatabase(":memory:");
    const commands = new LinearDomain(db);
    commands.seed(seedWithoutWebhooks());
    expect(() => commands.createWebhook({ url: "file:///tmp/hooks" })).toThrow(
      /http or https/i
    );
    expect(() =>
      commands.createWebhook({ url: "http://user:secret@127.0.0.1:9/hooks" })
    ).toThrow(/credentials/i);
  });

  it("default-deny: refuses delivery to internal destinations (SSRF guard)", async () => {
    deliveries = [];
    delete process.env.LINEAR_TWIN_ALLOW_PRIVATE_WEBHOOKS;
    try {
      const db = openLinearTwinDatabase(":memory:");
      const commands = new LinearDomain(db);
      commands.seed(seedWithoutWebhooks());
      // Cloud metadata endpoint — a classic SSRF target.
      commands.createWebhook({
        url: "http://169.254.169.254/latest/meta-data/",
        resourceTypes: ["Issue"],
        teamId: "team_eng",
      });
      await commands.createIssue(
        { teamId: "team_eng", title: "Should never leave the process" },
        { email: "admin@pome-twin.test" }
      );

      const logged = commands.exportState().webhookDeliveries as Array<{
        error: string | null;
        status: number | null;
      }>;
      expect(logged.length).toBe(1);
      expect(logged[0]!.error).toBe("blocked_destination");
      expect(logged[0]!.status).toBeNull();
      expect(deliveries.length).toBe(0);
    } finally {
      process.env.LINEAR_TWIN_ALLOW_PRIVATE_WEBHOOKS = "1";
    }
  });

  it("records an error when the webhook URL redirects (no follow)", async () => {
    deliveries = [];
    let redirectServer: Server | undefined;
    try {
      redirectServer = createServer((_req, res) => {
        res.writeHead(302, { Location: receiverUrl });
        res.end();
      });
      await new Promise<void>((resolve) => redirectServer!.listen(0, "127.0.0.1", resolve));
      const redirectUrl = `http://127.0.0.1:${(redirectServer.address() as AddressInfo).port}/redir`;

      const db = openLinearTwinDatabase(":memory:");
      const commands = new LinearDomain(db);
      commands.seed(seedWithoutWebhooks());
      commands.createWebhook({
        url: redirectUrl,
        resourceTypes: ["Issue"],
        teamId: "team_eng",
      });
      await commands.createIssue(
        { teamId: "team_eng", title: "Redirect should fail closed" },
        { email: "admin@pome-twin.test" }
      );

      for (let i = 0; i < 20; i += 1) {
        const logged = commands.exportState().webhookDeliveries as Array<{
          error: string | null;
          status: number | null;
        }>;
        if (logged.some((row) => row.error)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const logged = commands.exportState().webhookDeliveries as Array<{
        error: string | null;
        status: number | null;
      }>;
      expect(logged.some((row) => typeof row.error === "string" && row.error.length > 0)).toBe(
        true
      );
      expect(deliveries.length).toBe(0);
    } finally {
      if (redirectServer) {
        await new Promise<void>((resolve, reject) =>
          redirectServer!.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  });

  it("returns 501 for unsupported routes without side effects", async () => {
    const db = openLinearTwinDatabase(":memory:");
    const app = createLinearTwinApp({
      db,
      seed: seedWithoutWebhooks(),
      runId: "webhooks-501",
    });
    const before = (
      db.prepare("SELECT COUNT(*) AS count FROM issues").get() as { count: number }
    ).count;

    const response = await app.request("/unsupported/linear/path", {
      method: "POST",
      headers: {
        authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "should not persist" }),
    });
    expect(response.status).toBe(501);
    const after = (
      db.prepare("SELECT COUNT(*) AS count FROM issues").get() as { count: number }
    ).count;
    expect(after).toBe(before);
  });
});
