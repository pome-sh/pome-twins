// SPDX-License-Identifier: Apache-2.0
//
// F-681 proof-of-harness: the slack twin assembled as a pure domain plugin
// on the @pome-sh/sdk engine via defineTwin(), booted the exact way the
// cloud boots a twin (env surface, boot guard, /healthz within 3s). The
// sdk-boot contract suite (contract/sdk-boot.test.mjs) runs the SAME frozen
// FDRS-711 assertions against this entry that contract.test.mjs runs
// against the twin's own dist/src/server.js.
//
// This file consumes BUILT dists (sdk + twin-slack) and lives outside the
// twin packages on purpose: twins cannot depend on the sdk until F-713
// solves vendoring, and the full port is F-683. Prerequisite builds are
// chained by contract/run.mjs.

import { createRequire } from "node:module";
import { defineTwin, openTwinDatabase } from "../../packages/sdk/dist/index.js";
import {
  UnknownToolError,
  formTokenResolver,
  queryTokenResolver,
  serve,
} from "../../packages/sdk/dist/server.js";
import { migrate } from "../../packages/twin-slack/dist/src/db.js";
import { SlackDomain } from "../../packages/twin-slack/dist/src/domain.js";
import { TwinError as SlackTwinError } from "../../packages/twin-slack/dist/src/errors.js";
import { defaultSeedState, loadSeedFromEnv } from "../../packages/twin-slack/dist/src/seed.js";
import { executeTool, isMutatingTool, toolDefinitions } from "../../packages/twin-slack/dist/src/tools.js";
import { unsupportedEnvelope } from "../../packages/twin-slack/dist/src/unsupported-envelope.js";

// This file lives outside the workspace packages, so bare "zod" does not
// resolve from here — borrow the sdk's own instance.
const { z } = createRequire(new URL("../../packages/sdk/dist/index.js", import.meta.url))("zod");

const slackError = (code) => ({ ok: false, error: code });

const definition = defineTwin({
  id: "slack",
  version: process.env.POME_TWIN_VERSION ?? "0.1.0",
  implementation: "slack_clone",
  packageName: "@pome-sh/twin-slack",
  fidelity: { default: "semantic" },
  // Slack accepts arbitrary seed bodies (frozen: garbage → 200 {ok:true});
  // SlackDomain.applySeed does its own tolerant parse.
  seed: z.record(z.string(), z.unknown()),
  domain: ({ db }) => {
    const domain = new SlackDomain(db);
    if (process.env.SLACK_CLONE_NO_SEED !== "1") {
      domain.seed(loadSeedFromEnv());
    }
    return domain;
  },
  state: ({ domain }) => domain.exportState(),
  admin: {
    reset: ({ domain }) => {
      domain.resetToDefault(defaultSeedState);
      return { ok: true };
    },
    seed: ({ domain, seed }) => {
      domain.applySeed(seed.seed ?? seed);
      return { ok: true };
    },
  },
  tools: toolDefinitions.map((def) => ({
    name: def.name,
    description: def.description,
    schema: def.schema,
    mutation: isMutatingTool(def.name),
    handler: (domain, args) => wrapSlackOk(executeTool(domain, def.name, args)),
  })),
  // Frozen healthz shape: {ok, twin, implementation, tools, runtime} — no
  // version/fidelity extras (slack never carried them).
  healthz: () => ({}),
  unsupported: () => unsupportedEnvelope,
  errorEnvelope: (err) => {
    if (err instanceof UnknownToolError) return { status: 404, body: slackError("unknown_tool") };
    if (err instanceof SlackTwinError) {
      // Application-level Slack errors return HTTP 200 with {ok:false, error}
      // — matches real Slack; official SDKs treat non-200 as transport failure.
      return { status: 200, body: { ok: false, error: err.code, ...(err.extra ?? {}) } };
    }
    if (err instanceof z.ZodError || (err instanceof Error && err.name === "ZodError")) {
      return {
        status: 200,
        body: {
          ok: false,
          error: "invalid_arguments",
          response_metadata: {
            messages: err.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
          },
        },
      };
    }
    return {
      status: 500,
      body: { ok: false, error: "internal_error", warning: err instanceof Error ? err.message : "internal_error" },
    };
  },
  auth: {
    providerToken: { provider: "slack", prefixes: ["xoxb-pome-", "xoxp-pome-"] },
    providerSession: () => ({ login: "pome-agent" }),
    tokenResolvers: [queryTokenResolver("token"), formTokenResolver("token")],
    unauthorized: (kind) => ({
      status: 401,
      body: slackError(kind === "no_token" ? "not_authed" : kind === "expired" ? "token_expired" : "invalid_auth"),
    }),
    sidMismatch: () => ({ status: 401, body: slackError("invalid_auth") }),
    sessionExtras: (claims) =>
      typeof claims.login === "string" && claims.login.length > 0 ? { login: claims.login } : {},
  },
});

function wrapSlackOk(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("ok" in value) return value;
    return { ok: true, ...value };
  }
  return { ok: true, result: value };
}

const port = Number(process.env.PORT ?? process.env.SLACK_CLONE_PORT ?? 3333);
const host = process.env.SLACK_CLONE_HOST ?? "127.0.0.1";
const dbPath = process.env.SLACK_CLONE_DB ?? ".slack_clone/slack.db";

const db = openTwinDatabase(dbPath, { migrate });
await serve(definition, {
  port,
  hostname: host,
  db,
  runId: process.env.POME_RUN_ID ?? "spawn",
});

console.log(`Slack twin (sdk boot) listening at http://${host}:${port}`);
