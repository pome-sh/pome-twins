// SPDX-License-Identifier: Apache-2.0
//
// Per-SDK scaffold writers for `pome init --sdk <name>`. Each writer produces
// a minimal-but-runnable starter set so a Claude Agent SDK / OpenAI Agents /
// other-framework user reaches a green hosted run in under five minutes.
//
// Both `claude` and `claude-managed` are deferral stubs right now:
//   - `claude` scaffolds an import from `@pome-sh/adapter-claude-sdk`, which is
//     held back from npm until OSS Launch Stage 1. Without the package, the
//     scaffolded file dies at `pome run` with "Cannot find module …". Defer
//     the flag until the publish unblocks it.
//   - `claude-managed` is waiting on Anthropic's Managed Agents API (v2).
// Add new SDKs by appending a writer in SCAFFOLDS below.
//
// See the Claude Agent SDK integration plan (internal docs).

export const SUPPORTED_SDKS = ["claude", "claude-managed"] as const;
export type SupportedSdk = (typeof SUPPORTED_SDKS)[number];

export interface ScaffoldResult {
  agentSdkValue: string;
  agentCommand: string;
  exampleAgentRelativePath: string;
  postInstallHint: string;
}

export async function writeSdkScaffold(
  sdk: SupportedSdk,
): Promise<ScaffoldResult> {
  switch (sdk) {
    case "claude":
      // Deferred — the scaffolded file imports `@pome-sh/adapter-claude-sdk`,
      // which is held back from npm until OSS Launch Stage 1. Until then the
      // scaffold dies at runtime with "Cannot find module …". Recommend the
      // bundled scripted starter (`pome init` without --sdk) for now.
      throw new ClaudeSdkDeferredError();
    case "claude-managed":
      // Deferred — surface reserved so v2 doesn't churn the flag.
      throw new ClaudeManagedDeferredError();
  }
}

export class ClaudeSdkDeferredError extends Error {
  constructor() {
    super(
      "Claude Agent SDK scaffold is gated on the npm publish of " +
        "`@pome-sh/adapter-claude-sdk`, tracked under OSS Launch Stage 1. " +
        "Run `pome init` (without --sdk) for the bundled scripted starter, " +
        "or write your own agent against POME_TASK / POME_GITHUB_REST_URL.",
    );
    this.name = "ClaudeSdkDeferredError";
  }
}

export class ClaudeManagedDeferredError extends Error {
  constructor() {
    super(
      "Claude Managed Agent is not yet supported — three blockers " +
        "(no injection point inside Anthropic-hosted runtime, no sidechannel " +
        "for adapter signals, Managed Agents API still moving). Follow the " +
        "tracking issue for v2 timing. For now, use `pome init` (without --sdk).",
    );
    this.name = "ClaudeManagedDeferredError";
  }
}
