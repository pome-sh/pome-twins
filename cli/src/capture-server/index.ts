// SPDX-License-Identifier: Apache-2.0
// FDRS-406 — HTTP CONNECT-tunnel proxy that emits one `LlmCallEvent` row per
// tunnel into `events.jsonl`. Spawned by `pome run` (FDRS-399) as a child
// process; agent traffic flows through it via `HTTPS_PROXY`.
//
// Mode: CONNECT-only (no TLS termination). The proxy never sees plaintext
// request/response bodies — the inner bytes are TLS-encrypted and forwarded
// opaquely. That is the v1 deliberate trade-off (PR/FAQ §Why; M0 milestone):
// zero-config trace baseline (host / port / latency / bytes) for ANY agent
// with no CA install, no SDK patch. Per-call token / model / cost arrive in
// v2's opt-in TLS-terminate mode.

import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer as createHttpServer, type Server, type IncomingMessage } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { dirname } from "node:path";
import { redactEvent } from "../recorder/redaction.js";

export interface CaptureServerOptions {
  port: number; // 0 = ephemeral
  eventsOut: string;
}

export interface CaptureServerHandle {
  port: number;
  // Resolves once all in-flight tunnel events have been written. Tests call
  // this after closing the client socket to synchronize with the disk write.
  flush: () => Promise<void>;
  // Drain in-flight tunnels, stop the listener, flush pending writes, close
  // the file. Idempotent.
  close: () => Promise<void>;
}

// Mirror of `llmCallEventSchema` in `packages/shared-types/src/recorder-events.ts`
// (locked by FDRS-398). The cli vendors shared-types at 0.3.0 which predates
// the unified discriminated-union schema, so the shape lives here as a
// structural mirror. Bumping the vendored tarball is a separate ticket — the
// on-disk JSON is what matters for downstream consumers, and that stays in
// lockstep with the canonical Zod schema. Any field added there must be added
// here in the same PR.
interface LlmCallEventRow {
  ts: string;
  event_id: string;
  parent_id: null;
  kind: "LlmCallEvent";
  host: string;
  port: number;
  latency_ms: number;
  bytes_in: number;
  bytes_out: number;
  // TLS-terminate-only fields stay explicit `null` in baseline mode so the
  // on-disk row shape is stable across modes.
  url: null;
  method: null;
  status: null;
  model: null;
  prompt_tokens: null;
  completion_tokens: null;
  cost_usd: null;
}

export async function runCaptureServer(
  options: CaptureServerOptions,
): Promise<CaptureServerHandle> {
  await mkdir(dirname(options.eventsOut), { recursive: true });
  const writer = createWriteStream(options.eventsOut, { flags: "a" });

  const pendingWrites = new Set<Promise<void>>();
  const liveSockets = new Set<Socket>();
  let shuttingDown = false;

  const server = createHttpServer((_req, res) => {
    // Anything other than CONNECT is a misconfiguration on the client side.
    // 405 is unambiguous; 426 (Upgrade Required) would be misleading since we
    // don't speak HTTP/2.
    res.writeHead(405, { "content-type": "text/plain", connection: "close" });
    res.end("pome capture-server accepts CONNECT only\n");
  });

  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    handleConnect({ req, clientSocket, head, writer, liveSockets, pendingWrites });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : options.port;

  const flush = async (): Promise<void> => {
    while (pendingWrites.size > 0) {
      await Promise.all([...pendingWrites]);
    }
  };

  const close = async (): Promise<void> => {
    if (shuttingDown) {
      await flush();
      return;
    }
    shuttingDown = true;
    // Stop accepting new connections first so we don't grow the in-flight set
    // while draining.
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Destroy in-flight sockets so their `close` handlers fire and finalize
    // writes the trailing LlmCallEvent rows. Without this, `server.close()`
    // would wait forever on long-lived tunnels.
    for (const sock of liveSockets) sock.destroy();
    await serverClosed;
    await flush();
    await new Promise<void>((resolve) => writer.end(() => resolve()));
  };

  return { port, flush, close };
}

interface ConnectArgs {
  req: IncomingMessage;
  clientSocket: Socket;
  head: Buffer;
  writer: WriteStream;
  liveSockets: Set<Socket>;
  pendingWrites: Set<Promise<void>>;
}

function handleConnect({
  req,
  clientSocket,
  head,
  writer,
  liveSockets,
  pendingWrites,
}: ConnectArgs): void {
  const target = parseConnectTarget(req.url ?? "");
  if (!target) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const { host, port } = target;

  // Pause until upstream is ready. Without pausing, the client might send
  // payload bytes between now and the upstream connect, and they'd be dropped
  // because no `data` listener exists yet.
  clientSocket.pause();

  const start = Date.now();
  let bytesOut = head.length; // bytes from client → upstream (TLS ClientHello often arrives in `head`)
  let bytesIn = 0;            // bytes from upstream → client
  let finalized = false;

  const upstream = netConnect({ host, port });
  liveSockets.add(clientSocket);
  liveSockets.add(upstream);

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    liveSockets.delete(clientSocket);
    liveSockets.delete(upstream);
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstream.destroyed) upstream.destroy();

    const row: LlmCallEventRow = {
      ts: new Date().toISOString(),
      event_id: randomUUID(),
      parent_id: null,
      kind: "LlmCallEvent",
      host,
      port,
      latency_ms: Date.now() - start,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      url: null,
      method: null,
      status: null,
      model: null,
      prompt_tokens: null,
      completion_tokens: null,
      cost_usd: null,
    };
    const redacted = redactEvent(row);
    const write = new Promise<void>((resolve) => {
      writer.write(JSON.stringify(redacted) + "\n", () => resolve());
    });
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  };

  upstream.once("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    clientSocket.on("data", (chunk: Buffer) => {
      bytesOut += chunk.length;
    });
    upstream.on("data", (chunk: Buffer) => {
      bytesIn += chunk.length;
    });
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    clientSocket.resume();
  });

  upstream.once("error", () => {
    if (!clientSocket.destroyed) {
      try {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {
        // socket already torn down — nothing useful to do
      }
    }
    finalize();
  });

  clientSocket.once("error", finalize);
  clientSocket.once("close", finalize);
  upstream.once("close", finalize);
}

function parseConnectTarget(spec: string): { host: string; port: number } | null {
  // RFC 7230 §5.3: CONNECT request-target is authority-form `host:port`.
  // IPv6 hosts arrive bracketed (`[::1]:443`).
  if (spec.length === 0) return null;
  const lastColon = spec.lastIndexOf(":");
  if (lastColon === -1) return null;
  let host = spec.slice(0, lastColon);
  const port = Number(spec.slice(lastColon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.length === 0) return null;
  return { host, port };
}
