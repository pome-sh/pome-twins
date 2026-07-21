// SPDX-License-Identifier: Apache-2.0
import { ZodError } from "zod";

export class LinearTwinError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extensions: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "LinearTwinError";
  }

  toGraphQLError(): { message: string; extensions: Record<string, unknown> } {
    return {
      message: this.message,
      extensions: {
        code: this.code,
        http: { status: this.status },
        ...this.extensions,
      },
    };
  }
}

export function unauthorizedEnvelope(message = "Authentication required"): {
  status: number;
  body: unknown;
} {
  return {
    status: 401,
    body: {
      errors: [
        {
          message,
          extensions: { code: "AUTHENTICATION_ERROR", http: { status: 401 } },
        },
      ],
    },
  };
}

export function unsupportedEnvelope(method: string, path: string): {
  status: number;
  body: unknown;
} {
  return {
    status: 501,
    body: {
      message: `Unsupported Linear twin route: ${method} ${path}`,
      errors: [
        {
          message: "Not implemented",
          extensions: { code: "UNIMPLEMENTED", http: { status: 501 } },
        },
      ],
      fidelity: "unsupported",
      method,
      path,
    },
  };
}

export function linearErrorEnvelope(error: unknown): { status: number; body: unknown } {
  if (error instanceof LinearTwinError) {
    return {
      status: error.status,
      body: { errors: [error.toGraphQLError()] },
    };
  }
  if (error instanceof ZodError || (error instanceof Error && error.name === "ZodError")) {
    const message =
      error instanceof ZodError
        ? (error.issues[0]?.message ?? "Invalid request")
        : "Invalid request";
    return {
      status: 400,
      body: {
        errors: [
          {
            message,
            extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
          },
        ],
      },
    };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        errors: [
          {
            message: "Invalid JSON",
            extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
          },
        ],
      },
    };
  }
  if (error instanceof Error && error.name === "UnknownToolError") {
    return {
      status: 404,
      body: {
        errors: [
          {
            message: error.message,
            extensions: { code: "NOT_FOUND", http: { status: 404 } },
          },
        ],
      },
    };
  }
  return {
    status: 500,
    body: {
      errors: [
        {
          message: error instanceof Error ? error.message : "Internal Server Error",
          extensions: { code: "INTERNAL_SERVER_ERROR", http: { status: 500 } },
        },
      ],
    },
  };
}

export function badUserInput(message: string, extensions: Record<string, unknown> = {}): never {
  throw new LinearTwinError(400, "BAD_USER_INPUT", message, extensions);
}

export function notFound(message: string): never {
  throw new LinearTwinError(404, "NOT_FOUND", message);
}

export function authenticationError(message = "Authentication required"): never {
  throw new LinearTwinError(401, "AUTHENTICATION_ERROR", message);
}

export function forbidden(message = "Forbidden"): never {
  throw new LinearTwinError(403, "FORBIDDEN", message);
}
