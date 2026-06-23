---
"pome-sh": patch
---

**F19 / F21 / F22 — `pome session create --format text` polish.**

Three fixes to the text-format trailer printed after `pome session create --twin <name>`:

- **F19 (MCP URL suffix)**: defensively append `/mcp` to the printed MCP URL if the server's `per_twin.mcp_url` lacks it. The standalone `pome twin start` path already appends `/mcp` to make agents' MCP transports mount cleanly; mirror that here so the printed value works regardless of which side rolls out the suffix fix first. Pattern `/mcp/?$` test avoids double-appending.

- **F21 (drop "(legacy)" label)**: the `Twin URL (legacy)` line was confusing — users assumed the URL was deprecated. The label was an artifact of an old per-twin / pre-per-twin split that no longer exists. Drop the line entirely when `per_twin[<twin>]` is populated (the modern path); keep an un-labelled `Twin URL:` fallback only for old cloud responses that ship just `twin_url`.

- **F22 (concrete dashboard deep-link)**: replaced the vague "Open the Twins page in the dashboard to verify this session." trailer with `Dashboard: https://app.pome.sh/twins/<session_id>`. Users can copy-paste it into a browser without having to know where the twins index lives.
