// SPDX-License-Identifier: Apache-2.0
// FDRS-405 — overhead-gate agent. Run by `pome run` inside the CI overhead
// gate. Does enough twin work to produce ≥1 `TwinHttpEvent` (so the gate run
// also satisfies PR/FAQ acceptance #1's events.jsonl shape), then loops
// `OVERHEAD_BENCH_N` (default 100) TCP connections to a fixed upstream —
// via `HTTPS_PROXY` CONNECT tunnel when the env is set, direct TCP
// otherwise — emitting one `OVERHEAD_BENCH_SAMPLE_MS=<n>` line per iteration
// to stdout. The orchestrator (`cli/scripts/overhead-gate.ts`) reads
// `stdout.txt` from each run's artifact directory and computes the p99 delta.

import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";

type GitHubIssue = {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
};

if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

const N = Number.parseInt(process.env.OVERHEAD_BENCH_N ?? "100", 10);
const target = requiredEnv("POME_CAPTURE_TEST_TARGET");
const lastColon = target.lastIndexOf(":");
if (lastColon < 0) {
  console.error(`POME_CAPTURE_TEST_TARGET malformed: "${target}" (expected host:port)`);
  process.exit(1);
}
const targetHost = target.slice(0, lastColon);
const targetPort = Number.parseInt(target.slice(lastColon + 1), 10);
const httpsProxy = process.env.HTTPS_PROXY ?? "";

const baseUrl = requiredEnv("POME_GITHUB_REST_URL");
const authToken = process.env.POME_AUTH_TOKEN;

await main();

async function main(): Promise<void> {
  // Triage scenario 01 deterministically so the run passes the scenario's
  // acceptance criteria (issue #1 labeled `bug`, assigned to `alice`). This
  // mirrors `examples/agents/scripted-triage-agent.ts`'s logic for the
  // happy-path scenario — duplicated here rather than imported because the
  // bench agent is invoked as a standalone script under Node/tsx. Several
  // TwinHttpEvent rows fall out for the PR/FAQ-#1 events-shape assertion.
  await triageIssueOne();

  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    if (httpsProxy) {
      await connectViaProxy(httpsProxy, targetHost, targetPort);
    } else {
      await connectDirect(targetHost, targetPort);
    }
    const elapsed = performance.now() - t0;
    // Sample sentinel — gate orchestrator greps `OVERHEAD_BENCH_SAMPLE_MS=`
    // from the run's `stdout.txt`. Float precision is overkill but cheap.
    process.stdout.write(`OVERHEAD_BENCH_SAMPLE_MS=${elapsed.toFixed(4)}\n`);
  }

  // Final summary line for human-friendly grep without parsing all N rows.
  process.stdout.write(`OVERHEAD_BENCH_DONE n=${N} mode=${httpsProxy ? "proxy" : "direct"}\n`);
}

async function triageIssueOne(): Promise<void> {
  const issue = await twinJson<GitHubIssue>(`/repos/acme/api/issues/1`);
  const alreadyTriaged = issue.labels.find((l) => ["bug", "feature", "question"].includes(l.name));
  if (alreadyTriaged) return;
  await twinJson(`/repos/acme/api/issues/1/labels`, {
    method: "POST",
    body: { labels: ["bug"] },
  });
  await twinJson(`/repos/acme/api/issues/1/assignees`, {
    method: "POST",
    body: { assignees: ["alice"] },
  });
}

async function twinJson<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: authToken
      ? { Authorization: `Bearer ${authToken}`, ...(options.body ? { "content-type": "application/json" } : {}) }
      : options.body
        ? { "content-type": "application/json" }
        : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`twin ${options.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function connectDirect(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port });
    sock.once("connect", () => {
      sock.end();
    });
    sock.once("error", reject);
    sock.once("close", () => resolve());
  });
}

function connectViaProxy(
  proxyUrl: string,
  host: string,
  port: number,
): Promise<void> {
  const url = new URL(proxyUrl);
  const proxyHost = url.hostname;
  const proxyPort = Number.parseInt(url.port, 10) || 80;
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: proxyHost, port: proxyPort });
    let headerBuf = "";
    let headerDone = false;
    sock.once("error", reject);
    sock.once("close", () => resolve());
    sock.on("data", (chunk: Buffer) => {
      if (headerDone) return;
      headerBuf += chunk.toString("utf8");
      if (headerBuf.indexOf("\r\n\r\n") === -1) return;
      headerDone = true;
      if (!/^HTTP\/1\.[01] 200/.test(headerBuf)) {
        sock.destroy();
        reject(new Error(`CONNECT failed: ${headerBuf.slice(0, 80)}`));
        return;
      }
      // Close immediately on tunnel-established — we only care about the
      // CONNECT-tunnel setup time, not the bytes after.
      sock.end();
    });
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return v;
}
