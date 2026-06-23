// SPDX-License-Identifier: Apache-2.0
//
// Canonical loud-501 "unsupported route" envelope for the GitHub twin.
//
// Twin-only metadata (`fidelity`, `supported_surfaces`) lives under the `_twin`
// namespace, matching twin-slack / twin-stripe (FDRS-431 clean cutover). Kept in
// this dependency-light module — no sqlite, no http, no hono — so the cross-twin
// namespace lint (tools/fidelity/lint-twin-namespace.ts) can import the real
// wire shape without booting the app. `app.ts` builds its catch-all body from
// here, so the lint can never drift from what ships.

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
