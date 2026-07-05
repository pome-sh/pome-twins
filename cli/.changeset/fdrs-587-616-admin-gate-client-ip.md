---
"pome-sh": patch
---

The twins' admin gate (`POST /admin/reset`, `/admin/seed`) is now one shared,
byte-identical mirrored module (`admin-gate.ts`) instead of per-twin copies
(FDRS-616), and the client IP used for its loopback-only check comes from a
runtime-neutral accessor — an explicit `setClientIp()` override first, then
the serving bridge's official `@hono/node-server/conninfo` helper — instead of
reaching into the bridge-private `c.env.incoming.socket` shape (FDRS-587).
Gate semantics are unchanged: timing-safe `X-Admin-Token` when
`TWIN_ADMIN_TOKEN` is set, loopback-only otherwise, default-deny on unknown
remote in production. The back-compat `localhostOnly` alias is removed; use
`requireAdminAuth`. Mirrors live in `packages/sdk`, the three twins, and
`cli/src/twin-{github,slack}`, enforced by
`scripts/check-admin-gate-mirrors.mjs` in CI.
