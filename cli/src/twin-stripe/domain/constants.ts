// SPDX-License-Identifier: Apache-2.0
// Stripe domain constants. Owned by AGENT-B.

/** The only API version this twin serves natively. */
export const STRIPE_API_VERSION = "2026-03-04.preview";

/** Default capture method for v1 PIs. */
export const DEFAULT_CAPTURE_METHOD = "automatic";

/** Default confirmation method for v1 PIs. */
export const DEFAULT_CONFIRMATION_METHOD = "automatic";

/**
 * Real Base USDC contract. Used as the supported_token contract address in
 * the crypto deposit `next_action`. Hard-coded so agents that pin it work.
 */
export const BASE_USDC_CONTRACT_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Supported deposit network for v1 (only Base). */
export const SUPPORTED_NETWORKS = ["base"] as const;
export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

/** Supported tokens for crypto deposits. */
export const SUPPORTED_TOKENS = ["usdc"] as const;
export type SupportedToken = (typeof SUPPORTED_TOKENS)[number];

/**
 * PaymentIntent.currency values v1 accepts. Per Stripe's x402 docs the PI is
 * denominated in USD — the customer's deposit settles in USDC on Base, but
 * Stripe captures the PI in USD. We accept "usd" only in v1; the
 * stablecoin/network combo lives in `payment_method_options.crypto`, not in
 * PI.currency.
 */
export const CRYPTO_CURRENCIES = ["usd"] as const;
