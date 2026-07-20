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
//   - `exportState` initial/final twin state for deterministic `[code]` scoring
//   - `events`      recorded twin HTTP events (one shared recorder buffer)
//   - `close`       tear down the underlying SQLite handle
//
// Every twin's `createApp` takes the same CLI recorder instance, so events from
// any twin land in one buffer typed as the legacy github `RecorderEvent` (the
// shape is structurally shared via `@pome-sh/shared-types`; the `twin` field is
// just a string, see `recorderEventSchema`). New twins slot in by adding a case.
import { createRecorder, type Recorder } from "../recorder/recorder.js";
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
import { createApp } from "@pome-sh/sdk/server";
import * as stripeTwin from "@pome-sh/twin-stripe";
import {
  applySeed as applyStripeSeed,
  createTwinStripeApp,
  openTwinStripeDatabase,
  parseSeed as parseStripeSeed,
  StripeDomain,
} from "@pome-sh/twin-stripe";
import {
  createGmailTwinApp,
  GmailDomain,
  openGmailTwinDatabase,
  parseSeed as parseGmailSeed,
} from "@pome-sh/twin-gmail";

// The account every local Stripe scenario seeds under. The runner mints a JWT
// whose `account_id` claim matches this, so `exportState` and the session
// resolve to the same account the seed data lives in.
export const STRIPE_LOCAL_ACCOUNT_ID = "acct_default";

export type TwinHarness = {
  /** Hono app the runner serves at `http://127.0.0.1:<port>`. */
  app: { fetch: (request: Request, ...rest: unknown[]) => Response | Promise<Response> };
  /** Uppercase env prefix: the agent reads `POME_<envName>_{REST,MCP}_URL`. */
  envName: string;
  /** Twin state for `[code]` scoring (initial before the agent, final after). */
  exportState(): unknown | Promise<unknown>;
  /** Recorded twin HTTP events (shared buffer). */
  events(): RecorderEvent[];
  /** Extra JWT claims the runner mints into the agent token (e.g. Stripe's
   *  `account_id`, so the token resolves to the account the seed lives in). */
  extraClaims?: Record<string, unknown>;
  /** Provider-specific bearer alias, when the provider SDK expects one. */
  tokenEnvName?: string;
  /**
   * Durability barrier for the twin recorder without closing the DB.
   * Call before finalize/merge so pending TwinHttpEvent rows land on disk
   * before `events.jsonl` is rewritten.
   */
  flush(): void | Promise<void>;
  /** Flush durable recorder (if any) and release the SQLite handle. */
  close(): void | Promise<void>;
};

export class UnsupportedTwinError extends Error {
  constructor(public readonly twin: string) {
    super(
      `Self-hosted local runs do not support the '${twin}' twin yet. ` +
        `Supported: github, slack, stripe, gmail.`,
    );
    this.name = "UnsupportedTwinError";
  }
}

export async function bootTwin(opts: {
  twin: string;
  seedState: unknown;
  runId: string;
  twinBaseUrl?: string;
  /**
   * F-698: when set, twin HTTP events stream to this NDJSON path via the
   * twin-core durable recorder (same file capture-server appends to).
   */
  eventsPath?: string;
  /**
   * Multi-twin (M3): a SHARED recorder so every twin harness in one local run
   * buffers into a single events stream / events.jsonl. When provided, this
   * harness does NOT own the recorder — `close()` releases only its DB handle
   * and the caller is responsible for `flush()`/`close()` on the recorder. When
   * omitted (single-twin), the harness creates and owns its own recorder, so
   * `close()` flushes + closes it exactly as before.
   */
  recorder?: Recorder;
}): Promise<TwinHarness> {
  const ownsRecorder = opts.recorder === undefined;
  const recorder = opts.recorder ?? createRecorder({ eventsPath: opts.eventsPath });

  const flushRecorder = async () => {
    await recorder.flush?.();
  };
  const closeRecorderAndDb = async (dbClose: () => void) => {
    await flushRecorder();
    // A shared recorder is owned by the caller — only flush here, never close
    // it out from under sibling harnesses still writing to it.
    if (ownsRecorder) await recorder.close?.();
    dbClose();
  };

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
        flush: () => flushRecorder(),
        close: () => closeRecorderAndDb(() => (db as { close(): void }).close()),
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
        flush: () => flushRecorder(),
        close: () => closeRecorderAndDb(() => db.close()),
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
      const seed = parseStripeSeed(opts.seedState);
      const twinBaseUrl = opts.twinBaseUrl ?? "http://127.0.0.1:3333";
      type StripeDefinitionFactory = (factoryOpts: {
        db: ReturnType<typeof openTwinStripeDatabase>;
        twinBaseUrl?: string;
      }) => Parameters<typeof createApp>[0];
      const createStripeTwinDefinition = (
        stripeTwin as typeof stripeTwin & {
          createStripeTwinDefinition?: StripeDefinitionFactory;
        }
      ).createStripeTwinDefinition;
      const app = (createStripeTwinDefinition
        ? createApp(createStripeTwinDefinition({ db, twinBaseUrl }), {
            db,
            recorder,
            runId: opts.runId,
            seed,
          })
        : (() => {
            // Older published twin-stripe packages predate the additive
            // `seed` app option. Seed explicitly so local runs don't boot an
            // empty credential store when the CLI resolves that package.
            applyStripeSeed(db, seed);
            return createTwinStripeApp({
              db,
              recorder:
                recorder as NonNullable<Parameters<typeof createTwinStripeApp>[0]>["recorder"],
              runId: opts.runId,
              twinBaseUrl,
            } as Parameters<typeof createTwinStripeApp>[0] & { twinBaseUrl?: string });
          })()) as TwinHarness["app"];
      return {
        app,
        envName: "STRIPE",
        exportState: () => domain.exportState(STRIPE_LOCAL_ACCOUNT_ID),
        events: () => recorder.events(),
        extraClaims: { account_id: STRIPE_LOCAL_ACCOUNT_ID },
        flush: () => flushRecorder(),
        close: () => closeRecorderAndDb(() => db.close()),
      };
    }

    case "gmail": {
      const db = openGmailTwinDatabase(":memory:");
      const seed = parseGmailSeed(opts.seedState);
      const domain = new GmailDomain(db);
      const app = createGmailTwinApp({
        db,
        seed,
        recorder,
        runId: opts.runId,
      }) as TwinHarness["app"];
      return {
        app,
        envName: "GMAIL",
        exportState: () => domain.exportState(),
        events: () => recorder.events(),
        extraClaims: { gmail_email: seed.primaryMailbox.email },
        tokenEnvName: "POME_GMAIL_TOKEN",
        flush: () => flushRecorder(),
        close: () => closeRecorderAndDb(() => db.close()),
      };
    }

    default:
      throw new UnsupportedTwinError(opts.twin);
  }
}
