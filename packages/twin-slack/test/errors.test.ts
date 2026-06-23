import { describe, expect, it } from "vitest";
import {
  TwinError,
  buildSlackErrorPayload,
  isSqliteConstraintError,
  notFound,
  twinErrorFromSqliteConstraint,
  validationFailed,
} from "../src/errors.js";

describe("errors helpers", () => {
  it("buildSlackErrorPayload includes code", () => {
    const err = new TwinError("name_taken", 409, "name_taken");
    expect(buildSlackErrorPayload(err)).toEqual({ ok: false, error: "name_taken" });
  });

  it("isSqliteConstraintError detects constraint codes", () => {
    expect(isSqliteConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
    expect(isSqliteConstraintError(new Error("nope"))).toBe(false);
  });

  it("twinErrorFromSqliteConstraint maps channel name conflicts", () => {
    const mapped = twinErrorFromSqliteConstraint("conversations.create", {
      code: "SQLITE_CONSTRAINT_UNIQUE",
      message: "channels_name_idx",
    });
    expect(mapped?.code).toBe("name_taken");
    expect(mapped?.status).toBe(409);
  });

  it("notFound throws TwinError", () => {
    expect(() => notFound("channel_not_found")).toThrow(TwinError);
  });

  it("maps reaction constraint conflicts", () => {
    const mapped = twinErrorFromSqliteConstraint("reactions.add", {
      code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      message: "reactions",
    });
    expect(mapped?.code).toBe("already_reacted");
  });

  it("maps pin constraint conflicts to already_pinned", () => {
    const mapped = twinErrorFromSqliteConstraint("pins.add", {
      code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      message: "pins",
    });
    expect(mapped?.code).toBe("already_pinned");
  });

  it("unmapped constraint falls through to internal_error", () => {
    const err = Object.assign(new Error("FOREIGN KEY violated"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
    const mapped = twinErrorFromSqliteConstraint("unknown.method", err);
    expect(mapped?.code).toBe("internal_error");
    expect(mapped?.status).toBe(500);
    expect(mapped?.extra?.warning).toBe("FOREIGN KEY violated");
  });

  it("non-constraint error returns null", () => {
    expect(twinErrorFromSqliteConstraint("conversations.create", new Error("foo"))).toBeNull();
  });

  it("isSqliteConstraintError handles non-objects", () => {
    expect(isSqliteConstraintError(null)).toBe(false);
    expect(isSqliteConstraintError(undefined)).toBe(false);
    expect(isSqliteConstraintError("string")).toBe(false);
  });

  it("validationFailed throws TwinError with default code", () => {
    try {
      validationFailed();
      expect.fail("validationFailed should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TwinError);
      expect((err as TwinError).code).toBe("invalid_arguments");
      expect((err as TwinError).status).toBe(400);
    }
  });

  it("validationFailed with custom code + extra preserves both", () => {
    try {
      validationFailed("invalid_blocks", { foo: "bar" });
      expect.fail("validationFailed should have thrown");
    } catch (err) {
      expect((err as TwinError).code).toBe("invalid_blocks");
      expect((err as TwinError).extra).toEqual({ foo: "bar" });
    }
  });
});
