// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — proxy-aware JSON POST for the bundled demo agent.
//
// The demo agent is spawned through the real capture path (FDRS-399): the
// runner injects HTTP(S)_PROXY pointing at the capture-server, whose CONNECT
// tunnels become the LlmCallEvent rows in events.jsonl and whose
// deny-by-default egress floor (FDRS-635) is the prod-safety control. Node's
// global fetch does NOT honor proxy env vars, so an agent that used bare
// fetch for its gateway calls would silently bypass both — no trace row, no
// floor. This helper restores the contract without adding a dependency:
//   - target in NO_PROXY / loopback, or no proxy configured → plain fetch;
//   - otherwise: CONNECT through the proxy, TLS-wrap for https targets, then
//     a plain node:http request over the established socket.

import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface ProxyJsonResponse {
  status: number;
  bodyText: string;
}

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** e.g. process.env.HTTPS_PROXY. Absent → direct fetch. */
  proxyUrl?: string;
  /** e.g. process.env.NO_PROXY ("127.0.0.1,localhost"). */
  noProxy?: string;
  timeoutMs?: number;
  /** Test seam: force the CONNECT-proxy path even for loopback targets
   *  (unit tests run every server on 127.0.0.1, which the production
   *  bypass would otherwise route around). */
  forceProxy?: boolean;
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  if (value === "::1" || value === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

export function matchesNoProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const candidate = host.trim().toLowerCase();
  return noProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .some((entry) =>
      entry === "*" ||
      candidate === entry ||
      candidate.endsWith(entry.startsWith(".") ? entry : `.${entry}`),
    );
}

export async function postJsonMaybeViaProxy(
  options: PostJsonOptions,
): Promise<ProxyJsonResponse> {
  const target = new URL(options.url);
  const useProxy =
    Boolean(options.proxyUrl) &&
    (options.forceProxy === true ||
      (!isLoopbackHost(target.hostname) &&
        !matchesNoProxy(target.hostname, options.noProxy)));

  if (!useProxy) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 60_000);
    try {
      const res = await fetch(options.url, {
        method: "POST",
        headers: { ...options.headers, "content-type": "application/json" },
        body: JSON.stringify(options.body),
        signal: ctrl.signal,
      });
      return { status: res.status, bodyText: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  return postJsonThroughConnectProxy(target, options);
}

async function postJsonThroughConnectProxy(
  target: URL,
  options: PostJsonOptions,
): Promise<ProxyJsonResponse> {
  const proxy = new URL(options.proxyUrl!);
  const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const timeoutMs = options.timeoutMs ?? 60_000;

  const rawSocket = await connectTunnel(
    proxy.hostname,
    Number(proxy.port || 80),
    target.hostname,
    targetPort,
    timeoutMs,
  );

  const socket: Socket =
    target.protocol === "https:"
      ? await new Promise<Socket>((resolve, reject) => {
          const tlsSocket = tlsConnect(
            { socket: rawSocket, servername: target.hostname },
            () => resolve(tlsSocket),
          );
          tlsSocket.once("error", reject);
        })
      : rawSocket;

  return new Promise<ProxyJsonResponse>((resolve, reject) => {
    const payload = JSON.stringify(options.body);
    const req = httpRequest(
      {
        createConnection: () => socket,
        method: "POST",
        host: target.hostname,
        port: targetPort,
        path: `${target.pathname}${target.search}`,
        headers: {
          ...options.headers,
          host: target.host,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          connection: "close",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let bodyText = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          bodyText += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, bodyText });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`request to ${target.host} timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => {
      socket.destroy();
      reject(err);
    });
    req.end(payload);
  });
}

function connectTunnel(
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const sock = netConnect({ host: proxyHost, port: proxyPort });
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`CONNECT to ${targetHost}:${targetPort} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    sock.once("error", fail);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      sock.off("data", onData);
      if (!/^HTTP\/1\.[01] 200/.test(buf)) {
        // FDRS-635 — a refused CONNECT (egress floor) surfaces as its 403
        // status line, so the caller can say WHY the call failed.
        fail(new Error(`CONNECT ${targetHost}:${targetPort} refused: ${buf.split("\r\n")[0]}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.pause();
      // Bytes past the header (rare for CONNECT) belong to the tunneled
      // stream; push them back so the TLS/http layer sees them.
      const rest = Buffer.from(buf.slice(headerEnd + 4), "utf8");
      if (rest.length > 0) sock.unshift(rest);
      sock.resume();
      resolve(sock);
    };
    sock.on("data", onData);
    sock.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
    );
  });
}
