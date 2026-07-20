// SPDX-License-Identifier: Apache-2.0
import { ZodError } from "zod";

export class GmailError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "GmailError";
  }
}

export function gmailErrorEnvelope(error: unknown): { status: number; body: unknown } {
  if (error instanceof GmailError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.status,
          message: error.message,
          errors: [{ message: error.message, domain: "global", reason: error.reason }],
          status: googleStatus(error.status),
        },
      },
    };
  }
  if (error instanceof ZodError || (error instanceof Error && error.name === "ZodError")) {
    return {
      status: 400,
      body: {
        error: {
          code: 400,
          message: "Invalid request",
          errors: [{ message: "Invalid request", domain: "global", reason: "invalidArgument" }],
          status: "INVALID_ARGUMENT",
        },
      },
    };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        error: {
          code: 400,
          message: "Invalid JSON",
          errors: [{ message: "Invalid JSON", domain: "global", reason: "invalidArgument" }],
          status: "INVALID_ARGUMENT",
        },
      },
    };
  }
  if (
    error instanceof Error &&
    (error.name === "TwinError" || error.name === "UnknownToolError")
  ) {
    const unknownTool = error.name === "UnknownToolError";
    const status =
      unknownTool
        ? 404
        : typeof (error as Error & { status?: unknown }).status === "number"
          ? (error as Error & { status: number }).status
          : 400;
    return {
      status,
      body: {
        error: {
          code: status,
          message: error.message,
          errors: [
            {
              message: error.message,
              domain: "global",
              reason: unknownTool ? "notFound" : "invalidArgument",
            },
          ],
          status: googleStatus(status),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 500,
        message: "Internal error",
        errors: [{ message: "Internal error", domain: "global", reason: "backendError" }],
        status: "INTERNAL",
      },
    },
  };
}

export function notFound(resource = "Requested entity"): never {
  throw new GmailError(404, "notFound", `${resource} was not found.`);
}

export function invalidArgument(message: string): never {
  throw new GmailError(400, "invalidArgument", message);
}

export function unsupported(message: string): never {
  throw new GmailError(501, "notImplemented", message);
}

function googleStatus(status: number): string {
  if (status === 400) return "INVALID_ARGUMENT";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "ALREADY_EXISTS";
  if (status === 501) return "UNIMPLEMENTED";
  return "INTERNAL";
}
