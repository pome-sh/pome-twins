<!--
SPDX-License-Identifier: Apache-2.0
-->

# @pome-sh/sdk

The twin engine behind [Pome](https://pome.sh) digital twins. A twin is a
declaration — its domain, tools, and frozen wire shapes — and this engine
supplies all of the mechanism: HTTP mounting, bearer auth, the trace
recorder with secret redaction, MCP dispatch, SQLite-backed state, and the
admin reset/seed gate.

The first-party twins ([`@pome-sh/twin-github`](https://www.npmjs.com/package/@pome-sh/twin-github),
[`@pome-sh/twin-slack`](https://www.npmjs.com/package/@pome-sh/twin-slack),
[`@pome-sh/twin-stripe`](https://www.npmjs.com/package/@pome-sh/twin-stripe))
are thin plugins on this engine.

## Install

```bash
npm install @pome-sh/sdk
```

## Usage

```ts
import { defineTwin } from "@pome-sh/sdk";
import { serve } from "@pome-sh/sdk/server";

const twin = defineTwin({
  id: "my-service",
  version: "0.1.0",
  domain: ({ db, seed }) => createMyDomain(db, seed),
  tools: [/* ToolSpec[] — name, zod schema, handler */],
});

await serve(twin, { port: 3333 });
// GET /healthz, /s/:sid/* (bearer-gated), MCP surfaces, and /admin/reset
// are mounted by the engine.
```

Every engine-booted twin honors the frozen runtime contract in
[`CONTRACT.md`](https://github.com/pome-sh/pome-twins/blob/main/CONTRACT.md)
— entry point, env surface, `/healthz` shape, auth, and MCP surfaces.

## Recorder (twin-core home)

The trace recorder lives in this package (`packages/sdk/src/recorder.ts`).
There is no separate `packages/twin-core` — F-681 folded twin-core into
`@pome-sh/sdk`. Default boot uses an in-memory store; set
`POME_RECORDER_EVENTS_PATH` to enable durable write-through (`flush` /
`close`, TwinHttpEvent NDJSON). Redaction always runs in the handle *before*
`store.record()`, including for custom stores.

**Architecture (F-698 / §9 Q3):** recorder *transport* belongs in twin-core
(`@pome-sh/sdk`). Twins inherit durability via `resolveRecorderStore()` /
`POME_RECORDER_EVENTS_PATH`; the self-host CLI harness passes the run's
`events.jsonl` path into the same store. Disk rows are already
`TwinHttpEvent`-shaped so upload/finalize byte shape is unchanged.

## Docs

Full documentation at [docs.pome.sh](https://docs.pome.sh). Source and
issues at [pome-sh/pome-twins](https://github.com/pome-sh/pome-twins).

## License

Apache-2.0
