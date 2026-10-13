import assert from "node:assert/strict";
import { appendFile, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { CHILD_ID, HANDLE, createHarness, ok, waitFor } from "./harness.mjs";

const line = (entry) => `${JSON.stringify(entry)}\n`;
const usage = (kind = "cache_warm") => ({
  type: "usage", kind, provider: "test", model: "test-model",
  usage: {
    input: 0, output: 0, cacheRead: 100, cacheWrite: 0, totalTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
  },
});

async function settled(t) {
  const harness = await createHarness();
  t.after(async () => {
    await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
    await rm(harness.dir, { recursive: true, force: true });
  });
  await harness.agentTool.execute("start", { prompt: "First task" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), line({ type: "session_info", name: "original-name" }) + line({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  }));
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded" && harness.closedTabs.length === 1,
    "first run did not settle and clean up");
  return harness;
}

for (const [label, tail, expectedName] of [
  ["warming usage", [usage()], "original-name"],
  ["unknown usage kind", [usage("future_kind")], "original-name"],
  ["mixed name updates", [usage(), { type: "session_info", name: "earlier-name" }, usage(),
    { type: "session_info", name: "latest-name" }, usage()], "latest-name"],
  ["explicit name clearing", [usage(), { type: "session_info", name: null }, usage()], undefined],
]) {
  test(`follow-up accepts ${label} and preserves the correct name`, async (t) => {
    const harness = await settled(t);
    const previousRevision = harness.latestState().childRevision;
    await appendFile(harness.childPath(), tail.map(line).join(""));
    const revision = (await stat(harness.childPath())).size;
    const result = await harness.agentTool.execute("next", { prompt: "Continue", session: HANDLE },
      undefined, undefined, harness.ctx);
    assert.equal(result.details.sessionName, expectedName);
    assert.equal(harness.latestState().baselineBytes, revision);
    assert.ok(revision > previousRevision);
  });
}

test("accepts usage after rebuilding parent state", async (t) => {
  const harness = await settled(t);
  await harness.handlers.get("session_shutdown")({}, harness.ctx);
  const recovered = await createHarness({
    dir: harness.dir,
    entries: structuredClone(harness.entries),
    ids: { runs: ["run_0000000000000002"], handles: [], children: [] },
  });
  t.after(() => recovered.handlers.get("session_shutdown")({}, recovered.ctx));
  await appendFile(harness.childPath(), line(usage()));
  const result = await recovered.agentTool.execute("next", { prompt: "Continue", session: HANDLE },
    undefined, undefined, recovered.ctx);
  assert.equal(result.details.sessionName, "original-name");
  assert.equal(recovered.latestState().baselineBytes, (await stat(harness.childPath())).size);
});

for (const [label, tail] of [
  ...["message", "context_edit", "model_change", "custom"].map((type) => [type, line(usage()) + line({ type })]),
  ["partial line", line(usage()).trimEnd()],
  ["malformed JSON", line(usage()) + "{broken}\n"],
  ["oversized tail", line(usage()) + line({ type: "session_info", name: "x".repeat(1024 * 1024) })],
]) {
  test(`follow-up rejects ${label} without backend effects`, async (t) => {
    const harness = await settled(t);
    await appendFile(harness.childPath(), tail);
    const calls = harness.calls.length;
    await assert.rejects(harness.agentTool.execute("next", { prompt: "Continue", session: HANDLE },
      undefined, undefined, harness.ctx), /transcript.*changed|revision|new.*session/i);
    assert.equal(harness.calls.length, calls);
  });
}

test("usage does not permit a different child session identity", async (t) => {
  const harness = await settled(t);
  const revision = harness.latestState().childRevision;
  const header = line({ type: "session", version: 3, id: CHILD_ID.replace(/^1/, "2"), cwd: "/repo" });
  await writeFile(harness.childPath(), header + " ".repeat(revision - Buffer.byteLength(header)) + line(usage()));
  const calls = harness.calls.length;
  await assert.rejects(harness.agentTool.execute("next", { prompt: "Continue", session: HANDLE },
    undefined, undefined, harness.ctx));
  assert.equal(harness.calls.length, calls);
});
