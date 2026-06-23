// SPDX-License-Identifier: Apache-2.0
//
// Canonical loud-501 "unsupported route" envelope for the GitHub twin — CLI
// vendor copy.
//
// Mirrors packages/twin-github/src/unsupported-envelope.ts after FDRS-431:
// twin-only metadata (`fidelity`, `supported_surfaces`) lives under the `_twin`
// namespace so the twin-only fields never collide with real upstream fields.
// Kept in this dependency-light module — no sqlite, no http, no hono — so the
// cross-twin namespace lint (tools/fidelity/lint-twin-namespace.ts) can import
// the real wire shape this CLI ships without booting the app. `app.ts` builds
// its catch-all 501 body from here, so the public 501 contract can never drift
// between the packaged twin and the shipped CLI.

export const unsupportedEnvelope = {
  status: 501,
  body: {
    message: "This endpoint is not supported by this GitHub twin clone.",
    _twin: {
      fidelity: "unsupported" as const,
      supported_surfaces: [
        "GitHub-shaped REST",
        "POST /s/:sid/mcp",
        "GET /s/:sid/mcp/tools",
        "POST /s/:sid/mcp/tools/:name",
        "POST /s/:sid/mcp/call",
      ],
    },
  },
} as const;
