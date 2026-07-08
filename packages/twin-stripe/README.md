# Pome Twin: Stripe x402

> One of three twins in this repository (GitHub, Stripe x402, Slack).

`@pome-sh/twin-stripe` is the only deterministic test double for **Stripe
x402 machine payments**. Real Stripe sandbox doesn't auto-settle crypto
deposits, the CDP facilitator settles on real Base, and `stripe-mock`
has no x402 support — so without this twin there is nowhere to run agent
tests against the x402 protocol that aren't either flaky, slow, or
expensive. v1 ships **12 REST endpoints + 12 MCP tools + the
`paymentMiddleware()` Hono helper**, all stateful, all tested, all loud
about what they don't do.

## Quickstart

The fastest path is the hosted twin: log in to [pome.sh](https://pome.sh),
click **Stripe x402** on the Twins page, and a per-session sandbox spawns
in seconds. The dashboard hands you a `sk_test_pome_<sid>` API key + the
twin URL. Skip ahead to [Auth](#auth--works-with-real-stripe-sdks) for
how to wire your existing Stripe SDK.

To run the twin yourself locally (e.g., in CI or against an offline
agent), clone this repo and run:

```bash
git clone https://github.com/pome-sh/pome.git
cd pome && npm install
npm run -w @pome-sh/twin-stripe dev &   # starts on :3333
sleep 2

# Or via Docker (host port 3334 when using root docker-compose --profile twins):
# docker compose --profile twins up -d twin-stripe
# curl http://127.0.0.1:3334/healthz

# Real Stripe SDKs work via host override — they hit /v1/* directly
# (no /s/:sid prefix) and the bearer alone resolves the session:
#   new Stripe('sk_test_pome_default', { host: '127.0.0.1', port: 3333, protocol: 'http' })
# Or curl the same root path:
curl -s -X POST http://127.0.0.1:3333/v1/payment_intents \
  -H "Authorization: Bearer sk_test_pome_default" \
  -H "Content-Type: application/json" \
  -d '{"amount":1000,"currency":"usd","payment_method_types":["crypto"],"payment_method_options":{"crypto":{"mode":"deposit","deposit_options":{"networks":["base"]}}}}' \
  | python3 -m json.tool
```

You'll get back a real-shaped Stripe `PaymentIntent` in `requires_action`
state with a Base USDC deposit address. Settle it with the test helper:

```bash
curl -s -X POST "http://127.0.0.1:3333/v1/test_helpers/payment_intents/<pi_id>/simulate_crypto_deposit" \
  -H "Authorization: Bearer sk_test_pome_default" \
  -d '{}'
# → status: succeeded, latest_charge: ch_..., balance updated, 5 events emitted
```

The same routes are also mounted under `/s/:sid/v1/*` for path-routed
deployments (e.g., the pome-cloud per-session proxy, where the `:sid`
in the URL must match the bearer). Pick whichever shape your client
prefers — they share handlers and produce identical responses.

> **npm publish status**: this package is currently `private: true` in
> `package.json` pending OSS Stage 1 + legal review (see plan §22). After
> Stage 1, `npx @pome-sh/twin-stripe` will be the one-line install path;
> until then, the monorepo clone above or the hosted twin on
> pome.sh is the supported route.

## What ships in v1

| Surface | Count | Tier |
| --- | --- | --- |
| REST endpoints under `/s/:sid/v1/*` | 12 | semantic |
| MCP tools (1:1 with stripe-node) | 12 | semantic |
| `paymentMiddleware()` Hono helper | 1 | semantic |
| Pome introspection (`_pome/{health,state,events}`) | 3 | n/a |
| Admin (`/admin/{reset,seed}`, localhost-only) | 2 | n/a |
| Anything else under `/v1/*` | many | **loud 501 with `fidelity:"unsupported"`** |

See [FIDELITY.md](./FIDELITY.md) for the full route table and known
deviations from real Stripe.

## Running the buyer agent demo

```bash
# Terminal 1
npm run -w @pome-sh/twin-stripe dev

# Terminal 2
npm start --prefix packages/twin-stripe/examples/buyer-agent
```

You'll see:

```
🛒 pome twin-stripe buyer-agent demo
✓ got 402 challenge: pay 10000 USDC on eip155:84532 to 0x...
✓ paid + got resource
✓ twin reports 1 PI(s) with status=succeeded
✓ twin emitted all 5 expected events
✓ x402 buyer flow completed end-to-end
```

The seller is a Hono app with `paymentMiddleware()` mounted at
`GET /paid`. The buyer hits it without an `X-PAYMENT` header (gets 402),
then constructs a header against the deposit address and retries
(gets 200).

## Auth — works with real Stripe SDKs

Two auth shapes are accepted:

1. **Stripe-style API key** — `Authorization: Bearer sk_test_pome_<sid>`.
   The default seed mints `sk_test_pome_default` so the standard Stripe
   SDK constructor works unchanged:

   ```ts
   import Stripe from "stripe";
   const stripe = new Stripe("sk_test_pome_default", {
     host: "127.0.0.1",
     port: 3333,
     protocol: "http",
   });
   await stripe.paymentIntents.create({
     amount: 1000,
     currency: "usd",
     payment_method_types: ["crypto"],
     payment_method_options: {
       crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
     },
   });
   ```

2. **Pome JWT** — `Authorization: Bearer <jwt>` where the JWT's `sid`
   claim matches the URL's `/s/:sid/...`. Used by pome-cloud's
   path-routed proxy.

Either way, the resolved session id must match the `:sid` in the URL.

## MCP

15 tools available at `GET /s/:sid/mcp/tools`. Tool names match
`stripe-node` method names so an agent's mental model translates 1:1:

```
create_payment_intent
retrieve_payment_intent
list_payment_intents
confirm_payment_intent
cancel_payment_intent
simulate_crypto_deposit
retrieve_charge
list_charges
retrieve_balance
list_balance_transactions
retrieve_event
list_events
create_refund
retrieve_refund
list_refunds
```

Call shapes:

```bash
curl -s -X POST http://127.0.0.1:3333/s/default/mcp/call \
  -H "Authorization: Bearer sk_test_pome_default" \
  -H 'content-type: application/json' \
  -d '{"tool":"create_payment_intent","arguments":{"amount":1000,"currency":"usd","payment_method_types":["crypto"],"payment_method_options":{"crypto":{"mode":"deposit","deposit_options":{"networks":["base"]}}}}}'
```

## Runtime contract (for snapshot consumers)

`pome-cloud` builds a Vercel Sandbox snapshot from this package's source.
The following constraints must hold for that build to succeed and for
the resulting snapshot to boot. Changing any of these is a breaking
change for hosted; coordinate via a cross-repo PR.

### Build

- Package is `npm install`-able from `package.json` alone (no
  `workspace:*` protocols, no package-manager-specific deps; no committed lockfile is
  required, the snapshot build regenerates one on each rebuild).
- `npm run build` exits 0 and emits `dist/src/server.js`.
- Built output is loadable under Node 24 — the snapshot runs
  `runtime: "node24"`. Uses Node-native `better-sqlite3` (
  fine; we install python3 + make + g++ in the Dockerfile build stage).

### Runtime

- Server entry: `node dist/src/server.js` (cwd = package root).
- Listens on `:3333`.
- Honors `STRIPE_CLONE_HOST=0.0.0.0` env (default `127.0.0.1` is
  unreachable via Vercel Sandbox port forwarding).
- `GET /healthz` returns 200 within ~3s of process start (the snapshot
  build sleeps 3s after `node dist/src/server.js` before probing).
- All admin routes (`/admin/*`) are localhost-only.
- Bearer auth at `Authorization: Bearer <jwt>` or `Bearer sk_test_pome_<sid>`.

### Cross-repo coordination

- Bumping any of the above = open a cross-repo PR (this repo + `pome-cloud`).
- The cloud-side snapshot build script lives at
  `pome-cloud/notes/poc-vercel-sandbox/build-twin-stripe-template.ts`.
- The snapshot manifest at `pome-cloud/infra/twin-stripe-snapshot.json`
  records the OSS git sha each snapshot was built from.

## What v1 does NOT do

Loud 501 with `fidelity: "unsupported"`:

- All `/v1/shared_payment/*` (SPT) — deferred to v2.
- Customer / payment-method CRUD — not on the x402 path.
- Setup intents, refunds, products, prices, checkout sessions — v2.
- Webhook delivery loop — agents poll `GET /v1/events` in v1.
- Profiles, Connect, Issuing, Treasury, Tax, Climate, Identity — out forever
  for this twin.

Other deviations from real Stripe:

- **Single API version.** Only `2026-03-04.preview` is served.
- **No EIP-3009 signature verification on x402 payloads.** Agents that
  send well-formed `X-PAYMENT` headers matching our payTo book + amount
  succeed. Documented in `src/x402.ts` head comment.
- **OFFSET-style list pagination** (Stripe uses cursor-based).
- **Synchronous deposit settlement.** `simulate_crypto_deposit` flips
  `requires_action → processing → succeeded` synchronously; no chain
  delay simulation.
- **Single deposit network** (Base) and **single token** (USDC). Tempo
  + Solana from Stripe's matrix are deferred.

## Local commands

```bash
npm install
npm run dev                        # boot on :3333 with default seed
npm run typecheck                  # tsc --noEmit
npm run test                       # vitest, 17 files / 87 tests
npm run build                      # tsc → dist/src/server.js
node dist/src/server.js            # production-shape boot
```

## Use it as a Stripe test double in your tests

Until the package is on npm (post-Stage-1), the cleanest way is to clone
this monorepo and shell out to `npm run dev` from your test setup:

```ts
// In your test setup
import { spawn } from "node:child_process";
import { join } from "node:path";

// Path to where you cloned pome-sh/pome on disk
const POME_REPO = process.env.POME_REPO ?? "/path/to/pome";

const twin = spawn("npm", ["run", "dev"], {
  cwd: join(POME_REPO, "packages/twin-stripe"),
  env: { ...process.env, PORT: "3333", STRIPE_CLONE_DB: ":memory:" },
});
// wait for /healthz before running your suite

// In your code under test
import Stripe from "stripe";
const stripe = new Stripe("sk_test_pome_default", {
  host: "127.0.0.1", port: 3333, protocol: "http",
});

// Run your agent. Assert against the twin's recorder:
const events = await fetch("http://127.0.0.1:3333/s/default/_pome/events").then(r => r.json());
// or against the twin's domain state:
const state = await fetch("http://127.0.0.1:3333/s/default/_pome/state").then(r => r.json());
```

Test against the **state of the world after the agent ran**, not byte-
for-byte response shapes. PI numbers, IDs, timestamps, and SHAs are
deterministic-enough for tests but not identical to real Stripe.

## Pome Cloud (twin selector)

Once `pome-sh/pome-cloud` ships the matching FDRS-275/276 changes, the
hosted dashboard exposes a **stripe x402** button next to GitHub.
Clicking it spawns a per-session Vercel Sandbox running this exact
package. The agent in your session sees the same surface this README
describes; URLs are path-routed (`https://twins.pome.sh/s/<sid>/...`).
