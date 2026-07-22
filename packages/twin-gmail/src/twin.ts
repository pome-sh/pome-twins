// SPDX-License-Identifier: Apache-2.0
import { defineTwin, type TwinDefinition } from "@pome-sh/sdk";
import { createApp, type RecorderStore } from "@pome-sh/sdk/server";
import type { Hono } from "hono";
import { openGmailTwinDatabase } from "./db.js";
import { GmailDomain } from "./domain/index.js";
import { gmailErrorEnvelope } from "./errors.js";
import { DEFAULT_GMAIL_EMAIL } from "./identity.js";
import { gmailTools } from "./mcp.js";
import { projectGmailRecording } from "./recording.js";
import { registerGmailRoutes } from "./rest-routes.js";
import { gmailSeedSchema, type ParsedGmailStateSeed } from "./seed.js";
import { gmailStateDelta } from "./state.js";
import type { GmailStateSeed, GmailTwinDatabase } from "./types.js";

export { registerGmailRoutes };

function unauthorized(): { status: number; body: unknown } {
  return {
    status: 401,
    body: {
      error: {
        code: 401,
        message: "Request had invalid authentication credentials.",
        errors: [
          {
            message: "Invalid Credentials",
            domain: "global",
            reason: "authError",
            location: "Authorization",
            locationType: "header",
          },
        ],
        status: "UNAUTHENTICATED",
      },
    },
  };
}

export const gmailTwinDefinition: TwinDefinition<
  GmailTwinDatabase,
  ParsedGmailStateSeed,
  GmailDomain
> = defineTwin({
  id: "gmail",
  version: process.env.POME_TWIN_VERSION ?? "0.1.0",
  implementation: "gmail_twin",
  packageName: "@pome-sh/twin-gmail",
  fidelity: { default: "semantic" },
  seed: gmailSeedSchema,
  domain: ({ db, seed }) => {
    const domain = new GmailDomain(db ?? openGmailTwinDatabase(":memory:"));
    if (seed) domain.seed(seed);
    return domain;
  },
  routes: registerGmailRoutes,
  tools: gmailTools,
  state: ({ domain }) => domain.exportState(),
  admin: {
    reset: ({ domain, reportDelta }) => {
      const before = domain.exportState();
      domain.resetToDefault();
      reportDelta(gmailStateDelta(before, domain.exportState()));
      return { ok: true };
    },
    seed: ({ domain, seed, reportDelta }) => {
      const before = domain.exportState();
      domain.seed(seed);
      reportDelta(gmailStateDelta(before, domain.exportState()));
      return { ok: true };
    },
  },
  recordingProjection: projectGmailRecording,
  errorEnvelope: gmailErrorEnvelope,
  unsupported: ({ method, path }) => ({
    status: 501,
    body: {
      error: {
        code: 501,
        message: `Unsupported Gmail twin route: ${method} ${path}`,
        errors: [{ domain: "global", reason: "notImplemented", message: "Not implemented" }],
        status: "UNIMPLEMENTED",
      },
    },
  }),
  auth: {
    unauthorized,
    sidMismatch: unauthorized,
    sessionExtras: (claims) => ({
      gmail_email:
        typeof claims.gmail_email === "string" && claims.gmail_email.length > 0
          ? claims.gmail_email.toLowerCase()
          : DEFAULT_GMAIL_EMAIL,
    }),
  },
});

export type CreateGmailTwinAppOptions = {
  db?: GmailTwinDatabase;
  recorder?: RecorderStore;
  runId?: string;
  seed?: GmailStateSeed;
};

export function createGmailTwinApp(options: CreateGmailTwinAppOptions = {}): Hono {
  return createApp(gmailTwinDefinition, {
    db: options.db ?? openGmailTwinDatabase(":memory:"),
    recorder: options.recorder,
    runId: options.runId ?? "spawn",
    seed: options.seed as ParsedGmailStateSeed | undefined,
  });
}
