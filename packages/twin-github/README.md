# Pome Twin: GitHub

> One of three twins in this repository (GitHub, Stripe x402, Slack).

`@pome-sh/twin-github` is a local, stateful GitHub twin for agent testing. It exposes GitHub-shaped REST routes plus a 62-tool MCP-style API backed by the same SQLite domain services.

## Quickstart

```bash
bun install
bun run seed
export TWIN_AUTH_SECRET=$(openssl rand -hex 32)
bun run dev

# Docker (from monorepo root; default compose service, port 3333):
# docker compose up -d
# curl http://127.0.0.1:3333/healthz
```

GitHub-shaped REST + MCP routes live under `/s/:sid/*` and require a
bearer token whose `sid` claim matches the URL `:sid`. `/healthz` and
`/admin/*` stay at the root (admin is localhost-only).

```bash
# Mint a token (32-char minimum secret recommended; use the SAME secret as the server)
TOKEN=$(node -e "import('hono/jwt').then(m => m.sign({ sid: 'demo', team_id: 'tm_1', exp: Math.floor(Date.now()/1000)+3600 }, process.env.TWIN_AUTH_SECRET).then(t => console.log(t)))")

# Public health probe — no auth
curl http://127.0.0.1:3333/healthz

# Session-scoped routes — auth required, sid in path must equal sid in claim
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3333/s/demo/repos/acme/api/issues/1
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3333/s/demo/mcp/tools

curl -s -X POST http://127.0.0.1:3333/s/demo/mcp/call \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"tool":"search_repositories","arguments":{"query":"acme"}}'
```

The default seed creates:

- `acme/api`
- default branch `main`
- files `README.md` and `src/index.ts`
- labels `bug`, `feature`, and `question`
- issue `#1`, titled `500 error on POST /orders after deploy`
- users/orgs `acme`, `alice`, `bob`, and `pome-agent`

## APIs

- REST base URL: `http://127.0.0.1:3333`
- **Real MCP (JSON-RPC, Streamable HTTP, stateless):** `POST /s/:sid/mcp`
  — speaks the protocol the `@modelcontextprotocol/sdk` `Client` +
  `StreamableHTTPClientTransport` expect (`initialize`, `tools/list`,
  `tools/call`, `ping`, `notifications/*`). 62 tools exposed via
  `tools/list` with camelCase `inputSchema`.
- Legacy custom MCP routes (compat surface for already-deployed agents):
  - `GET  /s/:sid/mcp/tools` — returns `{ tools: [{ name, description, input_schema }, ...] }`
  - `POST /s/:sid/mcp/tools/:name` — body is the tool's arguments object
  - `POST /s/:sid/mcp/call` — body `{ tool, arguments }`

All session-scoped REST and MCP routes require a bearer token whose `sid`
claim matches the path. Mutating operations write to SQLite inside transactions
and append to `audit_log`.

### Connecting from `@modelcontextprotocol/sdk` or the Anthropic Agent SDK

```ts
// Anthropic claude-agent-sdk mcpServers config
mcpServers: {
  github: {
    type: "http",
    url: `${TWIN_BASE_URL}/s/${sid}/mcp`,
    headers: { Authorization: `Bearer ${token}` }
  }
}
```

The endpoint is stateless: each POST is independent; no `Mcp-Session-Id`
round-trip, no SSE. `GET` and `DELETE` on `/s/:sid/mcp` return 405. The
bearer-auth contract is unchanged — the JWT `sid` claim (or
`ghp_pome_<sid>_<hmac>` PAT) still has to match the path's `:sid`.

### Tracing parity

Every `tools/call` reaching `/s/:sid/mcp` produces one recorder event whose
`request_body` is `{ tool, arguments }` and whose `response_body` is the raw
domain return — identical to what `POST /s/:sid/mcp/call` records. The
only intentional difference is `path`. Run `bun run validate:mcp` to
regenerate the side-by-side diff in `scripts/validate-mcp.output.txt`.

## Runtime contract (for snapshot consumers)

`pome-cloud` builds a Vercel Sandbox snapshot from this package's source. The
following constraints must hold for that build to succeed and for the resulting
snapshot to boot. Changing any of these is a breaking change for hosted; coordinate
via a cross-repo PR.

### Build

- Package is `npm install`-able from `package.json` alone (no `workspace:*`
  protocols, no bun-only deps; no committed lockfile is required, the snapshot
  build regenerates one on each rebuild)
