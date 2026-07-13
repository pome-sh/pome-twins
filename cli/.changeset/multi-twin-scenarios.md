---
"@pome-sh/cli": minor
---

Native multi-twin scenario support. Scenarios can now exercise more than one twin
in a single session:

- `## Success Criteria` markers accept an optional twin tag — `[D:<twin>]` /
  `[P:<twin>]` — that attributes each criterion to a specific twin. In a
  multi-twin scenario every `[D]` must carry a tag; single-twin scenarios are
  unchanged (a bare marker attributes to the sole twin).
- `## Seed State` for a multi-twin scenario is a per-twin envelope
  `{ <twin>: <seed> }`; a twin with no envelope key gets its default seed.
  Single-twin seeds stay flat and byte-identical.
- Hosted runs fan the twin environment out per twin —
  `POME_<TWIN>_REST_URL` / `POME_<TWIN>_MCP_URL` for each twin — capture and
  upload each twin's state, and finalize with per-criterion twin attribution.
- `pome session create` accepts repeated `--twin` flags for an ad-hoc
  multi-twin session and can now target the Slack twin.
- `pome register agent --twins github,slack` records the agent's enabled
  services and prints them back.

New CLI × older cloud degrades gracefully: an old control plane that rejects a
multi-twin session is reported with a clear hint, and single-twin behavior is
unchanged end to end.
