import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { findChildSessionPath, readFinalAssistant } from "../core.ts";
import { CHILD_ID } from "./harness.mjs";

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(lines, id = CHILD_ID) {
  const dir = await mkdtemp(join(tmpdir(), "background-agent-transcript-"));
  tempDirs.push(dir);
  const path = join(dir, `timestamp_${id}.jsonl`);
  const header = `${JSON.stringify({ type: "session", version: 3, id, cwd: "/repo" })}\n`;
  await writeFile(path, header + lines.join("\n") + (lines.length ? "\n" : ""));
  return { dir, path, baseline: Buffer.byteLength(header) };
}

test("extracts only the final post-baseline assistant answer", async () => {
  const data = await fixture([
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "tool preface" }], stopReason: "toolUse" } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } }),
    "{truncated",
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Final " }, { type: "text", text: "answer" }], stopReason: "stop" } }),
  ]);

  assert.equal(await readFinalAssistant(data.path, data.baseline, CHILD_ID), "Final answer");
  assert.equal(await findChildSessionPath(data.dir, CHILD_ID), data.path);
});

test("rejects wrong sessions, terminal errors, and missing answers", async () => {
  const wrong = await fixture([], "22222222-2222-7222-8222-222222222222");
  await assert.rejects(readFinalAssistant(wrong.path, wrong.baseline, CHILD_ID), /different Pi session/i);

  const failed = await fixture([
    JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" } }),
  ]);
  await assert.rejects(readFinalAssistant(failed.path, failed.baseline, CHILD_ID), /provider failed/);

  const empty = await fixture(["{truncated"]);
  await assert.rejects(readFinalAssistant(empty.path, empty.baseline, CHILD_ID), /without a new final assistant reply/i);
});

test("reads only the current run from a large reusable transcript", async () => {
  const data = await fixture([]);
  const file = await open(data.path, "r+");
  const baseline = 65 * 1024 * 1024;
  await file.truncate(baseline);
  await file.close();
  await appendFile(data.path, `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Small new answer" }], stopReason: "stop" },
  })}\n`);

  assert.equal(await readFinalAssistant(data.path, baseline, CHILD_ID), "Small new answer");
});
