// SPDX-License-Identifier: Apache-2.0
// Stripe-shaped error envelope (D-ENG-8).
//
// Every error response from the twin uses this shape. The `fidelity` and
// `supported_surfaces` fields are pome extensions — they are extra fields
// inside `error` so a real Stripe SDK ignores them, but a pome-aware test
// harness can assert against them.

export type StripeErrorType =
  | "invalid_request_error"
  | "api_error"
  | "card_error"
  | "idempotency_error"
  | "rate_limit_error";

// Mirrors the canonical RecorderEvent.fidelity from @pome-sh/shared-types
// (FDRS-318). The recorder logs whichever value the envelope carries, so a
// looser union here would let invalid events slip onto the wire.
export type StripeErrorFidelity = "semantic" | "unsupported";

import type { StateDelta } from "@pome-sh/shared-types";

export type StripeErrorOpts = {
  param?: string;
  doc_url?: string;
  statusCode?: number;
  fidelity?: StripeErrorFidelity;
  supported_surfaces?: string[];
  /** Card declines: Stripe's issuer decline reason (`generic_decline`, …). */
  decline_code?: string;
  /** Card declines: real Stripe embeds the post-attempt PaymentIntent. */
  payment_intent?: unknown;
  /**
   * Card declines commit real state (failed charge, events, PI transition)
   * before the 402 is thrown — the only error path in the twin that
   * mutates. These recorder-only fields let handle() log the truth; they
   * never serialize into the wire envelope.
   */
  state_mutation?: boolean;
  state_delta?: StateDelta;
};

export type StripeErrorEnvelope = {
  error: {
    type: StripeErrorType;
    code: string;
    message: string;
    param?: string;
    doc_url?: string;
    fidelity?: StripeErrorFidelity;
    supported_surfaces?: string[];
    decline_code?: string;
    payment_intent?: unknown;
  };
};

/**
 * Thrown by domain code; caught by the request pipeline and turned into a
 * Stripe-shaped JSON response via `stripeError()`. Domain code never builds
 * the envelope by hand.
 */
export class TwinError extends Error {
  readonly status: number;
  readonly type: StripeErrorType;
  readonly code: string;
  readonly param?: string;
  readonly doc_url?: string;
  readonly fidelity?: StripeErrorFidelity;
  readonly supported_surfaces?: string[];
  readonly decline_code?: string;
  readonly payment_intent?: unknown;
  readonly state_mutation?: boolean;
  readonly state_delta?: StateDelta;

  constructor(
    type: StripeErrorType,
    code: string,
    message: string,
    opts: StripeErrorOpts = {}
  ) {
    super(message);
    this.type = type;
    this.code = code;
    this.status = opts.statusCode ?? 400;
    this.param = opts.param;
    this.doc_url = opts.doc_url;
    this.fidelity = opts.fidelity;
    this.supported_surfaces = opts.supported_surfaces;
    this.decline_code = opts.decline_code;
    this.payment_intent = opts.payment_intent;
    this.state_mutation = opts.state_mutation;
    this.state_delta = opts.state_delta;
  }

  toEnvelope(): StripeErrorEnvelope {
    return stripeError(this.type, this.code, this.message, {
      param: this.param,
      doc_url: this.doc_url,
      fidelity: this.fidelity,
      supported_surfaces: this.supported_surfaces,
      decline_code: this.decline_code,
      payment_intent: this.payment_intent
    }).body;
  }
}

/** Build a Stripe-shaped error envelope + the HTTP status to return with it. */
export function stripeError(
  type: StripeErrorType,
  code: string,
  message: string,
  opts: StripeErrorOpts = {}
): { status: number; body: StripeErrorEnvelope } {
  const error: StripeErrorEnvelope["error"] = { type, code, message };
  if (opts.param !== undefined) error.param = opts.param;
  if (opts.doc_url !== undefined) error.doc_url = opts.doc_url;
  if (opts.fidelity !== undefined) error.fidelity = opts.fidelity;
  if (opts.supported_surfaces !== undefined) {
    error.supported_surfaces = opts.supported_surfaces;
  }
  if (opts.decline_code !== undefined) error.decline_code = opts.decline_code;
  if (opts.payment_intent !== undefined) error.payment_intent = opts.payment_intent;
  return {
    status: opts.statusCode ?? 400,
    body: { error }
  };
}

// Convenience helpers used by the chassis itself.

export function unauthorized(message = "Invalid API Key provided.") {
  return stripeError("invalid_request_error", "unauthorized", message, {
    statusCode: 401
  });
}

export function forbidden(message = "Forbidden") {
  return stripeError("invalid_request_error", "forbidden", message, {
    statusCode: 403
  });
}

export function notFound(message = "Resource not found.") {
  return stripeError("invalid_request_error", "resource_missing", message, {
    statusCode: 404
  });
}

export function unsupported() {
  return stripeError(
    "invalid_request_error",
    "endpoint_not_supported",
    "This endpoint is not supported by this Stripe twin clone.",
    {
      statusCode: 501,
      fidelity: "unsupported",
      supported_surfaces: [
        "Stripe-shaped REST under /v1/*",
        "GET /s/:sid/mcp/tools",
        "POST /s/:sid/mcp/call",
        "POST /s/:sid/mcp/tools/:name"
      ]
    }
  );
}
