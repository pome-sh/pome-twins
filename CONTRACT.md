# Twin Runtime Contract

**Version 1.0.0** — frozen 2026-07-07 (FDRS-711), verified by the black-box suite in [`contract/`](./contract/).

This document enumerates everything pome-cloud (and the pome CLI) may rely on when booting and driving a twin. **Changing any item below is a breaking contract change**: update this document and the suite in the same PR, then open the matching pome-cloud consumer PR that pins and verifies the new signed twin artifact (rule of record: `packages/twin-github/README.md`, runtime-contract section).

## Boot

- Entry point: `node dist/src/server.js` with **cwd = the twin package root** (`packages/twin-<name>`).
- `GET /healthz` answers **200 within 3 seconds** of spawn.
- The twin **refuses to boot** on a non-loopback bind host without `TWIN_AUTH_SECRET` (exit code ≠ 0; the error names the variable).
- Runtime dependency arrangement: hoisted `node_modules` + `packages/shared-types` **with its compiled runtime JS** + `packages/sdk` **with its built `dist/`** (the twins are engine plugins since F-682/683/684; the runtime image ships the sdk so the hoisted workspace symlink resolves) (`npm run build:runtime -w @pome-sh/shared-types`). `@pome-sh/shared-types` exports `./src/index.ts`, so a plain-`node` boot relies on type stripping (**Node ≥ 22.18**) plus the built `src/*.js` files for its `.js` import specifiers. The GHCR runtime image ships `node:24`; the Dockerfiles are the reference implementation of this arrangement.

## Environment surface

| Variable | Meaning | Default |
|---|---|---|
| `PORT` / `<TWIN>_CLONE_PORT` | listen port | `3333` |
| `GITHUB_CLONE_HOST` / `SLACK_CLONE_HOST` / `STRIPE_CLONE_HOST` | bind host | `127.0.0.1` |
| `GITHUB_CLONE_DB` / `SLACK_CLONE_DB` / `STRIPE_CLONE_DB` | SQLite path or `:memory:` | `.<twin>_clone/<twin>.db` |
| `<TWIN>_CLONE_NO_SEED=1` | skip the default seed at boot | seed applied |
| `POME_SEED_JSON` | cloud-supplied seed applied at boot (FDRS-353) | default seed |
| `TWIN_AUTH_SECRET` | HS256 secret for session JWTs + provider-shaped tokens | dev-only fallback; **required** in production / on non-loopback hosts |
| `TWIN_ADMIN_TOKEN` | switches `/admin/*` to `X-Admin-Token` auth (timing-safe compare) | loopback-only socket check |
| `POME_RUN_ID` | recorder run id stamped on events | `"spawn"` |
| `POME_TWIN_VERSION` / `POME_TWIN_GIT_SHA` / `POME_TWIN_BUILD_TIME` | `/healthz` `runtime` block | `0.1.0` / `dev` / `dev` |
| `SLACK_DETERMINISTIC_TS` | deterministic Slack message timestamps | — |
| `NODE_ENV=production` | strict secret requirement; admin gate denies unknown peer addresses | — |

## Control plane (all twins)

- `GET /healthz` — root, **no auth**: `{ok: true, twin, implementation, tools, runtime: {package, version, git_sha, build_time}}`, `tools` > 0. Invariant: `healthz.tools` equals the length of the MCP tool list.
- `POST /admin/reset`, `POST /admin/seed` — **no bearer**. Gate: `TWIN_ADMIN_TOKEN` mode (header `X-Admin-Token`, 403 when missing/wrong) or loopback-only **socket** check — proxy/client headers are never trusted (`packages/sdk/src/admin-gate.ts`); with `NODE_ENV=production` an unknown peer address is denied.
- Session mount `/s/:sid/*` — bearer JWT, HS256 over `TWIN_AUTH_SECRET`, claims `{sid, team_id, exp, …}`; the `sid` claim must equal the path `:sid`. Provider-shaped tokens (`ghp_/github_pat_pome_*`, `xox[bp]-pome-*`, `sk_test_pome_*`) are also accepted per twin.
- `GET /s/:sid/_pome/health` → 200 `{ok: true, twin, …}`.
- `GET /s/:sid/_pome/state` → 200 JSON object — the redacted state export that feeds cloud-side `[D]` scoring.
- `GET /s/:sid/_pome/events` → 200 JSON array — the recorder tape fetched at end of run.
- MCP: `GET /s/:sid/mcp/tools` → `{tools: […]}`; `POST /s/:sid/mcp` (streamable-HTTP JSON-RPC, stateless — `GET`/`DELETE` answer 405); legacy `POST /s/:sid/mcp/tools/:name` and `POST /s/:sid/mcp/call` (`{tool, arguments}`).
- Reserved prefixes: `/_pome/*` and `/mcp/*` under the session mount belong to the platform (OQ-B6); domain routes must not shadow them.
- Unknown **session** routes → **501** loud-unsupported envelope advertising `fidelity: "unsupported"` and the supported surfaces.

