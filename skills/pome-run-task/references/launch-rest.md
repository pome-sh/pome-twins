# Launcher — REST examinee (Skill 4 reference)

The runtime-specific seam for a **non-managed** examinee
(`examinee_launch.transport: "rest"`): a self-hosted agent process that talks to
the twins over plain REST instead of MCP. This is the path Gagan's
`minimal-viktor` took (scored 100/100 pre-A3). Same contract, no `ant`, no vault.
Assemble from the spec, run the process on the kickoff task, watch for idle, then
return to SKILL.md §3 to `finalize_run` while the twin session is live.

The spec still owns policy — you execute it. Field names are verbatim from
`examinee_launch`.

## Map the spec into the process

| `examinee_launch` field | Becomes, for the REST examinee |
| --- | --- |
| `rest_urls` `{ <twin>: <url> }` | the base URL the process calls per twin (`<twinsBase>/<twin>/s/<sid>`) — the github twin speaks GitHub-REST shapes, the slack twin Slack-Web method names with **no `/api` prefix** |
| `env.POME_GITHUB_REST_URL` / `env.POME_SLACK_REST_URL` | the same per-twin bases as environment variables, if the process reads config from env |
| `env.POME_AUTH_TOKEN` (= `agent_token`) | the bearer for every twin call — `Authorization: Bearer <token>`. **SENSITIVE**: inject it into the process env for this run only, never write it to a file or bake it into the agent |
| `network` clamp / closed-book (D10) | you own egress here — give the process **no** `web_search` / `web_fetch` and no general internet; it should reach only the twin URLs, matching the seeded world |
| `initial_events` | feed them to the process verbatim if it is an ambient/deployment-kickoff agent |

There is no `mcp_permission_policy` concern on this path — REST has no
tool-confirmation handshake, so the F-787 deadlock does not apply.

## Run and detect idle

1. Point the process's twin/tool endpoints at `rest_urls` (or inject the `env`
   vars), with `POME_AUTH_TOKEN` as the bearer.
2. Start it on the kickoff task = `examinee_task.prompt` (plus `initial_events`
   if applicable).
3. **Idle** = the process has finished the task and stopped calling the twins
   (it exits, or blocks with no further requests). Detection is process-level:
   watch the process, or the twin request stream going quiet.
4. The instant it idles, go to **SKILL.md §3**: `finalize_run(session_id,
   agent_token)` on the Pome `session_id`, while the twin sandbox is still up.
   Do not shut the twins down first — a late finalize loses the tape.
