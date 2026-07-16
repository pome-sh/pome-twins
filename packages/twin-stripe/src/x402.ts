// SPDX-License-Identifier: Apache-2.0
//
// =============================================================================
// FIDELITY CAVEAT — READ ME BEFORE TRUSTING ANY OUTPUT FROM THIS MODULE
// =============================================================================
//
// This is the seller-side x402 middleware for the Pome Stripe twin (v1).
// It implements the **shape** and **flow** of the x402 challenge-response
// protocol — `402 + accepts` body on first leg, `X-PAYMENT` header on second
// leg, settle on the twin's `simulate_crypto_deposit` test helper, then
// proxy the wrapped handler.
//
// What this DOES NOT do (intentional, v1 scope):
//
//   1. **No real EIP-3009 signature verification.** We accept any
//      well-formed `X-PAYMENT` payload whose `authorization.to` field
//      matches a `payTo` address we minted, and whose `authorization.value`
//      matches the priced amount. Signature bytes are not checked.
//   2. **No real chain settlement.** We call the twin's
//      `simulate_crypto_deposit` test helper to advance the PI state
//      machine. There is no on-chain transfer.
//   3. **No EIP-712 domain separator validation.** A real x402 facilitator
//      verifies the typed-data hash against the chain's EIP-712 domain.
//      We don't.
//   4. **No nonce replay protection beyond same-payload idempotency.**
//      A real facilitator tracks nonces against the on-chain `authorizationState`
//      mapping. We treat the entire base64 `X-PAYMENT` blob as the idempotency
//      key (sufficient for agent test fidelity; insufficient for real money).
//
// Agents that work against the real Stripe + x402 facilitator stack should
// work against this twin unchanged at the wire level — they just won't get
// caught here for cryptographic mistakes. That's a deliberate v1 trade-off:
// optimize for state-machine fidelity (which is what trips agents up most),
// not for the parts a real facilitator already does for free.
//
// =============================================================================

import type { Context, MiddlewareHandler } from "hono";

// ----------------------------------------------------------------------------
// Public types — what callers import
// ----------------------------------------------------------------------------

/**
 * One entry in the `accepts` array of an x402 challenge. Mirrors the shape
 * the real x402 spec uses on the wire (scheme, network, price, etc.).
 *
 * `payTo` can be either a literal address string (rare — implies a static
 * deposit address) or a callback that mints one per request by creating
 * a fresh PaymentIntent on the twin. The callback form is the common case.
 */
export type AcceptsEntryInput = {
  /** Payment scheme. Only "exact" is supported in v1. */
  scheme: "exact";
  /** Human-readable price string, e.g. "$0.01". Parsed to USDC base units. */
  price: string;
  /** Chain identifier — `eip155:<chainId>`, e.g. `eip155:84532` for base sepolia. */
  network: string;
  /**
   * Either a fixed payTo address or a callback that mints one. The callback
   * receives the Hono context (so it can read auth, route params, etc.) and
   * returns the address as a 0x-prefixed hex string.
   *
   * In v1, the default is to leave this unset — the middleware will mint
   * a deposit address via the twin's `POST /v1/payment_intents` and use the
   * `next_action.crypto_display_details.deposit_addresses.base.address`
   * value.
   */
  payTo?: string | ((c: Context) => string | Promise<string>);
  /** Optional max age for the challenge in seconds (defaults to 300). */
  maxTimeoutSeconds?: number;
  /** Optional MIME type tag for documentation. */
  mimeType?: string;
  /** Optional human description shown in the challenge body. */
  description?: string;
  /** Optional asset identifier (defaults to USDC). */
  asset?: string;
  /** Optional resource URL (defaults to the request URL). */
  resource?: string;
  /** Optional extra metadata payload. */
  extra?: Record<string, unknown>;
};

/** Per-route x402 configuration. */
export type RouteConfig = {
  accepts: AcceptsEntryInput[];
  description?: string;
  mimeType?: string;
};

/** Map of "<METHOD> <path>" → route config. */
export type RouteMap = Record<string, RouteConfig>;

