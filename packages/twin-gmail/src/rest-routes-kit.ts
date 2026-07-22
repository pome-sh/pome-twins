// SPDX-License-Identifier: Apache-2.0
import type { Context, Handler } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import type { GmailDomain } from "./domain/index.js";
import { gmailStateDelta } from "./state.js";
import { GmailRestSerializers } from "./rest-serializers.js";

export type RouteResult = { status?: number; body: unknown; mutation?: boolean };

export class GmailRouteKit {
  readonly serializers: GmailRestSerializers;

  constructor(readonly context: RouteContext<GmailDomain>) {
    this.serializers = new GmailRestSerializers(context.domain);
  }

  get domain(): GmailDomain {
    return this.context.domain;
  }

  read(fn: (c: Context) => RouteResult | Promise<RouteResult>): Handler {
    return this.context.recorder.handle({ mutation: false }, async (c) => {
      const result = await fn(c);
      return { status: result.status ?? 200, body: result.body, mutation: false };
    });
  }

  write(fn: (c: Context) => RouteResult | Promise<RouteResult>): Handler {
    return this.context.recorder.handle({ mutation: true }, async (c) => {
      const before = this.context.domain.exportState();
      const result = await fn(c);
      const wantsMutation = result.mutation ?? true;
      const delta = wantsMutation
        ? gmailStateDelta(before, this.context.domain.exportState())
        : null;
      // Accurate state_mutation: no-op writes (empty delta) did not mutate state.
      const mutation = wantsMutation && delta !== null;
      return {
        status: result.status ?? 200,
        body: result.body,
        mutation,
        delta,
      };
    });
  }

  unsupported(message: string): Handler {
    return this.context.recorder.handle({ mutation: false, fidelity: "unsupported" }, () => ({
      status: 501,
      body: {
        error: {
          code: 501,
          message,
          errors: [{ message, domain: "global", reason: "notImplemented" }],
          status: "UNIMPLEMENTED",
        },
      },
      mutation: false,
    }));
  }
}
