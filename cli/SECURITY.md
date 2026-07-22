# Security policy

## Supported versions

The latest published `@pome-sh/cli` CLI line receives security updates. Older versions are not patched (including the deprecated `pome-sh` line this CLI was previously published under).

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting:

1. Go to https://github.com/pome-sh/pome-twins/security/advisories/new
2. Fill in the form. We get a private notification.

Alternatively, email `founders@pome.sh`.

Expected response time: **within 3 business days** for an initial acknowledgement.

## Scope

In scope:

- Code execution via untrusted task / agent / config input.
- API-key exfiltration paths (credentials file, Keychain interactions, log lines).
- Authentication / authorization bypasses in `pome login` or the hosted client.
- Supply-chain risks in shipped dependencies.

Out of scope:

- Issues that require the attacker to already have local-shell access to the user's machine.
- Vulnerabilities in third-party hosted services (`api.pome.sh`, `app.pome.sh`, `docs.pome.sh`) — report those to `founders@pome.sh`.
- Theoretical issues without a working proof-of-concept on a supported platform.

## Credential handling

The CLI stores team API keys in:

- macOS: **Keychain** (preferred), or `~/.pome/credentials.json` with mode `0600` if Keychain is unavailable.
- Linux / Windows: `~/.pome/credentials.json` with mode `0600`.

The CLI never reads, transmits, or logs `ANTHROPIC_API_KEY` or other provider keys — those are read directly by user agent processes from `process.env`.
