# @pome-sh/sdk

## 0.5.0 — 2026-07-20

Additive MCP / recorder contract for the upcoming Gmail twin. Existing
GitHub, Slack, and Stripe tool listings and calls stay byte-identical when
the new optional fields are unset.

- `ToolSpec.title` / `ToolSpec.outputSchema` — optional MCP list metadata;
  successful JSON-RPC `tools/call` includes `structuredContent` only when
  `outputSchema` is declared.
- `toolListExtras()` helper keeps optional list keys absent when unset.
- Upstream `annotations` remain independent of `ToolSpec.mutation`
  (mutation is still local-state truth for the recorder).
- `TwinDefinition.recordingProjection` — optional pre-redaction event
  projection (MIME/attachment digests before secret scrubbing).

No breaking changes; `{before,after}` `state_delta` unchanged.

## 0.4.0 — 2026-07-13

Publish the `ensureTwinAuthSecret` server helper so the digest-pinned twin
snapshot build (which installs the published SDK, not the workspace copy) can
compile the twins that now call it on non-loopback boot.

- New export `ensureTwinAuthSecret(twin, host)` from `@pome-sh/sdk/server`
  (added workspace-side in #109; `twin-{github,slack,stripe}` call it and now
  pin `@pome-sh/sdk@0.4.0`).

No breaking changes.

## 0.3.1 — 2026-07-10

SQLite driver swapped from `better-sqlite3` to the `node:sqlite` builtin
(F-703) — zero native dependencies; a fresh install needs no compiler
toolchain.

- `openTwinDatabase()` / `TwinDatabase` reimplemented on `node:sqlite`:
  same-shape `transaction(fn)` (+ `.immediate`) backed by
  `BEGIN [IMMEDIATE]`/`COMMIT`/`ROLLBACK`, joining an already-open
  transaction via `SAVEPOINT` (better-sqlite3's nesting semantics).
  `TwinRunResult` shape unchanged.
- `better-sqlite3` dropped from `peerDependencies` — nothing native to
  install, optional or otherwise.

No API changes.

## 0.3.0 — 2026-07-10

Durable write-through recorder (the CLI's crash-safe local runs build on this;
unblocks the `@pome-sh/cli` first publish, F-727).

- New server exports: `createFileBackedRecorderStore` — a file-backed
  `RecorderStore` that streams twin HTTP events write-through to the run's
  `events.jsonl`, so runs survive process death without duplicating finalize
  rows — and `toTwinHttpEventRow`.
- `RecorderStore` gains `flush()` and `close()`.

No breaking changes; additive only.

## 0.2.0

First npm-published release (F-714). The twin engine: `defineTwin()` +
`serve()` — HTTP mounting, bearer auth, recorder + redaction, MCP dispatch,
SQLite driver, and the admin gate behind every first-party twin.

### Breaking changes

- Removed the deprecated `localhostOnly` re-export from the server surface
  (FDRS-616). It was a back-compat alias for `requireAdminAuth` — import
  `requireAdminAuth` instead; semantics are identical.

### Changes

- The admin gate is now the shared mirrored `admin-gate.ts` module, and the
  client IP it checks comes from a runtime-neutral accessor: an explicit
  `setClientIp()` override set by the serving bridge, falling back to
  `@hono/node-server/conninfo`'s official `getConnInfo` helper — no more
  reads of the bridge-private `c.env.incoming.socket` shape (FDRS-587).
  Gate semantics are unchanged: timing-safe `X-Admin-Token` when
  `TWIN_ADMIN_TOKEN` is set, loopback-only otherwise, default-deny on
  unknown remote in production.

## 0.1.0

Initial version.
