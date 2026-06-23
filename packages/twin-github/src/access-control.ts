// SPDX-License-Identifier: Apache-2.0
import {
  GITHUB_ACCESS_CONTROL_CATALOG,
  githubAccessControlToolNames,
  summarizeGitHubAccessControlCatalog,
} from "@pome-sh/shared-types";
import { toolDefinitions } from "./tools.js";

/** Every sandboxed tool exists in the MCP catalog. */
export function assertAccessControlCatalogMatchesTools() {
  const toolNames = new Set<string>(toolDefinitions.map((tool) => tool.name));
  const missing = githubAccessControlToolNames().filter((name) => !toolNames.has(name));
  if (missing.length > 0) {
    throw new Error(`access-control catalog references unknown tools: ${missing.join(", ")}`);
  }
}

export function githubAccessControlPayload() {
  assertAccessControlCatalogMatchesTools();
  return {
    ...GITHUB_ACCESS_CONTROL_CATALOG,
    summary: summarizeGitHubAccessControlCatalog(),
  };
}

export {
  GITHUB_ACCESS_CONTROL_CATALOG,
  summarizeGitHubAccessControlCatalog,
} from "@pome-sh/shared-types";
