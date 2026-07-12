# Slack Twin Fidelity

`@pome-sh/twin-slack` is a high-fidelity test double of the Slack Web API —
not a universal clone. This page documents exactly which surfaces are
faithful to real Slack today, at what tier, and how fidelity is verified.

Last verified: 2026-07-12.

## What "fidelity" means here

Each MCP tool and REST route is classified into one of three tiers:

- **`semantic`** — the stateful behavior is implemented locally and covered
  by tests. Message threading, channel membership, reaction uniqueness, ts
  monotonicity, and the rest behave the way agents expect when they call
  real Slack.
- **`shape`** — the response envelope matches real Slack but some
  underlying behavior is simplified. Useful for agents that only inspect
  fields, not safe for agents that rely on side effects.
- **`unsupported`** — not implemented. The twin returns a loud 501 envelope
  with `_twin.fidelity: "unsupported"` so an agent never silently succeeds
  against a missing surface.

Fidelity ("how deep a surface *is*") is one of two orthogonal dimensions; the
other is **heat** ("how deep it *should* be", `hot`/`warm`/`cold`, ruled per
milestone). The engine-level rubric — tier criteria, target mapping, gap and
tier-mismatch semantics — lives at
[`packages/sdk/ENDPOINT-TIERS.md`](../sdk/ENDPOINT-TIERS.md). The `Tier`
column below means fidelity; the `Heat` column carries the twin-slack ruling
(F-729 `[DECISION]`, 2026-07-11, implemented by F-736). Where ruled heat is
below current fidelity, the surface is listed in the
[tier-mismatch ledger](#tier-mismatch-ledger); ruled-but-unimplemented warm
surfaces and named cold surfaces live in
[their own table](#ruled-gaps-and-named-cold-surfaces).

The bar is: **agents written against real Slack run unchanged against the
local twin for the surfaces below**, and trip a loud failure for anything
outside them.

For the build / runtime / cloud consumer invariants the hosted snapshot build
depends on (port `:3333`, `/healthz`, `SLACK_CLONE_HOST`, `npm install`-able
package, `node dist/src/server.js`), see
[Runtime contract (for snapshot consumers)](README.md#runtime-contract-for-snapshot-consumers)
in the package README. Changing any of those is a breaking change for
`pome-cloud` and requires a matching cloud consumer PR.

## MCP Tools

| Tool | Backing surface | Heat | Tier | Tests | Known deviations |
| --- | --- | --- | --- | --- | --- |
| `slack_post_message` | SQLite messages | hot | semantic | `mcp-contract.test.ts`, `domain-chat.test.ts`, `recorder-state-delta.test.ts` | Block-kit rendering is not validated; emoji shortcodes are preserved literally. |
| `slack_reply_to_thread` | SQLite messages (thread_ts FK) | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Routes via `chat.postMessage({thread_ts})`; `reply_broadcast` is recorded but not re-fanned out. |
| `slack_add_reaction` | SQLite reactions | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `concurrency.test.ts` | Reactions are unique per `(channel, ts, name, user)`; skin-tone modifier suffixes are preserved as-is. |
| `slack_get_channel_history` | SQLite messages | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `performance.test.ts` | `oldest`/`latest`/`inclusive` filters supported; per-message metadata follows real Slack envelope. |
| `slack_get_thread_replies` | SQLite messages | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `domain-chat.test.ts` | Parent decorated with `thread_ts === ts`, `subscribed: false`, `is_locked: false` per real Slack invariant. |
| `slack_list_channels` | SQLite channels | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `performance.test.ts` | `types` filter supports `public_channel,private_channel,mpim,im`; cursor pagination via base64url offsets. |
| `slack_get_users` | SQLite users | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Deleted users are included with `deleted: true`; profile pagination matches real Slack envelope. |
| `slack_get_user_profile` | SQLite users.profile_json | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts` | Returns the full profile JSON; custom fields preserved verbatim through the round-trip. |
| `slack_search_messages` | SQLite messages (LIKE search) | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | F-736 hot-gap fill over `search.messages`: substring match, not Slack's query grammar (divergence #8). |
| `slack_get_reactions` | SQLite reactions | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | F-736 hot-gap fill over `reactions.get`; returns the message with its grouped reactions. |
| `slack_list_channel_members` | SQLite channel_members | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | F-736 hot-gap fill over `conversations.members`; returns user IDs with cursor pagination. |

The visible MCP tool count is pinned at 11 in `test/mcp-contract.test.ts`
(8 pre-M5 tools + the 3 F-736 hot-gap read tools ruled in F-729/SL2);
descriptions, required fields, mutating set, and `additionalProperties:false`
are all locked. Any drift breaks the contract test loudly.

## REST routes

| Endpoint | Heat | Tier | Tests | Notes |
| --- | --- | --- | --- | --- |
| `auth.test` | hot | semantic | `app.test.ts`, `auth.test.ts` | Returns `{ok, url, team, user, team_id, user_id, bot_id?}`. |
| `chat.postMessage` | hot | semantic | `app.test.ts`, `domain-chat.test.ts`, `recorder-state-delta.test.ts` | Form-encoded + JSON body; persists `username`, `icon_emoji`, `icon_url`; emits `bot_id`, `bot_profile`, `app_id` for bot authors. |
| `chat.update` | hot | semantic | `domain-chat.test.ts`, `app-routes.test.ts` | `edited_ts` allocated via the workspace-unique ts counter — no collisions. Hot per SL1: agents edit their own progress messages. |
| `chat.delete` | hot | semantic | `app.test.ts`, `actor-session.test.ts`, `domain.test.ts` | Hard delete (matches real Slack); thread parent `reply_count` decrements transactionally. No admin override. Hot per SL1. |
| `chat.scheduleMessage` / `chat.deleteScheduledMessage` | hot | semantic | `domain.test.ts`, `app-routes.test.ts` | No fire path — scheduled messages persist until explicit delete. |
| `conversations.list` | hot | semantic | `app.test.ts`, `recorder-state-delta.test.ts` | Cursor pagination, `types` filter, `exclude_archived`. |
| `conversations.info` | hot | semantic | `app-routes.test.ts` | `include_num_members` supported. |
| `conversations.create` | hot | semantic | `app.test.ts`, `domain-conversations.test.ts` | Granular error codes: `invalid_name_required` / `_maxlength` / `_specials` / `_punctuation`. |
| `conversations.history` | hot | semantic | `app.test.ts`, `performance.test.ts` | Newest-first ordering; `pin_count` included. |
| `conversations.replies` | hot | semantic | `domain-chat.test.ts`, `domain.test.ts` | Parent decorated with `thread_ts === ts`, `subscribed:false`, `is_locked:false`. |
| `conversations.invite` / `join` / `members` | hot | semantic | `app-routes.test.ts`, `domain.test.ts`, `domain-conversations.test.ts` | Membership setup + the member read behind `slack_list_channel_members`. |
| `conversations.leave` / `kick` / `archive` | warm | semantic | `app-routes.test.ts`, `domain.test.ts`, `domain-conversations.test.ts` | `cant_kick_self`, `cant_kick_from_general`, `cant_leave_general`, `cant_archive_general` matched. Warm-ruled: see the tier-mismatch ledger. |
| `conversations.open` | hot | semantic | `domain-conversations.test.ts`, `concurrency.test.ts` | Deterministic DM channel id by sorted member-id signature with a partial UNIQUE index. |
| `reactions.add` / `get` | hot | semantic | `app.test.ts`, `domain.test.ts`, `concurrency.test.ts` | `already_reacted` error code; `get` backs `slack_get_reactions`. |
| `reactions.remove` | warm | semantic | `app.test.ts`, `domain.test.ts` | `no_reaction` error code. Warm-ruled undo step: see the tier-mismatch ledger. |
| `users.list` / `users.info` / `users.lookupByEmail` / `users.profile.get` | hot | semantic | `domain.test.ts`, `app-routes.test.ts` | `users_not_found` error code on email miss. |
| `users.profile.set` | warm | semantic | `domain.test.ts`, `app-routes.test.ts` | Warm-ruled (no vendor MCP write): see the tier-mismatch ledger. |
| `pins.add` / `remove` / `list` | warm | semantic | `domain.test.ts`, `app-routes.test.ts` | `already_pinned` / `no_pin` codes; SQL constraint-mapped on race. Warm-ruled: see the tier-mismatch ledger. |
| `search.messages` | hot | semantic | `domain.test.ts`, `performance.test.ts` | Substring (LIKE-based) match; query syntax is intentionally smaller than real Slack search. |
| `files.upload` / `info` / `list` / `delete` | warm | shape | `domain.test.ts`, `app-routes.test.ts` | Metadata-only; no binary storage. URL fields point to deterministic `pome-twin-files.slack.com` hosts. Shape is at the warm target (SL5). |
| `bookmarks.add` / `remove` / `list` | warm | semantic | `domain.test.ts`, `app-routes.test.ts` | `link` type accepted; other bookmark types are unsupported per real Slack 2024 changelog. Warm-ruled: see the tier-mismatch ledger. |
| `team.info` | warm | semantic | `app-routes.test.ts` | Returns workspace metadata; enterprise fields are NULL for non-Enterprise twins. Warm-ruled context read: see the tier-mismatch ledger. |

Routes not listed return **501 + `_twin.fidelity:"unsupported"`** so agents
fail loudly rather than silently no-op. Cold surfaces agents plausibly probe
carry named rows below, so the loud 501 is documented and test-backed; the
rest of the upstream API is implicitly cold via the catch-all.

## Ruled gaps and named cold surfaces

Per the F-729 twin-slack ruling, the hot and warm sets are exhaustive: warm
surfaces the twin does not implement yet appear here as explicit gaps
(fidelity below the `shape` target) with their defer rationale — F-736 filled
hot gaps only (SL2); warm gaps were ruled defer (SL3/SL4). Named cold rows
document the loud 501 for surfaces agents plausibly probe. Message drafts are
deliberately absent: a client-UI concept with no Web API analog to name a row
for (PS).

| Endpoint | Heat | Tier | Notes |
| --- | --- | --- | --- |
| `canvases.create` / `canvases.edit` / `canvases.delete` | warm | unsupported | Deferred post-M5 (SL3). Strongest promotion candidate: Slack's first-party MCP server ships 3 canvas tools. |
| `conversations.setTopic` / `conversations.setPurpose` | warm | unsupported | Deferred post-M5 (SL4). "Set the channel topic" is a classic agent task; no vendor MCP tool. |
| `emoji.list` | warm | unsupported | Deferred post-M5 (SL4). Vendor ships an emoji-search tool; trivial read when filled. |
| `chat.postEphemeral` | cold | unsupported | The twin has no per-viewer visibility model (PS). 501 test-backed. |
| `files.getUploadURLExternal` / `files.completeUploadExternal` | cold | unsupported | Modern upload flow; the twin serves legacy v1 upload (divergence #7). Promotion candidate when v1 sunsets. 501 test-backed. |
| `admin.*` | cold | unsupported | No admin scopes modeled (divergence #6) (PS). Representative 501 probes test-backed. |
| `usergroups.*` | cold | unsupported | Outside the single-workspace twin scope (PS). 501 test-backed. |
| `views.*` | cold | unsupported | Client-UI modal surface, not on an agent chain (PS). 501 test-backed. |

## Tier-mismatch ledger

Surfaces whose ruled heat is **warm** but whose measured fidelity is
`semantic` — implementation deeper than the ruling demands. Per the M5
additive-only project `[DECISION]` (2026-07-11), nothing here is demoted in
code this milestone (the Twin Fidelity Watch launch gate F-440 is counting
consecutive green runs); each entry becomes a demotion-review follow-up
ticket after that gate closes. The ledger makes over-investment visible; it
does not trigger removals.

| Surface | Heat | Fidelity today | Target | Why it stays for now |
| --- | --- | --- | --- | --- |
| `reactions.remove` | warm | semantic | shape | Undo step; F-440 additive-only window. |
| `conversations.leave` | warm | semantic | shape | Rare cleanup chain; F-440 additive-only window. |
| `conversations.kick` | warm | semantic | shape | Rare moderation chain; F-440 additive-only window. |
| `conversations.archive` | warm | semantic | shape | Rare cleanup chain; F-440 additive-only window. |
| `users.profile.set` | warm | semantic | shape | Plausible set-own-status chain, no vendor write tool; F-440 additive-only window. |
| `pins.add` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `pins.remove` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `pins.list` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `bookmarks.add` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `bookmarks.remove` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `bookmarks.list` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `team.info` | warm | semantic | shape | Context read adjacent to hot chains; F-440 additive-only window. |

## Fidelity-watch coverage (status.pome.sh)

The daily watchdog reports twin-slack at **19 of 45 semantic surfaces**, 26 rolling
out. The number is built from source, never hand-typed
(the Twin Fidelity Watch in pome-cloud); here is exactly what it counts.

> **Denominator reconcile deferred (SL5).** The 45 predates the F-736 re-cut:
> it counts `files.info` / `files.list` / `files.delete` as semantic (the
> table above rules them shape ×4 — the table wins) and does not yet include
> the three F-736 MCP read tools (`slack_search_messages`,
> `slack_get_reactions`, `slack_list_channel_members`). Reconciling
> pome-cloud's `sandboxes/slack/surfaces.ts` is deliberately deferred until
> the F-440 launch gate finishes its consecutive-green count (additive-only
> collision), tracked by F-737.

- **Denominator (45)** — the full semantic surface inventory: 8 MCP tools + 37
  semantic REST methods (`files.upload` is shape-tier, excluded). MCP tools and
  REST methods are counted as **distinct public contracts**: an agent calls
  `slack_list_channels`, a REST client calls `conversations.list`. They share a
  backend, but each is a surface we hold to fidelity on its own. Source:
  the Twin Fidelity Watch's `sandboxes/slack/surfaces.ts` (`SEMANTIC_SURFACES`, in pome-cloud).
- **Numerator (19)** — surfaces with their own external-verification evidence,
  counted in distinct methods/tools (not capture instances):
  - **16 REST read methods**, shape-diffed daily against real Slack (the committed
    upstream golden). `conversations.info` and `conversations.history` are each
    captured under two scenarios (public/private channel, empty/non-empty history),
    so the table shows 18 read rows but 16 distinct methods.
  - **3 mutating MCP tools** (`slack_post_message`, `slack_reply_to_thread`,
    `slack_add_reaction`), write round-tripped against the seeded twin **oracle**
    (L2). This is L2-vs-oracle, **not** L1-vs-real-Slack — the daily cron does no
    mutating writes against the real workspace.
- **Rolling out (26)** — 5 read MCP tools (their underlying REST reads are verified;
  the MCP-envelope check rolls out next), 20 mutating REST methods (no write
  round-trip yet — including the `chat.postMessage` / `reactions.add` that back the
  3 verified MCP write tools, since the REST contract is verified separately), and
  `files.info` (needs a minted file id; see the L1 read exception). A surface is
  counted only once it has its own evidence — never credited by proxy.

## Known divergences from real Slack

Each bullet has exactly one structured entry in the Twin Fidelity Watch's
`known-divergences/slack.yaml` (in pome-cloud)
(the `SL-DIV-NNN` machine mirror, enforced 1:1 by the fidelity lint, D9). The
read-subset / accepted-divergence bullets (9–15) were derived from the FDRS-473
real-Slack L1 reconciliation: the twin capture diffed against the committed
real-Slack golden, then triaged into upstream-only leaves the twin faithfully
omits (read_subset) and genuine identity / controlled-sandbox differences the
twin cannot reproduce (accepted_divergence). Twin-only OVER-returned fields were
FIXED in the twin source, not documented away.

_Behavioral / envelope choices:_

1. **Auth errors return HTTP 401** instead of real Slack's 200 + `{ok:false,
   error:"not_authed"}`. The choice aligns with RFC 6750 Bearer-Token
   semantics and is what the `@slack/web-api` SDK expects on bad tokens;
   401 is also what every MCP client expects. Application-level errors
   (e.g. `channel_not_found`, `name_taken`) DO return HTTP 200 to match
   real Slack and keep the SDK parseable.
2. **Hard delete** for `chat.delete` (matches Slack) — thread replies of a
   deleted parent are orphaned with their `thread_ts` pointing at a gone
   row. Real Slack soft-deletes the parent with a tombstone placeholder.
3. **No admin override** on `chat.update` / `chat.delete`. Real Slack also
   does not provide an admin override at the API layer; this is documented
   for clarity.
4. **`ts` is workspace-globally-unique** (matches real Slack); two channels'
   first messages produce distinct ts values.
5. **No RTM / Events / Socket Mode** — only HTTP REST + MCP JSON-RPC.
6. **No Slack Connect, Enterprise Grid, or admin scopes.**
7. **`files.upload` is the legacy v1 endpoint.** Real Slack's 2024-04
   deprecation of v1 in favor of `files.getUploadURLExternal` +
   `files.completeUploadExternal` is not yet implemented.
8. **`search.messages`** uses substring matching (LIKE), not Slack's
   query-grammar (modifiers like `in:`, `from:`, `before:` are not parsed).

_Read-subset field omissions (twin returns a documented subset):_

9. **Team objects omit Slack enterprise/internal flags.** `team.info` omits
   `is_verified`, `lob_sales_home_enabled`, and `is_sfdc_auto_slack` — the
   verified-org badge and Slack-internal Salesforce/auto-provision flags a
   non-Enterprise twin does not model. (`avatar_base_url` is `*_url` hypermedia,
   INFO categorically.)
10. **Channel objects omit Slack-Connect/viewer-state/rename metadata.**
    `conversations.list` / `.info` channel objects omit the Slack-Connect leaves
    (`is_ext_shared`, `shared_team_ids`, `pending_connected_team_ids`), the
    per-viewer state (`is_member`, `is_open`, `last_read`), the server `updated`
    mtime, the `properties` blob, and `previous_names` (the twin models no rename
    history — it omits the key rather than emitting an empty array).
11. **Message objects omit bot-identity/block/thread-fanout metadata.**
    `conversations.history` / `.replies` / `reactions.get` message objects omit
    `bot_id` / `app_id` / `bot_profile` (the seeded author is a user, not a bot
    app), the rich-text `blocks`, the thread-fanout convenience leaves
    (`thread_ts` on a parent, `reply_users`, `parent_user_id`, `is_locked`), and
    the `permalink` / `team` decoration.
12. **User-profile objects omit contact-card and derived-status leaves.** The
    `users.*` profile omits the unseed-ed contact card (`first_name`, `last_name`,
    `title`, `phone`, `skype`), the custom-`fields` blob, the derived status
    leaves (`status_text_canonical`, `status_emoji_display_info`,
    `status_clear_on_focus_end`), and `always_active`. (The per-endpoint
    `email`/`team` shape was FIXED in the twin to match real Slack.)
13. **Search match objects omit internal-search and shared-channel metadata.**
    `search.messages` matches omit Slack's `db_message` / `score` internals, the
    `blocks` / `no_reactions` leaves, and the per-match embedded `channel`'s full
    shared-channel flag set (`is_channel`, `is_group`, `is_im`, `is_mpim`,
    `is_shared`, `is_org_shared`, `is_ext_shared`, `is_archived`,
    `pending_shared`, `is_pending_ext_shared`).

_Accepted divergences (identity / controlled-sandbox):_

14. **`auth.test` `bot_id` reflects the capturing bot token, not the seeded user.**
    The golden was captured with a bot app token, so real Slack returns a `bot_id`
    string; the twin's seeded auth user is a regular user, so it returns
    `bot_id: null`. An inherent identity divergence — the bot id is a
    workspace-minted id the twin cannot reproduce.
15. **`conversations.members` #general count reflects the seed (3) vs the free workspace (bot+1).**
    The seed models three users in #general; the real free workspace's #general has
    only the bot plus the single creating human (a free workspace cannot be seeded
    with extra human members via a bot token). Unavoidable controlled-sandbox vs
    free-workspace membership difference, not a serializer bug.

_Shape-anchoring divergences (compile-time anchor to `@slack/web-api`):_

16. **Serializers are anchored to `@slack/web-api`, a source that lags real Slack on some fields.**
    The shape anchor (`src/upstream-types.ts`, FDRS-477) is the SDK's published
    response types, not real Slack's live wire format. The SDK trails Slack on some
    leaves (un-typed fresh fields, removed-but-still-served legacy fields), so a
    twin field the SDK does not type still surfaces as an emitted-not-in-upstream
    divergence even when real Slack returns it. The anchor is a compile-time subset
    guard, not a fidelity oracle — live capture (the FDRS-473 golden) outranks it.
17. **`serializePin` is left to live capture — `@slack/web-api`'s pin type is too thin.**
    `PinsListResponse.Item` models only `{comment, created, created_by, file, type}`:
    it has NO `message` and NO `channel`. The twin emits a MESSAGE pin
    (`type:"message"`, `channel`, `message`, `created`, `created_by`) whose two
    distinguishing fields are absent upstream, so the type would anchor only
    `created`/`created_by`/`type`. Anchoring it adds no real guard; `serializePin` is
    deliberately UNANCHORED and verified against the live golden instead.
18. **`serializeUserProfile` emits a twin-only `team` field.** `team` is not on the
    `@slack/web-api` profile type; the twin carries it for cross-endpoint convenience.
    Held out of the anchored `base` literal and spread back on the open Record.
19. **Channel objects emit twin-only `parent_conversation` and `members`.**
    `serializeChannel` carries `parent_conversation` (always `null` — the twin models
    no thread-parent conversations) and a conditional `members` count, neither on the
    anchored `SlackChannel`. Both are assigned on the Record after the anchor.
20. **Messages emit a twin-only `permalink`.** `serializeMessage` decorates a fetched
    message with a deterministic `permalink` the upstream `SlackMessage` does not
    carry. Held out of the anchored literal and merged on the Record.
21. **Scheduled messages emit a twin-only `thread_ts`.** `serializeScheduledMessage`
    carries `thread_ts` for scheduled thread replies; it is absent from
    `@slack/web-api`'s `ChatScheduledMessagesListResponse` item, so it is held out of
    the anchored `base` and spread back.

## Shape anchoring (compile-time, `@slack/web-api@7.16.0`)

The serializers are pinned to Slack's official response types at compile time
(`src/upstream-types.ts`, FDRS-477; mirrors twin-github FDRS-475/476). Each
serializer's literal `satisfies DeepPartial<Slack…>`, so a wrong-named or
mistyped field is a COMPILE error while omitting a field stays legal (the twin
is a faithful subset). The anchor target is `@slack/web-api@7.16.0`.

**Anchored (9 serializers).** `serializeWorkspace`, `serializeUserProfile`,
`serializeUser`, `serializeChannel`, `serializeMessage`, `groupReactions`
(array-element anchor), `serializeFile`, `serializeBookmark`, and
`serializeScheduledMessage` all `satisfies DeepPartial<…>` against their
`@slack/web-api` type. `serializeBookmark` is a perfect 1:1 (no held-out keys).
Where the row type is wider than upstream (`safeJsonArray` returns `unknown[]`,
nullable columns), the value is cast to the upstream leaf type; twin-only fields
(bullets 18–21) are held off the anchored literal and assigned on the Record.

**Left to live capture (1 serializer).** `serializePin` is unanchored: the SDK's
`PinsListResponse.Item` is too thin to model a message pin (bullet 17), so it is
verified against the FDRS-473 real-Slack golden instead of the type.

**Inverse weighting (live capture > anchor on Slack).** The `@slack/web-api`
types are a published SDK artifact that lags the live API, so they are a weaker
oracle here than the committed real-Slack golden. The anchor is the cheap
compile-time floor (catches typos and an upstream field-rename at build time);
the golden is the source of truth for what real Slack actually returns. When the
two disagree, the golden wins and the anchor's gap is recorded as a divergence
above — never the reverse.

## Verification commands

```bash
cd packages/twin-slack
npm run typecheck                       # zero TS errors
npm run test                            # all tests pass
npm run test:coverage                   # ≥ 90% lines, ≥ 90% funcs
npm run validate:mcp                    # JSON-RPC SDK round-trip
npm run fidelity:parity                 # every MCP tool through /mcp/call (F-730)
TWIN_AUTH_SECRET=dev SLACK_DETERMINISTIC_TS=1 npm run smoke
npm run verify:cloud-token              # cloud xoxb-pome-* token validates
```

The tables above are 1:1-linted against the structured inventory
[`fidelity.inventory.json`](fidelity.inventory.json) (which also carries the
hot/warm/cold heat tier per F-729) by `test/fidelity-contract.test.ts`; the
same test enforces the heat discipline (no unclassified surfaces, hot ⇒
semantic, cold ⇒ unsupported, and the tier-mismatch ledger exactly matching
the warm-above-target set). The shared parity runner (`@pome-sh/sdk/parity`)
asserts the same inventory matches the live tool list and that a declarative
scenario exercises every tool.
