// SPDX-License-Identifier: Apache-2.0
//
// Embeddable surface for the vendored Stripe twin (FDRS-528). Mirrors
// cli/src/twin-github/index.ts: just the pieces the in-process runner needs to
// boot, seed, drive (REST + JSON-RPC MCP), and export state — not the standalone
// server entrypoint.
export { createTwinStripeApp } from "./app.js";
export type { TwinStripeAppOptions, TwinStripeContext } from "./app.js";
export { openTwinStripeDatabase } from "./db.js";
export { StripeDomain } from "./domain/index.js";
export { applySeed, defaultSeed, parseSeed, loadSeedFromEnv } from "./seed.js";
export { createFailureInjectionStore } from "./failure-injection.js";
export { registerStripeRoutes } from "./routes/index.js";
export { listTools, executeTool, isMutatingTool, toolDefinitions } from "./tools.js";
export { handleMcpRequest, mcpMethodNotAllowed } from "./mcp.js";
export { createRecorder } from "./recorder.js";
export type { Recorder, ResolvedSession, TwinStripeDatabase } from "./types.js";
