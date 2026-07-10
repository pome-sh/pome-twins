# @pome-sh/sdk

## 0.3.0 — 2026-07-10

Durable write-through recorder (the CLI's crash-safe local runs build on this;
unblocks the `pomecli` first publish, F-727).

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
