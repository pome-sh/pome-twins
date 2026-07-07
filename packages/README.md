# `packages/`

Bun workspaces (`packages/*` in root `package.json`).

## Product twins (what we sell)

Three packages — each a shippable digital twin runtime:

| Directory | npm name |
| --- | --- |
| [`twin-github/`](./twin-github/) | `@pome-sh/twin-github` |
| [`twin-stripe/`](./twin-stripe/) | `@pome-sh/twin-stripe` |
| [`twin-slack/`](./twin-slack/) | `@pome-sh/twin-slack` |

Each directory above has its own README with images, ports, and the shared contract.

## Support packages (not twins)

| Directory | npm name | Role |
| --- | --- | --- |
| [`shared-types/`](./shared-types/) | `@pome-sh/shared-types` | Zod schemas, recorder/scenario types |
| [`sdk/`](./sdk/) | `@pome-sh/sdk` | Twin authoring SDK |
| [`adapter-claude-sdk/`](./adapter-claude-sdk/) | `@pome-sh/adapter-claude-sdk` | Claude Agent SDK adapter |

The end-user **`pome` CLI** lives at repo root [`cli/`](../cli/), not under `packages/`.