## Per-twin frozen differences (as observed 2026-07-07)

Several rows are under active ruling in FDRS-712. They are frozen **as-is**: changing them later is a deliberate contract change, never a port side effect.

| Surface | github | slack | stripe |
|---|---|---|---|
| `/healthz` `fidelity` field | `"semantic"` | absent | `"semantic"` |
| `/healthz` extras | `access_control` | — | `tthw_seconds` |
| `GET /s/:sid/healthz` | 200 `{ok, sid}` | 200 `{ok, sid}` | **501** (route absent) |
| `/admin/seed` with garbage body | **422** validation error | 200 accepted | 200 accepted |
| no / invalid bearer | 401 `{message: "Bad credentials"}` | 401 `{ok:false, error:"not_authed"/"invalid_auth"}` | 401 `{error:{code:"unauthorized"}}` |
| expired JWT | 401 `"Bad credentials"` | 401 `error:"token_expired"` | 401 `unauthorized` |
| sid mismatch | 401 `{message:"Forbidden"}` | 401 `invalid_auth` | **403** `{error:{code:"forbidden"}}` |
| raw bearer (no `Bearer ` prefix) | 401 rejected | 401 rejected | **200 accepted** |
| unknown tool via `/mcp/call` | 422 validation | 404 `unknown_tool` | 400 `tool_unknown` |
| unknown **root** route | 404 | 404 | **401** (the `/v1` auth wall answers first) |
| root `/v1/*` SDK-compat mount (no path sid; bearer alone) | — | — | yes |
| extra session routes | `/_pome/access-control` | — | — |

### Body-parsing and tape corners (pinned 2026-07-08, F-683 review)

Probed against the pre-engine builds (`3cd86eb`); the contract suite asserts every row.

| Surface | github | slack | stripe |
| --- | --- | --- | --- |
| `/admin/seed` form-encoded body | 400 `Problems parsing JSON` | **500** `internal_error` (admin surface has its own envelope; the form value fails the seed schema) | 200 accepted |
| `/admin/seed` malformed JSON | 400 `Problems parsing JSON` | 200 `{ok:true}` (tolerant parse collapses to `{}`) | 200 accepted (defaults applied) |
| legacy `/mcp/call` `{name}/{params}` alias keys | 422 validation (`tool` missing) | **accepted** — aliases of `{tool}/{arguments}` | 400 `parameter_invalid` (`tool`) |
| legacy `/mcp/call` form-encoded body | 400 `Problems parsing JSON` | dispatched | dispatched |
| legacy `/mcp/call` malformed JSON | 400 `Problems parsing JSON` | 400 `{ok:false, error:"invalid_arguments"}` | 400 `parameter_invalid` (`tool`) |
| `GET /s/:sid/_pome/health` exact keys | `ok, twin, implementation, fidelity, runtime` | `ok, twin` | `ok, twin, implementation, fidelity, runtime, tthw_seconds, recorder` |
| `/_pome/state` fetches on the recorder tape | never | never | never |
| `/admin/seed` on the recorder tape | recorded, `state_delta: null` | recorded, `state_delta: null` | not recorded |

## Verifying

```
npm run test:contract
```

builds the shared-types runtime + the three twins, then runs `node --test contract/contract.test.mjs`. The suite is dependency-free (node:test, global fetch, node:crypto) so the same file can be pointed at any built twin artifact — including a cloud-built snapshot (FDRS-714).
