// SPDX-License-Identifier: Apache-2.0
// CLI entry for `pome capture-server`. Boots the proxy, wires SIGTERM/SIGINT
// to a graceful shutdown that drains in-flight tunnels and flushes the events
// file before exiting 0.

import { resolve } from "node:path";
import { runCaptureServer } from "./index.js";

export interface RunCaptureServerCommandOptions {
  port: number;
  eventsOut: string;
  // FDRS-635 — egress-floor allowlist patterns (already parsed from CSV) and
  // the sidecar path for refused-CONNECT rows.
  allowHosts?: readonly string[];
  egressOut?: string;
}

export async function runCaptureServerCommand(
  options: RunCaptureServerCommandOptions,
): Promise<void> {
  const eventsOut = resolve(options.eventsOut);
  const egressOut = options.egressOut ? resolve(options.egressOut) : undefined;
  const allowHosts = options.allowHosts ?? [];
  const handle = await runCaptureServer({ port: options.port, eventsOut, allowHosts, egressOut });

  console.error(
    `pome capture-server listening on 127.0.0.1:${handle.port} (events → ${eventsOut})`,
  );
  console.error(
    `pome capture-server egress floor: deny-by-default (${allowHosts.length} allowlisted pattern(s) + loopback)`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`pome capture-server: received ${signal}, draining…`);
    await handle.close();
    console.error("pome capture-server: stopped");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