- `npm run build` exits 0 and emits `dist/src/server.js`
- Built output is loadable under Node 22 — the snapshot runs `runtime: "node22"`.
  No Bun-only N-API consumers (see oven/bun#4290 for context on `better-sqlite3`).

### Runtime

- Server entry: `node dist/src/server.js` (cwd = package root)
- Listens on `:3333`
- Honors `GITHUB_CLONE_HOST=0.0.0.0` env (default `127.0.0.1` is unreachable
  via Vercel Sandbox port forwarding)
- `GET /healthz` returns 200 within ~3s of process start (the snapshot build
  sleeps 3s after `node dist/src/server.js` before probing)
- All admin routes are localhost-only (`/admin/*`)
- Bearer auth at `Authorization: Bearer <jwt>` — engine mechanism (`@pome-sh/sdk`), shape pinned in `src/twin.ts` (F-712)

### Cross-repo coordination

- Bumping any of the above = open a cross-repo PR (this repo + `pome-cloud`)
- The cloud-side snapshot build script lives at
  `pome-cloud/notes/poc-vercel-sandbox/build-twin-github-template.ts`
- The snapshot manifest at `pome-cloud/notes/poc-vercel-sandbox/twin-snapshot.json`
  records the OSS git sha each snapshot was built from

## Review harness

The side-by-side review uses three tests:

- `functional-pr-flow`: create repo, create branch, write file, open PR, approve PR, merge PR, read merged file.
- `negative-fidelity`: missing file must fail, creating a file must succeed, stale update with the wrong `sha` must fail.
- `concurrency-stress`: eight concurrent writes to the same file path; exactly one create should win and the final file should be readable.

Run against local:

```bash
PORT=3333 GITHUB_CLONE_DB=.github_clone/review-harness.db bun run dev
REVIEW_TARGET=local bun run review:harness
```

Keep agent assertions behavior-based: compare invariants (PR merged, stale `sha` rejected), not hard-coded IDs or SHAs.

## Use In A New Project

1. Install and start the twin:

```bash
cd ~/pome/packages/twin-github
bun install
GITHUB_CLONE_DB=.github_clone/my-project.db bun run dev
```

2. Reset or seed state before each run:

```bash
curl -X POST http://127.0.0.1:3333/admin/reset
```

For a project-specific seed, post JSON to `/admin/seed`:

```bash
curl -s -X POST http://127.0.0.1:3333/admin/seed \
  -H 'content-type: application/json' \
  -d '{
    "users": [
      { "login": "my-org", "type": "Organization", "name": "My Org" },
      { "login": "agent-user", "type": "User", "name": "Agent User" }
    ],
    "repositories": [
      {
        "owner": "my-org",
        "name": "my-app",
        "description": "Repository under test",
        "default_branch": "main",
        "collaborators": ["agent-user"],
        "labels": [
          { "name": "bug", "color": "d73a4a", "description": "Something is broken" }
        ],
        "files": [
          { "path": "README.md", "content": "# My App\n" },
          { "path": "src/index.ts", "content": "export const ok = true;\n" }
        ],
        "issues": [
          {
            "number": 1,
            "title": "Fix checkout error",
            "body": "Users see a 500 after submitting checkout.",
            "labels": ["bug"],
            "assignees": []
          }
        ]
      }
    ]
  }'
```

3. Give your agent these inputs:

- `POME_GITHUB_REST_URL=http://127.0.0.1:3333`
- `POME_GITHUB_MCP_URL=http://127.0.0.1:3333/s/demo/mcp`
- `GITHUB_MCP_TOKEN=<JWT whose sid claim is demo>`
- task text that names the exact repo, branch, issue, file, or PR it should touch
- the expected actor, usually `pome-agent`
- whether it should use REST or MCP

4. Keep agent assertions behavior-based:

- good: "PR was merged and `claude-agent.txt` exists on `main`"
- good: "wrong `sha` update fails"
- bad: "PR number is exactly `1`"
- bad: "commit SHA equals this hard-coded value"

## Claude Agent Example

`examples/claude-github-agent.ts` is a tiny Claude-powered GitHub agent. It reads `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` from `../discord/.env` or from the process environment.

Run against local:

```bash
GITHUB_MCP_URL=http://127.0.0.1:3333/s/demo/mcp bun run agent:claude -- \
  "Create a branch, push claude-agent.txt, open a pull request, approve it, and merge it in acme/api."
```

The example captures the PR number returned by `create_pull_request` and reuses it for review and merge calls.

## Local Commands

```bash
bun run typecheck
bun test
bun run smoke
bun run fidelity:parity
bun run validate:mcp # rewrites scripts/validate-mcp.output.txt
bun run review:harness
bun run agent:claude
```

`bun run capture:fixtures` uses `gh api` to refresh sanitized response-shape fixtures when GitHub CLI auth is available.

## Pome CLI Entry Point

The user-facing `pome` CLI lives at [`cli/`](../../cli/) in this repo. From `cli/`:

```bash
bun run dev -- twin start github --port 3333
```

The command prints:

```bash
POME_GITHUB_REST_URL=http://127.0.0.1:3333
POME_GITHUB_MCP_URL=http://127.0.0.1:3333/s/<sid>/mcp
```
