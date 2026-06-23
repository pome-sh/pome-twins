import { describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";

function fresh() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return { db, domain };
}

describe("SlackDomain conversations", () => {
  it("conversations.join returns already_in_channel on second join", () => {
    const { domain } = fresh();
    const created = domain.conversationsCreate({ name: "joinable" }, { login: "alice" }) as {
      channel: { id: string };
    };
    domain.conversationsJoin({ channel: created.channel.id }, { login: "bob" });
    const again = domain.conversationsJoin({ channel: created.channel.id }, { login: "bob" }) as {
      already_in_channel: boolean;
    };
    expect(again.already_in_channel).toBe(true);
  });

  it("conversations.open dedupes DM for same user pair", () => {
    const { domain } = fresh();
    const first = domain.conversationsOpen({ users: "U_ALICE" }, { login: "pome-agent" }) as {
      channel: { id: string };
      already_open?: boolean;
    };
    const second = domain.conversationsOpen({ users: "U_ALICE" }, { login: "pome-agent" }) as {
      channel: { id: string };
      already_open?: boolean;
    };
    expect(second.already_open).toBe(true);
    expect(second.channel.id).toBe(first.channel.id);
  });

  it("cant_archive_general", () => {
    const { domain } = fresh();
    expect(() => domain.conversationsArchive({ channel: "C_GENERAL" }, { login: "pome-agent" })).toThrow(
      /cant_archive_general/
    );
  });

  it("conversations.leave general is forbidden", () => {
    const { domain } = fresh();
    expect(() => domain.conversationsLeave({ channel: "C_GENERAL" }, { login: "pome-agent" })).toThrow(
      /cant_leave_general/
    );
  });

  it("conversations.open returns deterministic DM id regardless of caller order", () => {
    const { domain } = fresh();
    const aOpensB = domain.conversationsOpen({ users: "U_ALICE" }, { login: "pome-agent" }) as {
      channel: { id: string };
    };
    // Re-open from the other side: alice opens with pome-agent
    const bOpensA = domain.conversationsOpen({ users: "U_PRIMARY" }, { login: "alice" }) as {
      channel: { id: string };
      already_open?: boolean;
    };
    expect(bOpensA.already_open).toBe(true);
    expect(bOpensA.channel.id).toBe(aOpensB.channel.id);
  });

  it("conversations.open MPIM dedups by member set regardless of order", () => {
    const { domain } = fresh();
    const first = domain.conversationsOpen({ users: "U_ALICE,U_BOB" }, { login: "pome-agent" }) as {
      channel: { id: string };
    };
    const second = domain.conversationsOpen({ users: "U_BOB,U_ALICE" }, { login: "pome-agent" }) as {
      channel: { id: string };
      already_open?: boolean;
    };
    expect(second.already_open).toBe(true);
    expect(second.channel.id).toBe(first.channel.id);
  });

  it("conversations.create distinguishes invalid_name_* error codes", () => {
    const { domain } = fresh();
    expect(() => domain.conversationsCreate({ name: "" }, { login: "pome-agent" })).toThrow(
      /invalid_name_required/
    );
    expect(() =>
      domain.conversationsCreate({ name: "x".repeat(81) }, { login: "pome-agent" })
    ).toThrow(/invalid_name_maxlength/);
    expect(() => domain.conversationsCreate({ name: "BadCaps" }, { login: "pome-agent" })).toThrow(
      /invalid_name_specials/
    );
    expect(() => domain.conversationsCreate({ name: "has spaces" }, { login: "pome-agent" })).toThrow(
      /invalid_name_specials/
    );
    expect(() => domain.conversationsCreate({ name: "-leading-dash" }, { login: "pome-agent" })).toThrow(
      /invalid_name_punctuation/
    );
    expect(() => domain.conversationsCreate({ name: "_leading_underscore" }, { login: "pome-agent" })).toThrow(
      /invalid_name_punctuation/
    );
    expect(() => domain.conversationsCreate({ name: "12345" }, { login: "pome-agent" })).toThrow(
      /invalid_name_punctuation/
    );
  });

  it("dm_signature unique index prevents duplicate DM rows", () => {
    const { db, domain } = fresh();
    domain.conversationsOpen({ users: "U_ALICE" }, { login: "pome-agent" });
    // Sorted signature for { U_PRIMARY, U_ALICE } is "U_ALICE|U_PRIMARY".
    const rows = db
      .prepare(`SELECT id, dm_signature FROM channels WHERE dm_signature = ?`)
      .all("U_ALICE|U_PRIMARY") as Array<{ id: string }>;
    expect(rows.length).toBe(1);
  });
});
