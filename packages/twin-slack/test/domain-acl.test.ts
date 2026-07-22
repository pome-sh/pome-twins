import { describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";

function fresh() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return { db, domain };
}

describe("private channel membership ACL", () => {
  it("non-member cannot read conversations.history on a private channel", () => {
    const { domain } = fresh();
    const created = domain.conversationsCreate(
      { name: "secret-team", is_private: true },
      { login: "alice" }
    ) as { channel: { id: string } };
    domain.chatPostMessage({ channel: created.channel.id, text: "classified" }, { login: "alice" });
    expect(() =>
      domain.conversationsHistory({ channel: created.channel.id }, { login: "bob" })
    ).toThrow(/not_in_channel/);
  });

  it("non-member search excludes private channel messages", () => {
    const { domain } = fresh();
    const created = domain.conversationsCreate(
      { name: "secret-search", is_private: true },
      { login: "alice" }
    ) as { channel: { id: string } };
    const unique = "xyzzy-private-only-token";
    domain.chatPostMessage({ channel: created.channel.id, text: unique }, { login: "alice" });
    const bobSearch = domain.searchMessages({ query: unique }, { login: "bob" }) as {
      messages: { matches: unknown[] };
    };
    expect(bobSearch.messages.matches).toHaveLength(0);
    const aliceSearch = domain.searchMessages({ query: unique }, { login: "alice" }) as {
      messages: { matches: unknown[] };
    };
    expect(aliceSearch.messages.matches.length).toBeGreaterThanOrEqual(1);
  });
});
