import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "fixtures");

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function sha256File(rel) {
  return createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
}

const LAUNCH_TOOLS = [
  "create_draft",
  "list_drafts",
  "get_thread",
  "search_threads",
  "label_thread",
  "unlabel_thread",
  "list_labels",
  "label_message",
  "unlabel_message",
  "create_label",
];

test("rest-surface freezes launch methods and names watch/stop as 501 gaps", () => {
  const surface = readJson("fixtures/rest-surface.json");
  assert.equal(surface.meta.discoverySha256, sha256File("fixtures/gmail-discovery-v1.raw.json"));
  const byId = new Map(surface.methods.map((m) => [m.id, m]));
  for (const id of ["users.watch", "users.stop"]) {
    const m = byId.get(id);
    assert.ok(m, id);
    assert.equal(m.launchStatus, "named_gap_501");
  }
  assert.ok(byId.has("users.getProfile"));
  assert.ok(byId.has("users.messages.attachments.get"));
  assert.ok(byId.has("users.history.list"));
  // Resumable protocols are marked unsupported_501
  const send = byId.get("users.messages.send");
  assert.equal(send.mediaUpload.protocols.simple.launchStatus, "supported");
  assert.equal(send.mediaUpload.protocols.resumable.launchStatus, "unsupported_501");
});

test("MCP canonical launch listing is exactly 10 tools in live relative order", () => {
  const canonical = readJson("fixtures/mcp-tools-list.canonical.json");
  const meta = readJson("fixtures/mcp-tools-list.meta.json");
  assert.equal(canonical.meta.protocolVersion, "2025-03-26");
  assert.equal(meta.sha256, sha256File("fixtures/mcp-tools-list.raw.json"));
  const names = canonical.result.tools.map((t) => t.name);
  assert.deepEqual(names, LAUNCH_TOOLS);
  for (const tool of canonical.result.tools) {
    assert.ok(tool.inputSchema, tool.name);
    assert.ok(tool.outputSchema, tool.name);
    assert.ok(tool.annotations, tool.name);
  }
});

test("fidelity inventory covers launch MCP tools and watch/stop 501 gaps", () => {
  const inv = readJson("fidelity.inventory.json");
  const toolNames = new Set(inv.tools.map((t) => t.name));
  for (const name of LAUNCH_TOOLS) {
    assert.ok(toolNames.has(name), name);
    const row = inv.tools.find((t) => t.name === name);
    assert.equal(row.heat, "hot");
    assert.equal(row.fidelity, "semantic");
  }
  const watch = inv.rest.find((r) => r.discoveryId === "users.watch");
  const stop = inv.rest.find((r) => r.discoveryId === "users.stop");
  assert.equal(watch.heat, "cold");
  assert.equal(watch.fidelity, "unsupported");
  assert.equal(stop.heat, "cold");
  assert.equal(stop.fidelity, "unsupported");
  assert.match(watch.justification, /501/);
});
