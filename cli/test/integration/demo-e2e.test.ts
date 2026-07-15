// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — `pome demo` end-to-end against a STUB cloud: real runScenario
// (in-process github twin + real capture-server child), the REAL bundled
// demo agent spawned as `npx tsx src/cli/main.ts demo-agent`, and a scripted
// control plane serving mint / gateway (strict-schema-validated) /
// presigned uploads / finalize. Everything short of the real cloud + a real
// model — the founder's Phase G live run covers those.
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { runDemo } from "../../src/demo/runDemo.js";
import { captureServerForTests } from "../fixtures/captureServerForTests.js";
import { demoLlmRequestSchema } from "../fixtures/demo/demoLlmSchema.js";

interface StubCloud {
  server: Server;
  port: number;
  minted: Array<{ task_name: string; task_hash: string; group_id?: string }>;
  gatewayBodies: Array<{ sessionId: string; body: unknown; auth: string | undefined }>;
  putBodies: Map<string, string>;
  finalized: Array<{ sessionId: string; body: Record<string, unknown>; auth: string | undefined }>;
}

function scriptedGatewayTurn(turn: number): unknown {
  if (turn === 1) {
    return {
      text: "Listing the open issues.",
      tool_calls: [{ id: "c1", name: "list_open_issues", input: {} }],
      finish_reason: "tool-calls",
      usage: { input_tokens: 400, output_tokens: 30 },
    };
  }
  if (turn === 2) {
    return {
      text: "",
      tool_calls: [
        { id: "c2", name: "add_label", input: { issue_number: 1, label: "bug" } },
        {
          id: "c3",
          name: "comment_on_issue",
          input: {
            issue_number: 1,
            body: "POST /orders 500s since the 14:00 deploy — OrderController#create.",
          },
        },
      ],
      finish_reason: "tool-calls",
      usage: { input_tokens: 600, output_tokens: 60 },
    };
  }
  return {
    text: "Labeled #1 as bug and left one comment naming POST /orders.",
    tool_calls: [],
    finish_reason: "stop",
    usage: { input_tokens: 700, output_tokens: 25 },
  };
}

async function startStubCloud(): Promise<StubCloud> {
  const minted: StubCloud["minted"] = [];
  const gatewayBodies: StubCloud["gatewayBodies"] = [];
  const putBodies = new Map<string, string>();
  const finalized: StubCloud["finalized"] = [];
  const gatewayTurns = new Map<string, number>();
  let mintCount = 0;

  const server = createServer((req, res) => {
    // Collect as bytes: blob PUTs arrive gzipped (putBlob sets
    // content-encoding: gzip), so a utf8 string would mangle them. JSON POST
    // bodies are plaintext and decode from the same buffer.
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      const rawBuf = Buffer.concat(chunks);
      const raw = rawBuf.toString("utf8");
      const url = req.url ?? "";
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (req.method === "PUT" && url.startsWith("/put/")) {
        // Blob uploads are gzipped by putBlob; gunzip to store the real trace.
        putBodies.set(url, gunzipSync(rawBuf).toString("utf8"));
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === "POST" && url === "/v1/demo/sessions") {
        minted.push(JSON.parse(raw));
        mintCount += 1;
        json(201, {
          session_id: `ses_${mintCount}`,
          demo_token: `header.payload${mintCount}.sig`,
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
        return;
      }

      const llmMatch = url.match(/^\/v1\/demo\/sessions\/([^/]+)\/llm$/);
      if (req.method === "POST" && llmMatch) {
        const sessionId = llmMatch[1]!;
        const body = JSON.parse(raw);
        gatewayBodies.push({ sessionId, body, auth: req.headers.authorization });
        const parsed = demoLlmRequestSchema.safeParse(body);
        if (!parsed.success) {
          json(422, {
            error: {
              type: "validation_failed",
              message: `strict schema: ${JSON.stringify(parsed.error.issues)}`,
            },
          });
          return;
        }
        const turn = (gatewayTurns.get(sessionId) ?? 0) + 1;
        gatewayTurns.set(sessionId, turn);
        json(200, scriptedGatewayTurn(turn));
        return;
      }

      const uploadMatch = url.match(
        /^\/v1\/sessions\/([^/]+)\/(result-upload-url|state-upload-url|signals-upload-url)$/,
      );
      if (req.method === "POST" && uploadMatch) {
        const sessionId = uploadMatch[1]!;
        const route = uploadMatch[2]!;
        const base = `http://127.0.0.1:${port}`;
        if (route === "result-upload-url") {
          json(200, {
            url: `${base}/put/${sessionId}/events.jsonl`,
            key: `team-tm_demo_anonymous/session-${sessionId}/events.jsonl`,
          });
        } else if (route === "signals-upload-url") {
          json(200, {
            url: `${base}/put/${sessionId}/signals.jsonl`,
            key: `team-tm_demo_anonymous/session-${sessionId}/signals.jsonl`,
          });
        } else {
          json(200, {
            state_initial: {
              url: `${base}/put/${sessionId}/state_initial.json`,
              key: `team-tm_demo_anonymous/session-${sessionId}/state_initial.json`,
            },
            state_final: {
              url: `${base}/put/${sessionId}/state_final.json`,
              key: `team-tm_demo_anonymous/session-${sessionId}/state_final.json`,
            },
          });
        }
        return;
      }

      const finalizeMatch = url.match(/^\/v1\/sessions\/([^/]+)\/finalize$/);
      if (req.method === "POST" && finalizeMatch) {
        const sessionId = finalizeMatch[1]!;
        finalized.push({
          sessionId,
          body: JSON.parse(raw) as Record<string, unknown>,
          auth: req.headers.authorization,
        });
        json(201, {
          run_id: `run_${sessionId}`,
          score: 100,
          judge_model: "google/gemini-3.1-flash-lite",
          dashboard_url: `http://127.0.0.1:${port}/runs/run_${sessionId}`,
          criteria_results: [
            {
              criterion: { type: "P", text: "The bug label was applied." },
              outcome: "passed",
              passed: true,
              skipped: false,
              reason: "ok",
            },
          ],
        });
        return;
      }

      json(404, { error: { type: "not_found", message: `no stub for ${req.method} ${url}` } });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("no address"));
    });
  });

  return { server, port, minted, gatewayBodies, putBodies, finalized };
}

