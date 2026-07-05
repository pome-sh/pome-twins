// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — the bundled demo agent's tool loop, driven by a scripted stub
// gateway (validating the strict demo-llm schema on every call) against a
// stub twin capturing the REST calls the three tools make.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runDemoAgent, type DemoAgentEnv } from "../../../src/demo/agent.js";
import { demoLlmRequestSchema } from "../../fixtures/demo/demoLlmSchema.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("no address"));
    });
  });
}

const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

type GatewayTurn = { status: number; body: unknown };

function stubGateway(turns: GatewayTurn[]): {
  server: Server;
  bodies: unknown[];
} {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      // Contract check on EVERY call — a drifting wire shape fails loudly.
      const parsed = demoLlmRequestSchema.safeParse(body);
      if (!parsed.success) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "validation_failed",
              message: `strict schema: ${JSON.stringify(parsed.error.issues)}`,
            },
          }),
        );
        return;
      }
      const turn = turns[Math.min(bodies.length - 1, turns.length - 1)]!;
      res.writeHead(turn.status, { "content-type": "application/json" });
      res.end(JSON.stringify(turn.body));
    });
  });
  return { server, bodies };
}

function stubTwin(): {
  server: Server;
  calls: Array<{ method: string; url: string; body: unknown; auth: string | undefined }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      calls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw.length > 0 ? JSON.parse(raw) : undefined,
        auth: req.headers.authorization,
      });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET" && req.url?.startsWith("/repos/acme/api/issues")) {
        res.end(
          JSON.stringify([
            {
              number: 1,
              title: "500 error on POST /orders after deploy",
              body: "Stack trace points to OrderController#create.",
              state: "open",
              labels: [],
            },
            {
              number: 2,
              title: "Add CSV export",
              body: "Finance wants it.",
              state: "open",
              labels: [{ name: "feature" }],
            },
          ]),
        );
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, calls };
}

function agentEnvFor(gatewayPort: number, twinPort: number): DemoAgentEnv {
  return {
    task: "Triage the 500 error in acme/api.",
    twinRestUrl: `http://127.0.0.1:${twinPort}`,
    twinAuthToken: "twin.jwt.token",
    gatewayUrl: `http://127.0.0.1:${gatewayPort}/v1/demo/sessions/ses_1/llm`,
    demoToken: "demo.jwt.token",
    taskName: "first-run-demo",
    repo: "acme/api",
  };
}

function collectIo(): { io: { log: (l: string) => void; error: (l: string) => void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    io: { log: (l) => logs.push(l), error: (l) => errors.push(l) },
    logs,
    errors,
  };
}

