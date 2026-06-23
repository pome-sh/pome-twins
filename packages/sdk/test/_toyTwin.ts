// SPDX-License-Identifier: Apache-2.0
//
// In-memory toy twin used by SDK integration tests. Mirrors the shape we
// expect a real community twin (Stripe / Plaid / Zendesk) to take.

import { z } from "zod";
import { defineTwin, type TwinDefinition } from "../src/index.js";
import { TwinError } from "../src/errors.js";

export interface ToyDomain {
  list(): string[];
  add(item: string): { item: string; total: number };
  reset(): void;
  applySeed(seed: { items: string[] }): void;
}

export function createToyDomain(initial: string[] = []): ToyDomain {
  let items = [...initial];
  return {
    list: () => [...items],
    add(item) {
      items.push(item);
      return { item, total: items.length };
    },
    reset() {
      items = [];
    },
    applySeed(seed) {
      items = [...seed.items];
    },
  };
}

export const toySeedSchema = z.object({
  items: z.array(z.string().min(1)),
});

export const toyTwin: TwinDefinition<unknown, { items: string[] }, ToyDomain> = defineTwin({
  id: "toy",
  version: "0.1.0",
  fidelity: { default: "semantic" },
  seed: toySeedSchema,
  domain: ({ seed }) => createToyDomain(seed?.items ?? []),
  state: ({ domain }) => ({ items: domain.list() }),
  admin: {
    reset: ({ domain }) => {
      domain.reset();
      return { ok: true };
    },
    seed: ({ domain, seed }) => {
      domain.applySeed(seed);
      return { ok: true, items: seed.items.length };
    },
  },
  tools: [
    {
      name: "add_item",
      description: "Add a single item.",
      schema: z.object({ item: z.string().min(1) }),
      handler: (domain, args) => domain.add((args as { item: string }).item),
      mutation: true,
      fidelity: {
        tier: "semantic",
        backingSurface: "in-memory list",
        tests: ["mcp-registry.test.ts"],
        deviations: "Items are unique only by insertion order, not by uniqueness constraint.",
      },
    },
    {
      name: "count_items",
      description: "Count items.",
      schema: z.object({}),
      handler: (domain) => ({ count: domain.list().length }),
      mutation: false,
    },
  ],
  routes: (app, { domain, recorder }) => {
    app.get(
      "/items",
      recorder.handle({ mutation: false }, () => ({
        status: 200,
        body: { items: domain.list() },
      }))
    );
    app.post(
      "/items",
      recorder.handle({ mutation: true }, async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { item?: unknown };
        if (typeof body.item !== "string" || !body.item) {
          throw new TwinError("item required", 422);
        }
        return { status: 201, body: domain.add(body.item) };
      })
    );
  },
});