let cloud: StubCloud | null = null;
afterAll(async () => {
  if (cloud) {
    await new Promise<void>((resolve) => cloud!.server.close(() => resolve()));
  }
});

describe("pome demo end-to-end against a stub cloud (FDRS-643)", () => {
  it("mint → real capture path + real demo agent → upload → finalize → verdict lines + preview link", async () => {
    cloud = await startStubCloud();
    const artifactsDir = await mkdtemp(join(tmpdir(), "pome-demo-e2e-"));
    const out: string[] = [];

    const result = await runDemo({
      apiBase: `http://127.0.0.1:${cloud.port}`,
      dashboardBase: "https://app.pome.sh",
      trials: 2,
      artifactsDir,
      out: (line) => out.push(line),
      // Run from source under tsx, mirroring captureServerForTests's overrides.
      agentCommand: "npx tsx src/cli/main.ts demo-agent",
      captureServerCommand: captureServerForTests,
    });

    const text = out.join("\n");

    // Terminal shape (moment 01): reassurance frame → twin line → trials →
    // verdict words → summary fraction → no-login preview link.
    expect(text).toContain("No signup. No API keys.");
    expect(text).toMatch(/spinning up github twin … ready \(\d+\.\ds\)/);
    expect(text).toContain("running 2 isolated trials of first-run-demo …");
    expect(text).toMatch(/trial 1 {2}✓ {2}passed {3}\d+\.\ds/);
    expect(text).toMatch(/trial 2 {2}✓ {2}passed {3}\d+\.\ds/);
    expect(text).toContain("2 of 2 passed");
    expect(text).toContain(`→ https://app.pome.sh/demo/${result.groupId}`);
    expect(result.exitCode).toBe(0);

    // Mint: 2 sessions, one shared grp_ id, scenario-locked task name,
    // informational-empty hash.
    expect(cloud.minted).toHaveLength(2);
    for (const mint of cloud.minted) {
      expect(mint).toEqual({
        task_name: "first-run-demo",
        task_hash: "",
        group_id: result.groupId,
      });
    }

    // Gateway: every call carried the right session's demo_token and a
    // strict-schema-valid body (the stub 422s otherwise, which would have
    // errored the trials). 3 turns per trial.
    expect(cloud.gatewayBodies).toHaveLength(6);
    for (const call of cloud.gatewayBodies) {
      expect(call.auth).toBe(
        `Bearer header.payload${call.sessionId.replace("ses_", "")}.sig`,
      );
    }

    // The uploaded events.jsonl is the genuinely captured trace: the twin's
    // recorded REST calls (label + comment on issue #1) are in the blob.
    const eventsUploads = [...cloud.putBodies.entries()].filter(([key]) =>
      key.endsWith("/events.jsonl"),
    );
    expect(eventsUploads).toHaveLength(2);
    for (const [, body] of eventsUploads) {
      expect(body).toContain("TwinHttpEvent");
      expect(body).toContain("/repos/acme/api/issues/1/labels");
      expect(body).toContain("/repos/acme/api/issues/1/comments");
    }

    // Finalize: bearer demo_token, criteria [] (server-owned judge content),
    // scenario_name selecting the packaged task, storage-key overrides
    // pointing at the uploaded blobs.
    expect(cloud.finalized.map((f) => f.sessionId).sort()).toEqual(["ses_1", "ses_2"]);
    for (const call of cloud.finalized) {
      expect(call.auth).toMatch(/^Bearer header\.payload\d\.sig$/);
      expect(call.body.criteria).toEqual([]);
      expect(call.body.scenario_name).toBe("first-run-demo");
      expect(call.body.stop_reason).toBe("completed");
      expect(call.body.trace_storage_key).toBe(
        `team-tm_demo_anonymous/session-${call.sessionId}/events.jsonl`,
      );
      expect(call.body.state_initial_storage_key).toBe(
        `team-tm_demo_anonymous/session-${call.sessionId}/state_initial.json`,
      );
    }
  }, 120_000);
});
