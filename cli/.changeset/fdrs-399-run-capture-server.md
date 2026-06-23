---
"pome-sh": minor
---

`pome run` now spawns `pome capture-server` as a child process before invoking
the agent (FDRS-399). The agent subprocess inherits `HTTP_PROXY` /
`HTTPS_PROXY` pointing at the proxy and `NO_PROXY=127.0.0.1,localhost` so
twin traffic stays out of the proxy and isn't double-counted. The capture
server is SIGTERM-drained on run completion before artifacts are finalized.
`events.jsonl` now contains both proxy-captured `LlmCallEvent` rows and
unified `TwinHttpEvent` rows for the in-process twin traffic. Self-host runs
gain a zero-config trace baseline (host / port / latency / bytes for every
outbound LLM call) with no CA install and no agent code changes.
