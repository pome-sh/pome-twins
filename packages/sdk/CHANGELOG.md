# @pome-sh/sdk

## 0.2.0

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
