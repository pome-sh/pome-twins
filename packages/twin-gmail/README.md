# `@pome-sh/twin-gmail`

Deterministic Gmail-shaped twin for agent testing (Pome).

**Status: OSS release candidate.** This package includes the deterministic
SQLite mailbox model, strict seed/reset APIs, canonical MIME storage, identity,
delivery, drafts, labels/history/search, bounded semantic state export,
recording projection, the frozen Gmail REST/upload surface, and the captured
ten-tool first-party MCP contract.

## Auth identity (frozen)

| Item | Value |
| --- | --- |
| Claim | `gmail_email` on the Pome session JWT |
| Default local mailbox | `pome-agent@pome-twin.test` |
| Agent token env | `POME_GMAIL_TOKEN` (alias of `POME_AUTH_TOKEN`) |
| Bearer | Pome session JWT — **not** a Google OAuth access token |

Pome owns authentication. This twin does **not** implement Google consent
screens, OAuth codes, refresh tokens, JWKS, or scope issuance.

Mailbox resolution accepts only `me` or the exact `gmail_email` value.
Unknown/cross-mailbox access returns the captured Gmail not-found shape without
revealing mailbox existence.

## Gate 0 artifacts

| Path | Role |
| --- | --- |
| [`fixtures/rest-surface.json`](fixtures/rest-surface.json) | Frozen launch REST method/parameter/media matrix from Gmail v1 discovery |
| [`fixtures/mcp-tools-list.*.json`](fixtures/) | Official Gmail MCP `tools/list` raw + canonical (10-tool launch set) |
| [`fidelity.inventory.json`](fidelity.inventory.json) | Heat × fidelity × evidence for every launch REST/MCP row |
| [`REFERENCE-DIVERGENCES.md`](REFERENCE-DIVERGENCES.md) | Emulate rejected; never an oracle |
| [`LIMITS.md`](LIMITS.md) | Limit placeholders (discovery maxima + TBD local caps) |

See [`fixtures/README.md`](fixtures/README.md) for capture provenance and SHA-256.

## Launch MCP tools (exactly 10)

`create_draft`, `list_drafts`, `get_thread`, `search_threads`, `label_thread`,
`unlabel_thread`, `list_labels`, `label_message`, `unlabel_message`,
`create_label`.

Order and schemas are frozen from the live listing capture (relative order among
the launch set). Three extra preview tools seen live are **out of launch scope**
(named cold in the inventory).

## Named 501 gaps (not fake success)

- `users.watch` / `users.stop` — no Pub/Sub; loud 501
- Resumable upload initiation/chunks — loud 501
- Filter `action.forward` — loud 501 (no forwarding delivery)
- `processForCalendar=true`, `deleted=true` on insert/import — loud 501

## Non-goals

- External SMTP / network mail delivery (`messages.send` is a mailbox-state transition)
- Pub/Sub push notifications
- Google OAuth/OIDC
- Calendar, Drive, Contacts, client UI, CSE, delegates, S/MIME, admin controls
- HTTP batch API
- Resumable upload
- Expanding MCP beyond the frozen 10-tool launch set without a new Gate 0 ruling

## Limits

See [`LIMITS.md`](LIMITS.md). Defaults/maxima from discovery are frozen in
`rest-surface.json`; local twin caps will be pinned with tests in later PRs.

## Development

```bash
npm test -w @pome-sh/twin-gmail
npm run typecheck -w @pome-sh/twin-gmail
```

Fixture smoke tests assert launch tool count/order and that watch/stop are
marked `named_gap_501`; domain tests cover seed/identity, MIME round-trip,
draft replacement, message labels and computed thread labels, history, search,
local delivery/Bcc privacy, state export, and recorder payload projection.

## CLI

```bash
npx @pome-sh/cli twin start gmail
# prints POME_GMAIL_REST_URL, POME_GMAIL_MCP_URL, POME_AUTH_TOKEN,
# and the identical POME_GMAIL_TOKEN alias
```

Use `pome scenarios gmail --copy` for the inbox-triage and captured first-party
MCP parity scenarios. Hosted rollout is gated separately; see
[`HOSTED.md`](HOSTED.md).
