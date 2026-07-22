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

describe("SlackDomain files and search", () => {
  it("files.upload then files.list includes file", () => {
    const { domain } = fresh();
    const uploaded = domain.filesUpload(
      { channels: "C_GENERAL", filename: "note.txt", content: "hello file" },
      { login: "pome-agent" }
    ) as { file: { id: string } };
    const listed = domain.filesList({}) as { files: Array<{ id: string }> };
    expect(listed.files.some((f) => f.id === uploaded.file.id)).toBe(true);
  });

  it("search.messages finds public channel text", () => {
    const { domain } = fresh();
    const token = "searchable-unique-phrase-12345";
    domain.chatPostMessage({ channel: "C_GENERAL", text: token }, { login: "pome-agent" });
    const result = domain.searchMessages({ query: token }, { login: "pome-agent" }) as {
      messages: { matches: Array<{ text: string }> };
    };
    expect(result.messages.matches.some((m) => m.text === token)).toBe(true);
  });

  it("search.messages rejects empty query", () => {
    const { domain } = fresh();
    expect(() => domain.searchMessages({ query: "   " }, { login: "pome-agent" })).toThrow(/no_query/);
  });
});
