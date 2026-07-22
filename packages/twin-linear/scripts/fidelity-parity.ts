// SPDX-License-Identifier: Apache-2.0
/**
 * fidelity:parity for twin-linear — inventory MCP names must match the live
 * `linearTools` export, and every graphql-surface.json operation must be listed
 * in the inventory GraphQL rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { linearTools } from "../src/mcp.js";

type InventoryTool = { name: string; heat?: string; fidelity?: string };
type InventoryGraphql = { name: string; heat?: string; fidelity?: string };

type Inventory = {
  twin: string;
  tools: InventoryTool[];
  graphql?: InventoryGraphql[];
};

type GraphqlSurface = {
  queries: string[];
  mutations: string[];
  /** Named HTTP auth routes (not credentials). */
  authRoutes?: string[];
};

const root = join(import.meta.dirname, "..");
const inventory = JSON.parse(
  readFileSync(join(root, "fidelity.inventory.json"), "utf8"),
) as Inventory;
const surface = JSON.parse(
  readFileSync(join(root, "fixtures", "graphql-surface.json"), "utf8"),
) as GraphqlSurface;

const failures: string[] = [];

const liveToolNames = linearTools.map((tool) => tool.name).sort();
const inventoryToolNames = inventory.tools.map((tool) => tool.name).sort();

if (JSON.stringify(liveToolNames) !== JSON.stringify(inventoryToolNames)) {
  failures.push(
    `MCP tool name mismatch.\n  live: ${liveToolNames.join(", ")}\n  inventory: ${inventoryToolNames.join(", ")}`,
  );
}

if (inventory.twin !== "linear") {
  failures.push(`inventory.twin must be "linear" (got ${inventory.twin})`);
}

const inventoryGraphqlNames = new Set((inventory.graphql ?? []).map((row) => row.name));
const surfaceOps = [...surface.queries, ...surface.mutations, ...(surface.authRoutes ?? [])];
for (const op of surfaceOps) {
  if (!inventoryGraphqlNames.has(op)) {
    failures.push(`graphql-surface op missing from inventory.graphql: ${op}`);
  }
}

if (failures.length > 0) {
  console.error("twin-linear fidelity:parity failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const surfaceOpCount = surfaceOps.length;
console.log(
  `twin-linear fidelity:parity ok — ${liveToolNames.length} MCP tools, ${surfaceOpCount} GraphQL surface ops`,
);
