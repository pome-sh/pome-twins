<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/adapter-claude-sdk

Drop-in adapter for Anthropic's `claude-agent-sdk`. Add one import + one call,
and your agent's runs produce overlay signals (`HookEvent` audit rows plus —
under FDRS-408 — `ToolUseEvent` / `ToolResultEvent` payload rows) that let the
Pome correlator stitch your trace into a [`Run`][shared-types] with named lanes,
ordered steps, and a generated fix prompt.

## One-import API

```ts
import { withPome, tool, query } from "@pome-sh/adapter-claude-sdk";

withPome();   // installs globalThis.fetch hook + signals writer

// `tool` and `query` are drop-in replacements for the Anthropic SDK exports
// — wrap your handlers and iterate `query()` exactly the same way.
const myTool = tool(
  "list_open_issues",
  "List open issues on the GitHub twin.",
  schema,
  async ({ owner, repo }) => { /* user code; fetch() inside is tagged */ }
);

for await (const msg of query({ prompt, options })) {
  // each SDK hook fires a HookEvent audit row into the signals file
}
```

That's the whole user-facing surface.

## What it does

| Signal | How it lands |
| --- | --- |
| `tool_call_id` header on outgoing twin requests | Wrapped `tool()` puts an id into `AsyncLocalStorage` for the lifetime of the handler. `globalThis.fetch` is replaced once at `withPome()` time; outgoing requests to **allowlisted twin origins** carry `x-pome-correlation-id: tlc_<hex>`. The twin's recorder reads the header and writes it into the event. |
| `HookEvent` audit row per SDK hook invocation | Wrapped `query()` merges a read-only hook into every entry in the SDK's `HOOK_EVENTS` (PreToolUse / PostToolUse / SubagentStart / PreCompact / PermissionRequest / TaskCreated / SessionStart / …). Each invocation appends one row matching [`hookEventSchema`][shared-types] — `{ts, event_id, parent_id, kind:"HookEvent", hook_name, tool_name}` — to a JSONL sidechannel file (`process.env.POME_ADAPTER_SIGNALS_PATH`). User-supplied hooks in `options.hooks` are preserved. |

## When it's a no-op

- **No `POME_ADAPTER_SIGNALS_PATH`** → no signals file written. The fetch hook
  still installs; the header still flows on allowlisted hosts. This is the
  standalone-dev mode: run your agent without the Pome CLI and nothing crashes.
- **No allowlisted twin hosts** → no header injection (the fetch hook is a
  transparent passthrough). `withPome()` infers the allowlist from
  `POME_TWIN_BASE_URL`, `POME_GITHUB_MCP_URL`, and any
  `POME_*_BASE_URL` / `POME_*_MCP_URL` env var the CLI runner injected. Pass
  `withPome({ twinHosts: ["http://localhost:3333"] })` to override.
- **`fetch()` outside any wrapped tool handler** → no header (the
  `AsyncLocalStorage` scope is empty, so Anthropic API calls from inside
  `claude-agent-sdk` are naturally immune).

## Architecture (FDRS-322 + FDRS-407)

`tool_call_id` lands on the twin's `TwinHttpEvent` at the moment the request
reaches the twin — single source of truth, no race under parallel tool calls.
`HookEvent` rows are written to the sidechannel as each SDK hook fires; they
follow the discriminated-union schema in
[`packages/shared-types/src/recorder-events.ts`][shared-types], so the
correlator (FDRS-412) can merge them into `events.jsonl` by `ts`-ordered
insertion. Hook handlers are read-only — they observe and never mutate the
event the SDK passes them.

Rationale for choosing global `fetch` replacement (with ALS gating + host
allowlist) over a `pomeFetch` helper, sidechannel-only correlation, or
side-effect import is captured in the `[DECISION]` comment on
[FDRS-322](https://linear.app/pome-sh/issue/FDRS-322).

## Caveats

- **HTTP layer is `globalThis.fetch` only.** Node 18+ `undici`, browser fetch,
  most modern HTTP libs route through `fetch` by default. `axios`, `got`, or
  the raw `node:http` module **don't** — wrap your client manually if you use
  one of those, or pin your code to `fetch`.
- **v0 returns an `AsyncGenerator` from `query()`**, not the full `Query`
  interface. Control methods like `interrupt()` or `setPermissionMode()` are
  not re-exposed yet — call `claude-agent-sdk`'s `query` directly if you need
  them. Iteration is what hero scenarios use today.
- **`withPome()` is idempotent.** A second call is a no-op; the global fetch
  replacement is installed exactly once per process.

## Signals file format

One JSON object per line, ordered by emission time. Rows follow the M0
discriminated-union shape in [`shared-types`][shared-types]:

```jsonl
{"ts":"2026-05-26T20:00:00.000Z","event_id":"...","parent_id":null,"kind":"HookEvent","hook_name":"SessionStart","tool_name":null}
{"ts":"2026-05-26T20:00:00.123Z","event_id":"...","parent_id":"toolu_abc","kind":"HookEvent","hook_name":"PreToolUse","tool_name":"list_open_issues"}
{"ts":"2026-05-26T20:00:01.456Z","event_id":"...","parent_id":"toolu_abc","kind":"HookEvent","hook_name":"PostToolUse","tool_name":"list_open_issues"}
```

The correlator (`FDRS-412`) reads this alongside `events.jsonl` and produces a
`Run` with named lanes + ordered steps.

## License

Apache-2.0.

[shared-types]: ../shared-types/src/recorder-events.ts
