// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import {
  expandSurfaceCell,
  fidelityInventorySchema,
  lintFidelityInventory,
  parseFidelityDocRows,
  runFidelityParity,
  type FidelityInventory,
  type ParityStep,
} from "../src/parity.js";
import { TEST_AUTH_SECRET, TEST_SID } from "./_authHelper.js";
import { toyTwin } from "./_toyTwin.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const BASELINE = "pre-M5 baseline; heat awaits the F-729 rubric ruling";

function toyInventory(): FidelityInventory {
  return fidelityInventorySchema.parse({
    twin: "toy",
    package: "@pome-sh/toy",
    updated: "2026-07-11",
    tools: [
      { name: "add_item", heat: "unclassified", fidelity: "semantic", justification: BASELINE },
      { name: "count_items", heat: "unclassified", fidelity: "semantic", justification: BASELINE },
    ],
    rest: [
      { name: "GET /items", heat: "unclassified", fidelity: "semantic", justification: BASELINE },
    ],
  });
}

const TOY_STEPS: ParityStep[] = [
  {
    tool: "add_item",
    arguments: { item: "first" },
    capture: (body, state) => {
      state.total = (body as { total?: number }).total;
    },
  },
  {
    tool: "count_items",
    verify: (body) =>
      (body as { count?: number }).count === 1 ? undefined : "expected count 1",
  },
];

