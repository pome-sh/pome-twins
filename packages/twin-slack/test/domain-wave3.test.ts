// SPDX-License-Identifier: Apache-2.0
//
// Wave 3 warm-gap fills: canvases.*, conversations.setTopic/setPurpose, emoji.list.
import { describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { TwinError } from "../src/errors.js";
import { defaultSeedState } from "../src/seed.js";

function fresh() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return { db, domain };
}

function errCode(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected TwinError");
  } catch (err) {
    expect(err).toBeInstanceOf(TwinError);
    return (err as TwinError).code;
  }
}

describe("Wave 3 — conversations.setTopic / setPurpose", () => {
  it("setTopic updates channel topic and returns channel envelope", () => {
    const { domain } = fresh();
    const result = domain.conversationsSetTopic(
      { channel: "C_GENERAL", topic: "Apply topically for best effects" },
      { login: "pome-agent" }
    ) as { channel: { id: string; topic: { value: string } } };
    expect(result.channel.id).toBe("C_GENERAL");
    expect(result.channel.topic.value).toBe("Apply topically for best effects");

    const info = domain.conversationsInfo({ channel: "C_GENERAL" }, { login: "pome-agent" }) as {
      channel: { topic: { value: string } };
    };
    expect(info.channel.topic.value).toBe("Apply topically for best effects");
  });

  it("setPurpose updates channel purpose", () => {
    const { domain } = fresh();
    const result = domain.conversationsSetPurpose(
      { channel: "C_GENERAL", purpose: "Ship the twin" },
      { login: "alice" }
    ) as { channel: { purpose: { value: string } } };
    expect(result.channel.purpose.value).toBe("Ship the twin");
  });

  it("rejects too_long topic and not_in_channel on empty membership", () => {
    const { domain } = fresh();
    expect(
      errCode(() =>
        domain.conversationsSetTopic(
          { channel: "C_GENERAL", topic: "x".repeat(251) },
          { login: "pome-agent" }
        )
      )
    ).toBe("too_long");
    expect(
      errCode(() =>
        domain.conversationsSetTopic(
          { channel: "C_RANDOM", topic: "hello" },
          { login: "pome-agent" }
        )
      )
    ).toBe("not_in_channel");
  });

  it("rejects archived channels", () => {
    const { domain } = fresh();
    const created = domain.conversationsCreate({ name: "archivable" }, { login: "pome-agent" }) as {
      channel: { id: string };
    };
    domain.conversationsArchive({ channel: created.channel.id }, { login: "pome-agent" });
    expect(
      errCode(() =>
        domain.conversationsSetTopic(
          { channel: created.channel.id, topic: "nope" },
          { login: "pome-agent" }
        )
      )
    ).toBe("is_archived");
  });
});

describe("Wave 3 — canvases.create / edit / delete", () => {
  it("create → edit → delete lifecycle", () => {
    const { domain, db } = fresh();
    const created = domain.canvasesCreate(
      {
        title: "Standup notes",
        document_content: { type: "markdown", markdown: "# Hello" },
      },
      { login: "pome-agent" }
    ) as { canvas_id: string };
    expect(created.canvas_id).toMatch(/^F\d{6}$/);

    domain.canvasesEdit(
      {
        canvas_id: created.canvas_id,
        changes: [{ operation: "insert_at_end", document_content: { type: "markdown", markdown: "world" } }],
      },
      { login: "pome-agent" }
    );
    const row = db.prepare(`SELECT title, markdown FROM canvases WHERE id = ?`).get(created.canvas_id) as {
      title: string;
      markdown: string;
    };
    expect(row.title).toBe("Standup notes");
    expect(row.markdown).toBe("# Hello\nworld");

    domain.canvasesEdit(
      {
        canvas_id: created.canvas_id,
        changes: [{ operation: "rename", title_content: { type: "markdown", markdown: "Renamed" } }],
      },
      { login: "pome-agent" }
    );
    const renamed = db.prepare(`SELECT title FROM canvases WHERE id = ?`).get(created.canvas_id) as {
      title: string;
    };
    expect(renamed.title).toBe("Renamed");

    domain.canvasesDelete({ canvas_id: created.canvas_id }, { login: "pome-agent" });
    expect(db.prepare(`SELECT 1 FROM canvases WHERE id = ?`).get(created.canvas_id)).toBeUndefined();
  });

  it("delete/edit missing canvas → canvas_not_found", () => {
    const { domain } = fresh();
    expect(errCode(() => domain.canvasesDelete({ canvas_id: "F_MISSING" }, { login: "pome-agent" }))).toBe(
      "canvas_not_found"
    );
    expect(
      errCode(() =>
        domain.canvasesEdit(
          { canvas_id: "F_MISSING", changes: [{ operation: "insert_at_end", document_content: { type: "markdown", markdown: "x" } }] },
          { login: "pome-agent" }
        )
      )
    ).toBe("canvas_not_found");
  });
});

describe("Wave 3 — emoji.list", () => {
  it("returns seeded custom emoji map with alias protocol", () => {
    const { domain } = fresh();
    const result = domain.emojiList() as { emoji: Record<string, string> };
    expect(result.emoji.shipit).toBe("alias:squirrel");
    expect(result.emoji.squirrel).toMatch(/\/emoji\/squirrel\//);
    expect(result.emoji.bowtie).toMatch(/\/emoji\/bowtie\//);
  });
});
