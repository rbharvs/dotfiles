import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKGROUND_AGENT_RESULT_TOOL_NAME,
  BACKGROUND_AGENT_TOOL_NAME,
  STATE_ENTRY_TYPE,
  installBackgroundAgent,
} from "../core.ts";
import { truncateOutput } from "./harness.mjs";

if (process.env.HERDR_ENV !== "1") {
  throw new Error("The live smoke test must run inside Herdr");
}

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      signal: options.signal,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        killed: Boolean(error?.killed || options.signal?.aborted),
      });
    });
  });
}

async function waitFor(predicate, message, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const dir = await mkdtemp(join(tmpdir(), "background-agent-live-"));
const parentPath = join(dir, "parent.jsonl");
await writeFile(parentPath, "");

const tools = new Map();
const handlers = new Map();
const entries = [];
const notices = [];
const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  registerMessageRenderer() {},
  on(event, handler) { handlers.set(event, handler); },
  getActiveTools: () => ["read", BACKGROUND_AGENT_TOOL_NAME, BACKGROUND_AGENT_RESULT_TOOL_NAME],
  getThinkingLevel: () => "off",
  appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  sendMessage(message, delivery) { notices.push({ message, delivery }); },
  exec,
};

installBackgroundAgent(pi, { agent: {}, result: {} }, {
  env: process.env,
  outputLimits: { maxBytes: 50 * 1024, maxLines: 2000 },
  truncateOutput,
});
const ctx = {
  cwd: process.cwd(),
  model: { provider: "openai", id: "gpt-5.6-luna" },
  scopedModels: [{ model: { provider: "openai", id: "gpt-5.6-luna" } }],
  thinkingLevel: "off",
  isProjectTrusted: () => true,
  sessionManager: {
    getBranch: () => entries,
    getSessionFile: () => parentPath,
    getSessionId: () => "live-smoke-parent",
  },
};

const createdTabs = new Set();
try {
  assert.ok(tools.has(BACKGROUND_AGENT_TOOL_NAME), "background_agent did not register");
  assert.ok(tools.has(BACKGROUND_AGENT_RESULT_TOOL_NAME), "background_agent_result did not register");
  await handlers.get("session_start")({ reason: "startup" }, ctx);

  const first = await tools.get(BACKGROUND_AGENT_TOOL_NAME).execute(
    "live-first",
    { prompt: "Reply with exactly FIRST_OK and nothing else.", model: "openai/gpt-5.6-luna", thinking: "off" },
    undefined,
    undefined,
    ctx,
  );
  for (const entry of entries) if (entry.data?.tabId) createdTabs.add(entry.data.tabId);
  await waitFor(() => notices.length >= 1, "first background run did not complete");
  const firstResult = await tools.get(BACKGROUND_AGENT_RESULT_TOOL_NAME).execute(
    "live-first-result", { run_id: first.details.runId }, undefined, undefined, ctx,
  );
  assert.equal(firstResult.content[0].text.trim(), "FIRST_OK");

  const followUp = await tools.get(BACKGROUND_AGENT_TOOL_NAME).execute(
    "live-follow-up",
    { prompt: "Reply with exactly SECOND_OK and nothing else.", session: first.details.session },
    undefined,
    undefined,
    ctx,
  );
  for (const entry of entries) if (entry.data?.tabId) createdTabs.add(entry.data.tabId);
  await waitFor(() => notices.length >= 2, "follow-up background run did not complete");
  const secondResult = await tools.get(BACKGROUND_AGENT_RESULT_TOOL_NAME).execute(
    "live-second-result", { run_id: followUp.details.runId }, undefined, undefined, ctx,
  );
  assert.equal(secondResult.content[0].text.trim(), "SECOND_OK");

  const terminal = entries
    .filter((entry) => entry.customType === STATE_ENTRY_TYPE && entry.data?.phase === "succeeded")
    .map((entry) => entry.data);
  const firstState = terminal.find((record) => record.runId === first.details.runId);
  const secondState = terminal.find((record) => record.runId === followUp.details.runId);
  assert.equal(secondState.childSessionId, firstState.childSessionId);
  assert.equal(secondState.childSessionPath, firstState.childSessionPath);
  console.log(`live smoke passed: ${first.details.session} reused ${firstState.childSessionId}`);
} finally {
  await handlers.get("session_shutdown")?.({ reason: "test-complete" }, ctx);
  for (const tabId of createdTabs) {
    await exec("herdr", ["tab", "close", tabId]);
  }
  await rm(dir, { recursive: true, force: true });
}
