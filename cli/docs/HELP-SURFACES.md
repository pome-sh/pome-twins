# Documentation surfaces (CLI)

Pome splits **reference** vs **narrative** docs the way many dev CLIs do (similar idea to Vercel: `--help` for flags, richer docs for concepts).

| Surface | Command | What it is |
| --- | --- | --- |
| Top-level reference | `pome --help` or `pome help` | Commander output: subcommands, global options. Same information as `pome <cmd> --help` patterns, scoped per command. |
| Per-command reference | `pome run --help`, etc. | Flags and arguments for one subcommand. |
| Narrative + guides | `pome docs [topic]` | Long-form Mintlify-authored pages, rendered in the terminal from Markdown/MDX **bundled in the published package** (paths listed in `src/cli/docs-topics.ts`). Also prints stable `https://docs.pome.sh/...` URLs. |
| Web | [docs.pome.sh](https://docs.pome.sh) | Same content as the bundled files, with Mintlify navigation, components, and search. |

**Examples in the terminal:** `pome docs getting-started` includes real shell snippets (install, `pome init`, first `pome run`). Rich MDX layouts (cards, frames) are omitted in the terminal with a note to open the web URL for the full layout.

**Why not scrape Mintlify HTML?** The site is compiled MDX; scraping couples the CLI to DOM and breaks on redesigns. Shipping authored sources next to the CLI keeps terminal and web aligned by repo convention.

**Scripting / CI:** With a non-TTY stdout, `pome docs` prints `topic`\t`url` lines. With `[topic]`, it prints a single URL unless stdout is a TTY (then it renders). Use `pome docs <topic> --url` to force URL-only.