type ContextValue<T> = T | ((c: Context) => T | Promise<T>);

/** Twin connection options used by the middleware to mint PIs + settle them. */
export type TwinOptions = {
  /** Base URL of the running twin (e.g., "http://127.0.0.1:3333"). */
  twinBaseUrl: string;
  /** API key (`sk_test_pome_*`) for talking to the twin. */
  apiKey: ContextValue<string>;
  /** Session id; routes live under `/s/<sid>/v1/...`. */
  sid: ContextValue<string>;
  /**
   * Optional injected fetch — handy for tests that want to short-circuit
   * the network. Defaults to global `fetch`.
   */
  fetch?: typeof fetch;
  /**
   * Cache TTL for minted deposit addresses, in milliseconds. Default 5 min.
   * Replays within this window reuse the same PI; expired entries get evicted.
   */
  challengeTtlMs?: number;
};

type ResolvedTwinOptions = Omit<TwinOptions, "apiKey" | "sid"> & {
  apiKey: string;
  sid: string;
};

/** The shape of an `accepts` entry as serialized in the 402 body. */
export type AcceptsEntry = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  outputSchema?: Record<string, unknown> | null;
  extra?: Record<string, unknown>;
};

/** The 402 challenge body. */
export type X402ChallengeBody = {
  x402Version: 1;
  accepts: AcceptsEntry[];
  error: string;
};

/** The decoded `X-PAYMENT` header. */
export type XPaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: number | string;
      validBefore: number | string;
      nonce: string;
    };
    signature: string;
  };
};

// ----------------------------------------------------------------------------
// Price parsing — "$0.01" → 10000 (USDC base units, 6 decimals)
// ----------------------------------------------------------------------------

/**
 * Parse a price string like "$0.01" or "0.01 USDC" into base units (USDC has
 * 6 decimals: 1 USDC = 1_000_000 base units). Returns the integer string the
 * x402 wire format uses for `maxAmountRequired` and `authorization.value`.
 */
export function parsePriceToBaseUnits(price: string): {
  amount: string;
  asset: string;
  decimals: number;
} {
  const trimmed = price.trim();
  // Strip currency symbol/asset suffix.
  const match = trimmed.match(/^\$?\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/);
  if (!match) {
    throw new Error(`paymentMiddleware: cannot parse price "${price}"`);
  }
  const numStr = match[1]!;
  const asset = (match[2] ?? "USDC").toUpperCase();
  const decimals = 6; // USDC. v1 only supports USDC-on-EVM via x402.

  const [whole, frac = ""] = numStr.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return {
    amount: combined === "" ? "0" : combined,
    asset,
    decimals
  };
}

// ----------------------------------------------------------------------------
// Twin client — a thin facilitator-shaped wrapper over the local twin REST API
// ----------------------------------------------------------------------------

export class TwinFacilitatorClient {
  constructor(private readonly opts: ResolvedTwinOptions) {}

  private get fetch_(): typeof fetch {
    return this.opts.fetch ?? globalThis.fetch;
  }