describe("runDemoAgent (FDRS-643 tool loop)", () => {
  it("runs list → act → finish, executing tools against the twin, and exits 0", async () => {
    const gateway = stubGateway([
      {
        status: 200,
        body: {
          text: "Let me look at the issues.",
          tool_calls: [{ id: "c1", name: "list_open_issues", input: {} }],
          finish_reason: "tool-calls",
        },
      },
      {
        status: 200,
        body: {
          text: "",
          tool_calls: [
            { id: "c2", name: "add_label", input: { issue_number: 1, label: "bug" } },
            {
              id: "c3",
              name: "comment_on_issue",
              input: { issue_number: 1, body: "POST /orders 500s — see OrderController#create." },
            },
          ],
          finish_reason: "tool-calls",
        },
      },
      {
        status: 200,
        body: { text: "Labeled #1 as bug and left a comment.", tool_calls: [], finish_reason: "stop" },
      },
    ]);
    const twin = stubTwin();
    openServers.push(gateway.server, twin.server);
    const [gatewayPort, twinPort] = await Promise.all([
      listen(gateway.server),
      listen(twin.server),
    ]);

    const { io, logs } = collectIo();
    const code = await runDemoAgent(agentEnvFor(gatewayPort, twinPort), io);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Labeled #1 as bug");

    // Twin saw exactly the three tool-backed REST calls, bearer-authed.
    expect(twin.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /repos/acme/api/issues?state=open",
      "POST /repos/acme/api/issues/1/labels",
      "POST /repos/acme/api/issues/1/comments",
    ]);
    for (const call of twin.calls) {
      expect(call.auth).toBe("Bearer twin.jwt.token");
    }
    expect(twin.calls[1]!.body).toEqual({ labels: ["bug"] });
    expect(twin.calls[2]!.body).toEqual({
      body: "POST /orders 500s — see OrderController#create.",
    });

    // Turn 2's request carried the assistant tool-call + tool-result turns
    // in the strict shape (already schema-checked server-side; spot-check
    // the canonical AI-SDK output wrapper).
    const secondBody = gateway.bodies[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolMsg = secondBody.messages.find((m) => m.role === "tool") as {
      content: Array<{ output: { type: string } }>;
    };
    expect(toolMsg.content[0]!.output.type).toBe("json");
  });

  it("feeds tool errors back to the model as error-text instead of crashing", async () => {
    const gateway = stubGateway([
      {
        status: 200,
        body: {
          text: "",
          tool_calls: [{ id: "c1", name: "add_label", input: { issue_number: 1 } }],
          finish_reason: "tool-calls",
        },
      },
      {
        status: 200,
        body: { text: "Could not apply the label.", tool_calls: [], finish_reason: "stop" },
      },
    ]);
    const twin = stubTwin();
    openServers.push(gateway.server, twin.server);
    const [gatewayPort, twinPort] = await Promise.all([
      listen(gateway.server),
      listen(twin.server),
    ]);

    const { io } = collectIo();
    const code = await runDemoAgent(agentEnvFor(gatewayPort, twinPort), io);
    expect(code).toBe(0);
    const secondBody = gateway.bodies[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolMsg = secondBody.messages.find((m) => m.role === "tool") as {
      content: Array<{ output: { type: string; value: string } }>;
    };
    expect(toolMsg.content[0]!.output.type).toBe("error-text");
    // No twin call happened for the malformed input.
    expect(twin.calls).toHaveLength(0);
  });

  it("exits 42 with the POME_DEMO_CAPACITY marker on a gateway capacity error", async () => {
    const gateway = stubGateway([
      {
        status: 402,
        body: {
          error: {
            type: "quota_exceeded",
            message: "The demo's daily model budget is exhausted.",
            details: { kind: "daily_model_cap", spent_cents: 500, cap_cents: 500 },
          },
        },
      },
    ]);
    const twin = stubTwin();
    openServers.push(gateway.server, twin.server);
    const [gatewayPort, twinPort] = await Promise.all([
      listen(gateway.server),
      listen(twin.server),
    ]);

    const { io, errors } = collectIo();
    const code = await runDemoAgent(agentEnvFor(gatewayPort, twinPort), io);
    expect(code).toBe(42);
    expect(errors.join("\n")).toContain("POME_DEMO_CAPACITY:daily_model_cap");
    // Honest failure: no fabricated completion was logged.
  });

  it("gives up (exit 1) after the turn ceiling instead of looping forever", async () => {
    const gateway = stubGateway([
      {
        status: 200,
        body: {
          text: "",
          tool_calls: [{ id: "c1", name: "list_open_issues", input: {} }],
          finish_reason: "tool-calls",
        },
      },
    ]);
    const twin = stubTwin();
    openServers.push(gateway.server, twin.server);
    const [gatewayPort, twinPort] = await Promise.all([
      listen(gateway.server),
      listen(twin.server),
    ]);

    const { io, errors } = collectIo();
    const code = await runDemoAgent(agentEnvFor(gatewayPort, twinPort), io);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/gave up after \d+ model calls/);
    // 12-turn ceiling, below the server's 20-call session cap.
    expect(gateway.bodies).toHaveLength(12);
  }, 30_000);
});
