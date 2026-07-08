// SPDX-License-Identifier: Apache-2.0
//
// Twin-agnostic in-process boot for the self-host runner (FDRS-528 / FDRS-529).
//
// The local runner historically only booted the GitHub twin and threw for any
// other seed shape. `bootTwin` generalizes that: given a twin name + the
// scenario's (already twin-shaped) seed state, it stands up the matching
// in-process twin app, seeds it, and exposes a uniform surface the runner drives
// regardless of twin —
//   - `app`         a Hono app (`.fetch`) the runner serves on a localhost port
//   - `envName`     the `POME_<NAME>_{REST,MCP}_URL` prefix the agent reads
//   - `exportState` initial/final twin state for deterministic `[D]` scoring
//   - `events`      recorded twin HTTP events (one shared recorder buffer)
//   - `close`       tear down the underlying SQLite handle
//
// Every twin's `createApp` takes the same CLI recorder instance, so events from
// any twin land in one buffer typed as the legacy github `RecorderEvent` (the
// shape is structurally shared via `@pome-sh/shared-types`; the `twin` field is
// just a string, see `recorderEventSchema`). New twins slot in by adding a case.
import { createRecorder } from "../recorder/recorder.js";
import type { RecorderEvent } from "@pome-sh/shared-types";
import {
  createGitHubCloneApp,
  exportGitHubCloneState,
  openGitHubCloneDatabase,
  seedGitHubCloneDatabase,
} from "./githubCloneAdapter.js";
import {
  createSlackTwinApp,
  openSlackTwinDatabase,
  SlackDomain,
} from "@pome-sh/twin-slack";
import {
  createTwinStripeApp,
  openTwinStripeDatabase,
  parseSeed as parseStripeSeed,
  StripeDomain,
} from "@pome-sh/twin-stripe";

// The account every local Stripe scenario seeds under. The runner mints a JWT
// whose `account_id` claim matches this, so `exportState` and the session
// resolve to the same account the seed data lives in.
export const STRIPE_LOCAL_ACCOUNT_ID = "acct_default";

export type TwinHarness = {
  /** Hono app the runner serves at `http://127.0.0.1:<port>`. */
  app: { fetch: (request: Request, ...rest: unknown[]) => Response | Promise<Response> };
  /** Uppercase env prefix: the agent reads `POME_<envName>_{REST,MCP}_URL`. */
  envName: string;
  /** Twin state for `[D]` scoring (initial before the agent, final after). */
  exportState(): unknown | Promise<unknown>;
  /** Recorded twin HTTP events (shared buffer). */
  events(): RecorderEvent[];
  /** Extra JWT claims the runner mints into the agent token (e.g. Stripe's
   *  `account_id`, so the token resolves to the account the seed lives in). */
  extraClaims?: Record<string, unknown>;
  /** Release the SQLite handle. */
  close(): void;
};

export class UnsupportedTwinError extends Error {
  constructor(public readonly twin: string) {
    super(
      `Self-hosted local runs do not support the '${twin}' twin yet. ` +
        `Supported: github, slack, stripe.`,
    );
    this.name = "UnsupportedTwinError";
  }
}

export async function bootTwin(opts: {
  twin: string;
  seedState: unknown;
  runId: string;
  twinBaseUrl?: string;
}): Promise<TwinHarness> {
  const recorder = createRecorder();

  switch (opts.twin) {
    case "github": {
      const db = await openGitHubCloneDatabase();
      await seedGitHubCloneDatabase(db, opts.seedState);
      const app = (await createGitHubCloneApp({
        db,
        recorder,
        runId: opts.runId,
      })) as TwinHarness["app"];
      return {
        app,
        envName: "GITHUB",
        exportState: () => exportGitHubCloneState(db),
        events: () => recorder.events(),
        close: () => (db as { close(): void }).close(),
      };
    }

    case "slack": {
      const db = openSlackTwinDatabase(":memory:");
      const domain = new SlackDomain(db);
      // `applySeed` runs the twin's own `parseSeed` (regex/shape validation +
      // default-filling) before seeding, so the permissive scenario-side
      // `slackSeedStateSchema` is tightened to the twin's contract here.
      domain.applySeed(opts.seedState);
      const app = createSlackTwinApp({
        db,
        domain,
        // One shared CLI recorder buffers events for every twin; the engine
        // types its param as `RecorderStore` (same structural shape).
        recorder: recorder as NonNullable<Parameters<typeof createSlackTwinApp>[0]>["recorder"],
        runId: opts.runId,
      }) as TwinHarness["app"];
      return {
        app,
        envName: "SLACK",
        exportState: () => domain.exportState(),
        events: () => recorder.events(),
        close: () => db.close(),
      };
    }

    case "stripe": {
      // Engine-based twin (F-684): the factory owns middleware, MCP mount,
      // and the failure-injection store — seed rules ride in via `seed` and
      // land in the same store the session middleware reads (FDRS-369), so
      // e.g. scenario 14's lost-response 402 actually fires. Recorder
      // counters (dropped) come from the engine handle, so the shared CLI
      // recorder suffices here too.
      const db = openTwinStripeDatabase(":memory:");
      const domain = new StripeDomain(db);
      const app = createTwinStripeApp({
        db,
        recorder: recorder as NonNullable<Parameters<typeof createTwinStripeApp>[0]>["recorder"],
        runId: opts.runId,
        seed: parseStripeSeed(opts.seedState),
        twinBaseUrl: opts.twinBaseUrl ?? "http://127.0.0.1:3333",
      }) as TwinHarness["app"];
      return {
        app,
        envName: "STRIPE",
        exportState: () => domain.exportState(STRIPE_LOCAL_ACCOUNT_ID),
        events: () => recorder.events(),
        extraClaims: { account_id: STRIPE_LOCAL_ACCOUNT_ID },
        close: () => db.close(),
      };
    }

    default:
      throw new UnsupportedTwinError(opts.twin);
  }
}
