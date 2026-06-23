// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { SlackStateSeed } from "./types.js";

// Slack seed schema. Matches `slackSeedStateSchema` in `@pome-sh/shared-types`
// shape-for-shape. Minimum bootstrap is `{}` — every nested field has defaults
// and every top-level list defaults to `[]`.
export const seedSchema = z.object({
  team: z
    .object({
      id: z.string().regex(/^T[A-Z0-9_]+$/).optional(),
      name: z.string().default("Pome Twin Workspace"),
      domain: z.string().default("pome-twin"),
    })
    .prefault({}),
  users: z
    .array(
      z.object({
        id: z.string().regex(/^[UB][A-Z0-9_]+$/).optional(),
        name: z.string().min(1),
        real_name: z.string().default(""),
        email: z.string().email().optional(),
        is_bot: z.boolean().default(false),
        is_admin: z.boolean().default(false),
        tz: z.string().default("America/Los_Angeles"),
        profile: z.record(z.string(), z.unknown()).default({}),
      })
    )
    .default([]),
  channels: z
    .array(
      z.object({
        id: z.string().regex(/^[CGDM][A-Z0-9_]+$/).optional(),
        name: z.string().regex(/^[a-z0-9_-]{1,80}$/),
        is_private: z.boolean().default(false),
        topic: z.string().default(""),
        purpose: z.string().default(""),
        creator: z.string().optional(),
        members: z.array(z.string()).default([]),
        messages: z
          .array(
            z.object({
              ts: z.string().optional(),
              user: z.string(),
              text: z.string(),
              thread_ts: z.string().optional(),
              reactions: z
                .array(z.object({ name: z.string(), user: z.string() }))
                .default([]),
            })
          )
          .default([]),
      })
    )
    .default([]),
});

export function parseSeed(input: unknown): SlackStateSeed {
  return seedSchema.parse(input) as SlackStateSeed;
}

/**
 * Boot-time seed loader: prefer `POME_SEED_JSON` env (set by the cloud
 * control-plane from the CLI-supplied scenario seed). Accepts both the flat
 * shape and the cloud's provider-scoped envelope `{slack:{seed:...}}`. Falls
 * back to `defaultSeedState()` when env is absent. Throws on malformed JSON
 * or schema-invalid seed so a misconfigured cloud deploy fails healthz
 * rather than silently booting with the default world.
 */
export function loadSeedFromEnv(env: NodeJS.ProcessEnv = process.env): SlackStateSeed {
  const raw = env.POME_SEED_JSON;
  if (raw === undefined || raw === "") {
    return defaultSeedState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`POME_SEED_JSON is not valid JSON: ${(err as Error).message}`);
  }
  // Unwrap provider-scoped envelope if present.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.slack && typeof obj.slack === "object" && obj.slack !== null) {
      const slack = obj.slack as Record<string, unknown>;
      if ("seed" in slack) {
        return parseSeed(slack.seed);
      }
    }
  }
  return parseSeed(parsed);
}

export function defaultSeedState(): SlackStateSeed {
  return {
    team: {
      id: "T_POME",
      name: "Pome Twin Workspace",
      domain: "pome-twin",
    },
    users: [
      {
        id: "U_PRIMARY",
        name: "pome-agent",
        real_name: "Pome Agent",
        email: "pome-agent@pome-twin.slack.com",
        is_bot: false,
        is_admin: true,
      },
      {
        id: "U_ALICE",
        name: "alice",
        real_name: "Alice",
        email: "alice@pome-twin.slack.com",
      },
      {
        id: "U_BOB",
        name: "bob",
        real_name: "Bob",
        email: "bob@pome-twin.slack.com",
      },
    ],
    channels: [
      {
        id: "C_GENERAL",
        name: "general",
        is_private: false,
        topic: "Company-wide announcements and chatter.",
        purpose: "This channel is for company-wide communication.",
        creator: "U_PRIMARY",
        members: ["U_PRIMARY", "U_ALICE", "U_BOB"],
        messages: [
          { user: "U_ALICE", text: "morning team" },
          { user: "U_BOB", text: "morning :wave:" },
        ],
      },
      {
        id: "C_RANDOM",
        name: "random",
        is_private: false,
        topic: "Non-work chatter and water cooler talk.",
        purpose: "A place for non-work-related flimflam.",
        creator: "U_PRIMARY",
        members: [],
        messages: [],
      },
    ],
  };
}