  private url(path: string): string {
    // Strip trailing slashes without a regex — CodeQL flags /\/+$/ on
    // library-controlled twinBaseUrl as a potential polynomial ReDoS.
    let base = this.opts.twinBaseUrl;
    while (base.endsWith("/")) {
      base = base.slice(0, -1);
    }
    return `${base}/s/${encodeURIComponent(this.opts.sid)}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "Content-Type": "application/json",
      ...extra
    };
  }

  /**
   * Create a crypto-mode PaymentIntent on the twin and pull the deposit
   * address out of `next_action.crypto_display_details.deposit_addresses.<network>.address`.
   *
   * Network parsing: `eip155:84532` → `base`. (We accept either form; v1
   * supports `base` only.)
   */
  async createCryptoPaymentIntent(args: {
    amount: number;
    currency: string;
    network: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; depositAddress: string; status: string }> {
    const networkSlug = networkToSlug(args.network);
    const body = {
      amount: args.amount,
      currency: args.currency,
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: {
          mode: "deposit",
          deposit_options: { networks: [networkSlug] }
        }
      },
      metadata: args.metadata ?? {}
    };
    const res = await this.fetch_(this.url("/v1/payment_intents"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(
        `TwinFacilitatorClient.createCryptoPaymentIntent: twin returned ${res.status}: ${text}`
      );
    }
    const pi = (await res.json()) as Record<string, any>;
    const id = String(pi.id ?? "");
    const status = String(pi.status ?? "");
    const depositAddress = extractDepositAddress(pi, networkSlug);
    if (!id || !depositAddress) {
      throw new Error(
        `TwinFacilitatorClient.createCryptoPaymentIntent: malformed PI from twin: ${JSON.stringify(pi).slice(0, 256)}`
      );
    }
    return { id, depositAddress, status };
  }

  async retrievePaymentIntent(id: string): Promise<Record<string, any>> {
    const res = await this.fetch_(this.url(`/v1/payment_intents/${encodeURIComponent(id)}`), {
      method: "GET",
      headers: this.headers()
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`retrievePaymentIntent ${id}: ${res.status} ${text}`);
    }
    return (await res.json()) as Record<string, any>;
  }

  /** Settle a crypto-mode PI by calling the test helper. */
  async simulateCryptoDeposit(piId: string): Promise<Record<string, any>> {
    const res = await this.fetch_(
      this.url(
        `/v1/test_helpers/payment_intents/${encodeURIComponent(piId)}/simulate_crypto_deposit`
      ),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({})
      }
    );
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`simulateCryptoDeposit ${piId}: ${res.status} ${text}`);
    }
    return (await res.json()) as Record<string, any>;
  }
}

function networkToSlug(network: string): string {
  // Accept either `eip155:<id>` or a bare slug. v1 maps anything EVM to "base".
  if (/^eip155:/i.test(network)) return "base";
  return network.toLowerCase();
}

function extractDepositAddress(
  pi: Record<string, any>,
  networkSlug: string
): string | undefined {
  const next = pi.next_action ?? null;
  const display = next?.crypto_display_details ?? null;
  const addrs = display?.deposit_addresses ?? null;
  if (!addrs) return undefined;
  const entry = addrs[networkSlug] ?? addrs["base"] ?? null;
  if (!entry) return undefined;
  return typeof entry === "string" ? entry : entry.address;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

// ----------------------------------------------------------------------------
// Header decode/encode helpers
// ----------------------------------------------------------------------------

export function decodeXPayment(header: string): XPaymentPayload {
  const json = base64decodeToString(header);
  const obj = JSON.parse(json);
  if (!obj || typeof obj !== "object") {
    throw new Error("X-PAYMENT: not a JSON object");
  }
  const auth = obj?.payload?.authorization;
  if (!auth || typeof auth.to !== "string" || typeof auth.value !== "string") {
    throw new Error("X-PAYMENT: missing authorization.to or authorization.value");
  }
  return obj as XPaymentPayload;
}

export function encodeXPayment(payload: XPaymentPayload): string {
  return base64encodeFromString(JSON.stringify(payload));
}

function base64decodeToString(b64: string): string {
  // Use Node's Buffer when available; fall back to atob.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(b64, "base64").toString("utf8");
  }
  // eslint-disable-next-line no-undef
  return atob(b64);
}

function base64encodeFromString(s: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "utf8").toString("base64");
  }
  // eslint-disable-next-line no-undef
  return btoa(s);
}

// ----------------------------------------------------------------------------
// Challenge cache — keyed by (route, payTo, amount); replay-safe within TTL
// ----------------------------------------------------------------------------

type CachedChallenge = {
  routeKey: string;
  acceptsIndex: number;
  payTo: string;
  amount: string;
  asset: string;
  network: string;
  paymentIntentId: string;
  createdAt: number;
};

class ChallengeCache {
  private byPayTo = new Map<string, CachedChallenge>();
  private byPaymentHeader = new Map<string, { piId: string; result: any; status: number }>();

  constructor(private readonly ttlMs: number) {}

  rememberChallenge(c: CachedChallenge): void {
    this.byPayTo.set(c.payTo.toLowerCase(), c);
  }

  lookupByPayTo(payTo: string): CachedChallenge | undefined {
    const hit = this.byPayTo.get(payTo.toLowerCase());
    if (!hit) return undefined;
    if (Date.now() - hit.createdAt > this.ttlMs) {
      this.byPayTo.delete(payTo.toLowerCase());
      return undefined;
    }
    return hit;
  }

  rememberSettled(headerB64: string, result: { piId: string; status: number; result: any }): void {
    this.byPaymentHeader.set(headerB64, { piId: result.piId, status: result.status, result: result.result });
  }

  lookupSettled(headerB64: string) {
    return this.byPaymentHeader.get(headerB64);
  }

  /** Test-only: clear in-memory state. */
  clear(): void {
    this.byPayTo.clear();
    this.byPaymentHeader.clear();
  }
}

// ----------------------------------------------------------------------------
// The middleware
// ----------------------------------------------------------------------------

export type PaymentMiddlewareHandle = MiddlewareHandler & {
  /** The underlying twin facilitator client; useful for tests. */
  facilitator: TwinFacilitatorClient;
  /** Test-only: clear the in-memory challenge cache. */
  _resetCache(): void;
};

/**
 * Create a Hono middleware that gates the configured routes behind an x402
 * challenge. Mount with `app.use(paymentMiddleware(routes, twinOpts))`.
 *
 * v1 scope: see the FIDELITY CAVEAT block at the top of this file.
 */
export function paymentMiddleware(
  routes: RouteMap,
  twinOpts: TwinOptions
): PaymentMiddlewareHandle {
  const facilitator = new TwinFacilitatorClient(resolveStaticTwinOptions(twinOpts));
  const cache = new ChallengeCache(twinOpts.challengeTtlMs ?? 5 * 60_000);

  // Pre-validate routes.
  for (const [key, cfg] of Object.entries(routes)) {
    if (!/^[A-Z]+\s+\//.test(key)) {
      throw new Error(`paymentMiddleware: route keys must look like "GET /paid"; got "${key}"`);
    }
    if (!cfg.accepts || cfg.accepts.length === 0) {
      throw new Error(`paymentMiddleware: route "${key}" must declare at least one accepts entry`);
    }
    for (const a of cfg.accepts) {
      if (a.scheme !== "exact") {
        throw new Error(`paymentMiddleware: only scheme "exact" is supported in v1, got "${a.scheme}"`);
      }
    }
  }

  const handler: MiddlewareHandler = async (c, next) => {
    const method = c.req.method.toUpperCase();
    const url = new URL(c.req.url);
    const routeKey = resolveRouteKey(method, url.pathname, routes);
    const config = routeKey ? routes[routeKey] : undefined;
    if (!config || !routeKey) {
      // Route is not gated — pass through.
      return next();
    }
    const requestFacilitator = new TwinFacilitatorClient(await resolveTwinOptions(c, twinOpts));

    const headerB64 = c.req.header("X-PAYMENT") ?? c.req.header("x-payment");

    if (!headerB64) {
      // First leg: emit 402 with the accepts body.
      const body = await build402Body(c, config, requestFacilitator, cache, routeKey, twinOpts);
      return c.json(body, 402);
    }

    // Second leg: decode + verify + settle.
    let payload: XPaymentPayload;
    try {
      payload = decodeXPayment(headerB64);
    } catch (err) {
      return c.json(
        {
          x402Version: 1,
          error: `X-PAYMENT: malformed (${(err as Error).message})`,
          accepts: await buildAcceptsList(c, config, requestFacilitator, cache, routeKey, twinOpts)
        },
        402
      );
    }

    // Idempotent retry: same header → same response, no new state.
    const seen = cache.lookupSettled(headerB64);
    if (seen) {
      return next();
    }

    const auth = payload.payload.authorization;
    const challenge = cache.lookupByPayTo(auth.to);
    if (!challenge) {
      return c.json(
        {
          x402Version: 1,
          error: `X-PAYMENT.authorization.to=${auth.to} does not match any active challenge`,
          accepts: await buildAcceptsList(c, config, requestFacilitator, cache, routeKey, twinOpts)
        },
        402
      );
    }

    if (auth.value !== challenge.amount) {
      return c.json(
        {
          x402Version: 1,
          error: `X-PAYMENT.authorization.value=${auth.value} does not match required ${challenge.amount}`,
          accepts: await buildAcceptsList(c, config, requestFacilitator, cache, routeKey, twinOpts)
        },
        402
      );
    }

    if (challenge.network !== payload.network) {
      return c.json(
        {
          x402Version: 1,
          error: `X-PAYMENT.network=${payload.network} does not match challenge.network=${challenge.network}`,
          accepts: await buildAcceptsList(c, config, requestFacilitator, cache, routeKey, twinOpts)
        },
        402
      );
    }

    // Settle on the twin. If the PI is already succeeded (because we replayed
    // through a different code path), `simulate_crypto_deposit` may 4xx — in
    // that case retrieve and check.
    try {
      let pi: Record<string, any>;
      try {
        pi = await requestFacilitator.simulateCryptoDeposit(challenge.paymentIntentId);
      } catch (err) {
        // Fall back to retrieve to check for already-succeeded.
        pi = await requestFacilitator.retrievePaymentIntent(challenge.paymentIntentId);
        if (pi.status !== "succeeded") {
          throw err;
        }
      }
      if (pi.status !== "succeeded") {
        return c.json(
          {
            x402Version: 1,
            error: `settlement: PI ${challenge.paymentIntentId} did not advance to succeeded (status=${pi.status})`,
            accepts: await buildAcceptsList(c, config, requestFacilitator, cache, routeKey, twinOpts)
          },
          402
        );
      }
      cache.rememberSettled(headerB64, {
        piId: challenge.paymentIntentId,
        status: 200,
        result: pi
      });
    } catch (err) {
      return c.json(
        {
          x402Version: 1,
          error: `settlement: ${(err as Error).message}`,
          accepts: await buildAcceptsList(c, config, requestFacilitator, cache, routeKey, twinOpts)
        },
        402
      );
    }

    // Set the X-PAYMENT-RESPONSE header per x402 spec (best-effort) and proxy.
    const respHeader = base64encodeFromString(
      JSON.stringify({
        success: true,
        transaction: challenge.paymentIntentId,
        network: challenge.network,
        payer: auth.from
      })
    );
    c.header("X-PAYMENT-RESPONSE", respHeader);

    await next();
  };

  return Object.assign(handler, {
    facilitator,
    _resetCache: () => cache.clear()
  }) as PaymentMiddlewareHandle;
}

function resolveRouteKey(method: string, pathname: string, routes: RouteMap): string | undefined {
  const direct = `${method} ${pathname}`;
  if (routes[direct]) return direct;
  const sessionless = pathname.replace(/^\/s\/[^/]+/, "") || "/";
  const stripped = `${method} ${sessionless}`;
  return routes[stripped] ? stripped : undefined;
}

function resolveStaticTwinOptions(opts: TwinOptions): ResolvedTwinOptions {
  return {
    ...opts,
    apiKey: typeof opts.apiKey === "function" ? "sk_test_pome_default" : opts.apiKey,
    sid: typeof opts.sid === "function" ? "default" : opts.sid
  };
}

async function resolveTwinOptions(c: Context, opts: TwinOptions): Promise<ResolvedTwinOptions> {
  return {
    ...opts,
    apiKey: await resolveContextValue(c, opts.apiKey),
    sid: await resolveContextValue(c, opts.sid)
  };
}

async function resolveContextValue<T>(c: Context, value: ContextValue<T>): Promise<T> {
  if (typeof value === "function") {
    return (value as (c: Context) => T | Promise<T>)(c);
  }
  return value;
}

async function build402Body(
  c: Context,
  config: RouteConfig,
  facilitator: TwinFacilitatorClient,
  cache: ChallengeCache,
  routeKey: string,
  twinOpts: TwinOptions
): Promise<X402ChallengeBody> {
  const accepts = await buildAcceptsList(c, config, facilitator, cache, routeKey, twinOpts);
  return {
    x402Version: 1,
    accepts,
    error: "payment required"
  };
}

async function buildAcceptsList(
  c: Context,
  config: RouteConfig,
  facilitator: TwinFacilitatorClient,
  cache: ChallengeCache,
  routeKey: string,
  twinOpts: TwinOptions
): Promise<AcceptsEntry[]> {
  const out: AcceptsEntry[] = [];
  for (let i = 0; i < config.accepts.length; i++) {
    const a = config.accepts[i]!;
    const parsed = parsePriceToBaseUnits(a.price);
    const explicitPayTo = await resolveExplicitPayTo(a.payTo, c);

    let payTo: string;
    let piId: string;

    if (explicitPayTo) {
      // Caller provided an address — register a challenge but don't mint a PI yet.
      // We'll need to mint one lazily on settle, OR mint now to keep the PI
      // referenced for later test_helpers settle.
      // v1: mint a PI anyway so settle has somewhere to land.
      const created = await facilitator.createCryptoPaymentIntent({
        amount: Number(parsed.amount),
        // PI currency is always USD per Stripe x402 docs (the on-chain leg
        // is USDC but Stripe captures the PI in USD). parsed.asset is the
        // wire asset name (USDC) and stays in the x402 accepts entry below.
        currency: "usd",
        network: a.network,
        metadata: { x402_route: routeKey, x402_explicit_payTo: explicitPayTo }
      });
      payTo = explicitPayTo;
      piId = created.id;
    } else {
      // Common path: mint a PI, use its deposit address as payTo.
      // Replay safety: if we already have a fresh challenge for this route+amount,
      // reuse it instead of minting a new PI.
      const cached = findReusable(cache, routeKey, i, parsed.amount);
      if (cached) {
        payTo = cached.payTo;
        piId = cached.paymentIntentId;
      } else {
        const created = await facilitator.createCryptoPaymentIntent({
          amount: Number(parsed.amount),
          // PI currency is always USD per Stripe x402 docs (the on-chain leg
        // is USDC but Stripe captures the PI in USD). parsed.asset is the
        // wire asset name (USDC) and stays in the x402 accepts entry below.
        currency: "usd",
          network: a.network,
          metadata: { x402_route: routeKey }
        });
        payTo = created.depositAddress;
        piId = created.id;
      }
    }

    const entry: AcceptsEntry = {
      scheme: "exact",
      network: a.network,
      maxAmountRequired: parsed.amount,
      resource: a.resource ?? c.req.url,
      description: a.description ?? config.description ?? "",
      mimeType: a.mimeType ?? config.mimeType ?? "application/json",
      payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds ?? 60,
      asset: a.asset ?? parsed.asset,
      outputSchema: null,
      extra: a.extra
    };
    out.push(entry);

    cache.rememberChallenge({
      routeKey,
      acceptsIndex: i,
      payTo,
      amount: parsed.amount,
      asset: entry.asset,
      network: a.network,
      paymentIntentId: piId,
      createdAt: Date.now()
    });
  }
  return out;
}

function findReusable(
  cache: ChallengeCache,
  routeKey: string,
  acceptsIndex: number,
  amount: string
): CachedChallenge | undefined {
  // The cache is keyed by payTo, so iterate to find a fresh match.
  // Tiny N (one per active challenge per route); fine for a hot path that
  // already does HTTP I/O.
  for (const c of (cache as any).byPayTo.values() as IterableIterator<CachedChallenge>) {
    if (
      c.routeKey === routeKey &&
      c.acceptsIndex === acceptsIndex &&
      c.amount === amount &&
      Date.now() - c.createdAt < (cache as any).ttlMs
    ) {
      return c;
    }
  }
  return undefined;
}

async function resolveExplicitPayTo(
  payTo: AcceptsEntryInput["payTo"],
  c: Context
): Promise<string | undefined> {
  if (!payTo) return undefined;
  if (typeof payTo === "string") return payTo;
  return await payTo(c);
}