describe("runFidelityParity", () => {
  it("is green when live tools, inventory, and scenario coverage agree", async () => {
    const app = createApp(toyTwin);
    const result = await runFidelityParity({
      app,
      twin: "toy",
      sid: TEST_SID,
      secret: TEST_AUTH_SECRET,
      inventory: toyInventory(),
      liveToolNames: ["add_item", "count_items"],
      steps: TOY_STEPS,
      restProbes: [
        { surface: "unsupported-rest", path: "/nope/not-a-route", status: 501, expectUnsupportedEnvelope: true },
      ],
    });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.report).toHaveLength(3);
  });

  it("fails when the inventory misses a live tool", async () => {
    const app = createApp(toyTwin);
    const inventory = toyInventory();
    inventory.tools = inventory.tools.filter((tool) => tool.name !== "count_items");
    const result = await runFidelityParity({
      app,
      twin: "toy",
      sid: TEST_SID,
      secret: TEST_AUTH_SECRET,
      inventory,
      liveToolNames: ["add_item", "count_items"],
      steps: TOY_STEPS,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("missing from fidelity.inventory.json");
  });

  it("fails when a scenario leaves an inventory tool uncovered", async () => {
    const app = createApp(toyTwin);
    const result = await runFidelityParity({
      app,
      twin: "toy",
      sid: TEST_SID,
      secret: TEST_AUTH_SECRET,
      inventory: toyInventory(),
      liveToolNames: ["add_item", "count_items"],
      steps: TOY_STEPS.filter((step) => step.tool !== "count_items"),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("no parity scenario step covers tool 'count_items'");
  });

  it("fails a step whose response is not the expected status", async () => {
    const app = createApp(toyTwin);
    const steps: ParityStep[] = [
      { tool: "add_item", arguments: {} }, // missing required `item` → 4xx
      ...TOY_STEPS,
    ];
    const result = await runFidelityParity({
      app,
      twin: "toy",
      sid: TEST_SID,
      secret: TEST_AUTH_SECRET,
      inventory: toyInventory(),
      liveToolNames: ["add_item", "count_items"],
      steps,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.startsWith("add_item: expected 2xx"))).toBe(true);
  });
});

describe("expandSurfaceCell", () => {
  it("expands slack-style shorthand groups against the first span's prefix", () => {
    expect(expandSurfaceCell("`reactions.add` / `remove` / `get`")).toEqual([
      "reactions.add",
      "reactions.remove",
      "reactions.get",
    ]);
  });

  it("keeps fully-qualified spans verbatim", () => {
    expect(
      expandSurfaceCell("`users.list` / `users.info` / `users.profile.get`")
    ).toEqual(["users.list", "users.info", "users.profile.get"]);
  });

  it("splits multi-route cells and drops prose annotations", () => {
    expect(expandSurfaceCell("`POST /mcp/call` and `POST /mcp/tools/:name`")).toEqual([
      "POST /mcp/call",
      "POST /mcp/tools/:name",
    ]);
    expect(expandSurfaceCell("`GET /repos/:owner/:repo/contents/*` (READ)")).toEqual([
      "GET /repos/:owner/:repo/contents/*",
    ]);
  });

  it("returns plain cells verbatim", () => {
    expect(expandSurfaceCell("Any unsupported path")).toEqual(["Any unsupported path"]);
  });
});

const DOC = `
## MCP Tools

| Tool | Backing surface | Tier | Tests | Known deviations |
| --- | --- | --- | --- | --- |
| \`add_item\` | in-memory list | semantic | \`x.test.ts\` | — |
| \`count_items\` | in-memory list | semantic | \`x.test.ts\` | — |

## REST routes

| Endpoint | Tier | Tests | Notes |
| --- | --- | --- | --- |
| \`GET /items\` | semantic | \`x.test.ts\` | — |
`;

describe("parseFidelityDocRows / lintFidelityInventory", () => {
  it("parses tool and rest tables by header", () => {
    expect(parseFidelityDocRows(DOC, "tool")).toEqual([
      { name: "add_item", fidelity: "semantic" },
      { name: "count_items", fidelity: "semantic" },
    ]);
    expect(parseFidelityDocRows(DOC, "rest")).toEqual([
      { name: "GET /items", fidelity: "semantic" },
    ]);
  });

  it("passes a clean inventory and reports drift in both directions", () => {
    const docs = [
      { label: "FIDELITY.md", kind: "tool" as const, markdown: DOC },
      { label: "FIDELITY.md", kind: "rest" as const, markdown: DOC },
    ];
    expect(lintFidelityInventory(toyInventory(), docs)).toEqual([]);

    const missingInInventory = toyInventory();
    missingInInventory.tools = missingInInventory.tools.slice(0, 1);
    expect(lintFidelityInventory(missingInInventory, docs).join("\n")).toContain(
      "'count_items' documented but missing"
    );

    const undocumented = toyInventory();
    undocumented.rest.push({
      name: "POST /items",
      heat: "unclassified",
      fidelity: "semantic",
      justification: BASELINE,
    });
    expect(lintFidelityInventory(undocumented, docs).join("\n")).toContain(
      "'POST /items' is in fidelity.inventory.json but undocumented"
    );
  });

  it("accepts declared doc drift and flags it once stale", () => {
    const docs = [
      { label: "FIDELITY.md", kind: "tool" as const, markdown: DOC },
      { label: "FIDELITY.md", kind: "rest" as const, markdown: DOC },
    ];
    const inventory = toyInventory();
    inventory.rest.push({
      name: "POST /items",
      heat: "unclassified",
      fidelity: "semantic",
      justification: "implemented but not yet documented",
    });
    inventory.doc_drift = [
      { kind: "rest", name: "POST /items", reason: "docs lag the route", ticket: "F-733" },
    ];
    expect(lintFidelityInventory(inventory, docs)).toEqual([]);

    // Once the docs cover the surface, the declaration must be removed.
    const caughtUp = DOC.replace(
      "| `GET /items` | semantic | `x.test.ts` | — |",
      "| `GET /items` | semantic | `x.test.ts` | — |\n| `POST /items` | semantic | `x.test.ts` | — |"
    );
    const staleDocs = [
      { label: "FIDELITY.md", kind: "tool" as const, markdown: caughtUp },
      { label: "FIDELITY.md", kind: "rest" as const, markdown: caughtUp },
    ];
    expect(lintFidelityInventory(inventory, staleDocs).join("\n")).toContain("is stale");
  });

  it("reports fidelity tier mismatches between inventory and docs", () => {
    const docs = [{ label: "FIDELITY.md", kind: "tool" as const, markdown: DOC }];
    const inventory = toyInventory();
    inventory.tools[0].fidelity = "shape";
    expect(lintFidelityInventory(inventory, docs).join("\n")).toContain(
      "inventory says fidelity 'shape' but FIDELITY.md says 'semantic'"
    );
  });

  it("reports duplicate doc rows with conflicting tiers instead of last-row-wins", () => {
    const conflicting = DOC.replace(
      "| `count_items` | in-memory list | semantic | `x.test.ts` | — |",
      "| `count_items` | in-memory list | shape | `x.test.ts` | — |\n| `count_items` | in-memory list | semantic | `x.test.ts` | — |"
    );
    const docs = [{ label: "FIDELITY.md", kind: "tool" as const, markdown: conflicting }];
    expect(lintFidelityInventory(toyInventory(), docs).join("\n")).toContain(
      "documented twice with conflicting tiers ('shape' vs 'semantic')"
    );
  });
});

// ENDPOINT-TIERS.md lint rule 5: when a FIDELITY table carries the optional
// Heat column, its values must equal the inventory's — heat and fidelity are
// lintable independently. Tables without a Heat column stay legal (pre-M5
// twins), so the column is parsed only when the header names it.
const HEAT_DOC = `
## MCP Tools

| Tool | Backing surface | Heat | Tier | Tests |
| --- | --- | --- | --- | --- |
| \`add_item\` | in-memory list | hot | semantic | \`x.test.ts\` |
| \`count_items\` | in-memory list | warm | semantic | \`x.test.ts\` |

## REST routes

| Endpoint | Heat | Tier | Notes |
| --- | --- | --- | --- |
| \`GET /items\` | hot | semantic | — |
`;

describe("heat column lint (ENDPOINT-TIERS.md rule 5)", () => {
  function ruledInventory(): FidelityInventory {
    const inventory = toyInventory();
    inventory.tools[0].heat = "hot";
    inventory.tools[1].heat = "warm";
    inventory.rest[0].heat = "hot";
    return inventory;
  }

  it("parses the Heat column when the header names it, omits it otherwise", () => {
    expect(parseFidelityDocRows(HEAT_DOC, "tool")).toEqual([
      { name: "add_item", fidelity: "semantic", heat: "hot" },
      { name: "count_items", fidelity: "semantic", heat: "warm" },
    ]);
    expect(parseFidelityDocRows(DOC, "tool")).toEqual([
      { name: "add_item", fidelity: "semantic" },
      { name: "count_items", fidelity: "semantic" },
    ]);
  });

  it("passes when documented heat matches the inventory", () => {
    const docs = [
      { label: "FIDELITY.md", kind: "tool" as const, markdown: HEAT_DOC },
      { label: "FIDELITY.md", kind: "rest" as const, markdown: HEAT_DOC },
    ];
    expect(lintFidelityInventory(ruledInventory(), docs)).toEqual([]);
  });

  it("reports heat mismatches between inventory and docs", () => {
    const docs = [{ label: "FIDELITY.md", kind: "tool" as const, markdown: HEAT_DOC }];
    const inventory = ruledInventory();
    inventory.tools[0].heat = "warm";
    expect(lintFidelityInventory(inventory, docs).join("\n")).toContain(
      "inventory says heat 'warm' but FIDELITY.md says 'hot'"
    );
  });

  it("does not lint heat when the doc table has no Heat column", () => {
    const docs = [{ label: "FIDELITY.md", kind: "tool" as const, markdown: DOC }];
    expect(lintFidelityInventory(ruledInventory(), docs)).toEqual([]);
  });

  it("reports duplicate doc rows with conflicting heat", () => {
    const conflicting = HEAT_DOC.replace(
      "| `count_items` | in-memory list | warm | semantic | `x.test.ts` |",
      "| `count_items` | in-memory list | warm | semantic | `x.test.ts` |\n| `count_items` | in-memory list | cold | semantic | `x.test.ts` |"
    );
    const docs = [{ label: "FIDELITY.md", kind: "tool" as const, markdown: conflicting }];
    expect(lintFidelityInventory(ruledInventory(), docs).join("\n")).toContain(
      "documented twice with conflicting heat ('warm' vs 'cold')"
    );
  });
});
