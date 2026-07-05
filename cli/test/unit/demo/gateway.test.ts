// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — the demo gateway client against a stub server that validates
// the STRICT demo-llm wire schema (mirrored from pome-cloud demo-llm.ts).
// Also proves the CONNECT-proxy path: through a capture-server-shaped
// CONNECT proxy, the same request arrives intact.
import { createServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { callDemoGateway, type DemoMessage } from "../../../src/demo/gateway.js";
import { DemoCapacityError } from "../../../src/demo/capacity.js";
import { demoLlmRequestSchema } from "../../fixtures/demo/demoLlmSchema.js";

type SeenRequest = {
  url: string;
  authorization: string | undefined;
  body: unknown;
};

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

function stubGateway(
  respond: (seen: SeenRequest) => { status: number; body: unknown },
): { server: Server; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const record: SeenRequest = {
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: JSON.parse(raw),
      };
      seen.push(record);
      const { status, body } = respond(record);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return { server, seen };
}

// Minimal CONNECT proxy (capture-server-shaped): tunnels opaque bytes.
function stubConnectProxy(): {
  server: Server;
  tunnels: Array<{ host: string; port: number }>;
} {
  const tunnels: Array<{ host: string; port: number }> = [];
  const server = createServer();
  server.on("connect", (req, clientSocket: Socket, head) => {
    const [host, portRaw] = String(req.url).split(":");
    const port = Number(portRaw);
    tunnels.push({ host: host!, port });
    const upstream = netConnect({ host: host!, port }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return { server, tunnels };
}

const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

const CONVERSATION: DemoMessage[] = [
  { role: "user", content: "Triage the repo." },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Listing issues." },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "list_open_issues",
        input: {},
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "list_open_issues",
        output: { type: "json", value: [{ number: 1, title: "500 error" }] },
      },
    ],
  },
];

describe("callDemoGateway (FDRS-643 / FDRS-637 wire contract)", () => {
  it("sends a STRICT schema-valid body (no system role, no model field) with the demo_token bearer", async () => {
    const { server, seen } = stubGateway(() => ({
      status: 200,
      body: {
        text: "",
        tool_calls: [
          { id: "call_2", name: "add_label", input: { issue_number: 1, label: "bug" } },
        ],
        finish_reason: "tool-calls",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    }));
    openServers.push(server);
    const port = await listen(server);

    const response = await callDemoGateway({
      gatewayUrl: `http://127.0.0.1:${port}/v1/demo/sessions/ses_1/llm`,
      demoToken: "aaa.bbb.ccc",
      taskName: "first-run-demo",
      messages: CONVERSATION,
      tools: [
        {
          name: "add_label",
          description: "Apply an existing label.",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/demo/sessions/ses_1/llm");
    expect(seen[0]!.authorization).toBe("Bearer aaa.bbb.ccc");
    // The lock: the body must parse under the server's strict schema.
    const parsed = demoLlmRequestSchema.safeParse(seen[0]!.body);
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
    const bodyObj = seen[0]!.body as Record<string, unknown>;
    expect(bodyObj.model).toBeUndefined();
    expect(
      (bodyObj.messages as Array<{ role: string }>).some((m) => m.role === "system"),
    ).toBe(false);

    expect(response.tool_calls).toEqual([
      { id: "call_2", name: "add_label", input: { issue_number: 1, label: "bug" } },
    ]);
    expect(response.finish_reason).toBe("tool-calls");
  });

  it("maps gateway 429 session_llm_call_cap to DemoCapacityError", async () => {
    const { server } = stubGateway(() => ({
      status: 429,
      body: {
        error: {
          type: "rate_limited",
          message: "This demo trial hit its model-call ceiling.",
          details: { kind: "session_llm_call_cap", used: 20, cap: 20 },
        },
      },
    }));
    openServers.push(server);
    const port = await listen(server);

    const err = await callDemoGateway({
      gatewayUrl: `http://127.0.0.1:${port}/v1/demo/sessions/ses_1/llm`,
      demoToken: "aaa.bbb.ccc",
      taskName: "first-run-demo",
      messages: [{ role: "user", content: "hi" }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DemoCapacityError);
    expect((err as DemoCapacityError).kind).toBe("session_llm_call_cap");
  });

  it("maps gateway 402 daily_model_cap to DemoCapacityError", async () => {
    const { server } = stubGateway(() => ({
      status: 402,
      body: {
        error: {
          type: "quota_exceeded",
          message: "The demo's daily model budget is exhausted.",
          details: { kind: "daily_model_cap", spent_cents: 500, cap_cents: 500 },
        },
      },
    }));
    openServers.push(server);
    const port = await listen(server);

    const err = await callDemoGateway({
      gatewayUrl: `http://127.0.0.1:${port}/v1/demo/sessions/ses_1/llm`,
      demoToken: "aaa.bbb.ccc",
      taskName: "first-run-demo",
      messages: [{ role: "user", content: "hi" }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DemoCapacityError);
    expect((err as DemoCapacityError).kind).toBe("daily_model_cap");
  });

  it("travels through an HTTP CONNECT proxy intact (the capture path)", async () => {
    const { server: gateway, seen } = stubGateway(() => ({
      status: 200,
      body: { text: "done", tool_calls: [], finish_reason: "stop" },
    }));
    const proxy = stubConnectProxy();
    openServers.push(gateway, proxy.server);
    const gatewayPort = await listen(gateway);
    const proxyPort = await listen(proxy.server);

    const response = await callDemoGateway({
      gatewayUrl: `http://127.0.0.1:${gatewayPort}/v1/demo/sessions/ses_1/llm`,
      demoToken: "aaa.bbb.ccc",
      taskName: "first-run-demo",
      messages: [{ role: "user", content: "hi" }],
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      // Loopback would normally bypass the proxy — force it so the test
      // exercises the tunnel path production uses for api.pome.sh.
      forceProxyForTest: true,
    });

    expect(response.text).toBe("done");
    expect(proxy.tunnels).toEqual([{ host: "127.0.0.1", port: gatewayPort }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBe("Bearer aaa.bbb.ccc");
    expect(demoLlmRequestSchema.safeParse(seen[0]!.body).success).toBe(true);
  });
});
