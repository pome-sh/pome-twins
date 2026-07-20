# Reference divergences — Emulate is not an oracle

Emulate (and similar Gmail fakes) may be useful as a **coverage checklist** for which
surfaces agents poke. They are **never** a behavioral oracle for `@pome-sh/twin-gmail`.

The oracles for this twin are:

1. Frozen Gmail API v1 discovery → [`fixtures/rest-surface.json`](fixtures/rest-surface.json)
2. Captured / documented official Gmail MCP listing → [`fixtures/mcp-tools-list.canonical.json`](fixtures/mcp-tools-list.canonical.json)
3. Sanitized live Gmail REST captures (when reconciled later)
4. This package’s invariants (draft ID replacement, mailbox-local IDs, no false watch success, etc.)

## Explicitly rejected Emulate-known-bad behaviors

| Rejected behavior | Twin rule |
| --- | --- |
| **In-place draft message IDs** — updating a draft keeps the same underlying Gmail message id | Draft **id** is stable; each update **replaces** the underlying Gmail message id. Send deletes the draft/draft message and creates a new `SENT` message id. |
| **Permissive malformed JSON** — accepting broken bodies / wrong types with silent coercion | Reject malformed JSON and schema violations with the captured Gmail/MCP error envelope. No silent coercion. |
| **Numeric offset page tokens** — `pageToken` as an integer offset | Page tokens are opaque, versioned, tamper-evident, bound to mailbox/route/query/sort/snapshot. Malformed/cross-query tokens fail loudly. |
| **Shallow search** — substring-only or partial operator support presented as Gmail search | Implement the full operator grammar declared by the captured `search_threads` tool; message-first match then thread expansion. |
| **Incomplete settings methods** — advertising filters/sendAs/forwarding while omitting declared launch methods or inventing extras | Launch settings surface is exactly the frozen set in `rest-surface.json` (`filters` list/get/create/delete, `forwardingAddresses` list/get, `sendAs` list/get). Everything else is unsupported/501. |
| **Nondeterministic values** — random ids, wall-clock-only dates, unordered collections | Reset/seed produces deterministic ids, dates, and sorted exports. Tests pin order and values. |
| **Successful inert `watch` / `stop`** — HTTP 200 registration that does nothing | `users.watch` and `users.stop` are **named gaps** returning the loud **501** unsupported envelope. No fake Pub/Sub success. No network I/O. |

## Other non-oracles

- Google OAuth/OIDC consent screens, refresh tokens, JWKS, and scope issuance are **out of scope**. Pome session auth + frozen `gmail_email` claim only.
- External SMTP delivery, Pub/Sub push, forwarding delivery, Calendar, Drive, Contacts, CSE, HTTP batch, and resumable upload are **out of scope** (loud failure, never silent success).
- Live Developer Preview MCP may expose tools beyond the launch 10; the twin does **not** expand the listing to chase preview drift without a new Gate 0 ruling.
