import assert from "node:assert/strict";
import { appendFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  BACKGROUND_AGENT_RESULT_TOOL_NAME,
  BACKGROUND_AGENT_TOOL_NAME,
  COMPLETION_MESSAGE_TYPE,
  RUNNING_MESSAGE,
  STATE_ENTRY_TYPE,
  installBackgroundAgent,
} from "../core.ts";
import { CHILD_ID, HANDLE, RUN_ID, createHarness, deferred, ok, truncateOutput, waitFor } from "./harness.mjs";

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("registers only in a root Herdr session", () => {
  for (const env of [
    {},
    { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", PI_BACKGROUND_AGENT_DEPTH: "1" },
    { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", PI_BACKGROUND_AGENT_DEPTH: "invalid" },
  ]) {
    const tools = [];
    installBackgroundAgent({ registerTool: (tool) => tools.push(tool) }, {}, { env });
    assert.deepEqual(tools, []);
  }

  const tools = [];
  const messageRenderers = new Map();
  installBackgroundAgent({
    registerTool: (tool) => tools.push(tool),
    registerMessageRenderer: (type, renderer) => messageRenderers.set(type, renderer),
    on() {},
  }, {}, {
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
    outputLimits: { maxBytes: 50 * 1024, maxLines: 2000 },
    truncateOutput,
  });
  assert.deepEqual(tools.map((tool) => tool.name), [BACKGROUND_AGENT_TOOL_NAME, BACKGROUND_AGENT_RESULT_TOOL_NAME]);
  assert.doesNotMatch(tools[0].description, /Herdr|tab|pane|PTY/i);
  for (const tool of tools) {
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }
  assert.equal(typeof messageRenderers.get(COMPLETION_MESSAGE_TYPE), "function");
});

test("runs a new session to durable completion before notification and cleanup", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);

  await assert.rejects(
    harness.agentTool.execute("bad-model", { prompt: "work", model: "openai/missing" }, undefined, undefined, harness.ctx),
    /not available.*gpt-5\.6-luna/i,
  );
  assert.equal(harness.calls.length, 0);

  const launched = await harness.agentTool.execute("start", {
    prompt: "Review the authentication flow",
    model: "openai/gpt-5.6-luna",
    thinking: "max",
  }, undefined, undefined, harness.ctx);

  assert.equal(launched.details.session, HANDLE);
  assert.equal(launched.details.runId, RUN_ID);
  assert.equal(launched.details.phase, "running");
  assert.match(launched.content[0].text, /session.*sub_a1b2c3d4/is);
  assert.doesNotMatch(launched.content[0].text, /Herdr|tab|pane|PTY/i);
  assert.deepEqual(harness.calls[0], [
    "tab", "create", "--workspace", "w1", "--cwd", "/repo",
    "--env", "PI_BACKGROUND_AGENT_DEPTH=1", "--no-focus",
  ]);
  assert.deepEqual(harness.calls[1], [
    "agent", "start", HANDLE, "--kind", "pi", "--pane", "w1:p2", "--",
    "--session-id", CHILD_ID, "--session-dir", harness.dir,
    "--model", "openai/gpt-5.6-luna", "--thinking", "max",
    "--tools", "read,bash", "--approve",
  ]);
  assert.deepEqual(harness.calls[2], [
    "agent", "prompt", HANDLE, "Review the authentication flow",
    "--wait", "--until", "idle", "--until", "done", "--until", "blocked",
    "--until", "unknown",
  ]);
  assert.equal(harness.prompts.length, 1, "the tool must return while settlement remains pending");
  assert.equal(harness.latestState().phase, "running");

  const early = await harness.resultTool.execute(
    "early", { run_id: launched.details.runId }, undefined, undefined, harness.ctx,
  );
  assert.equal(early.content[0].text, RUNNING_MESSAGE);

  const childPath = harness.childPath();
  await appendFile(
    childPath,
    `${JSON.stringify({ type: "session_info", name: "auth-flow" })}\n` +
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final child answer" }],
          stopReason: "stop",
        },
      })}\n`,
  );
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.sent.length === 1, "completion notice was not sent");
  await waitFor(() => harness.closedTabs.length === 1, "owned tab was not closed");

  const delivery = harness.sent[0];
  assert.equal(delivery.message.customType, COMPLETION_MESSAGE_TYPE);
  assert.equal(delivery.message.details.sessionName, "auth-flow");
  assert.deepEqual(delivery.delivery, { deliverAs: "steer", triggerTurn: true });
  assert.equal(delivery.state.phase, "succeeded", "the result must be durable before notification");
  assert.deepEqual(delivery.closedTabs, [], "notification must precede cleanup");
  assert.deepEqual(harness.closedTabs, ["w1:t2"]);

  const collected = await harness.resultTool.execute(
    "collect", { run_id: launched.details.runId }, undefined, undefined, harness.ctx,
  );
  assert.equal(collected.content[0].text, "Final child answer");
  assert.equal(collected.details.phase, "succeeded");
  assert.equal(collected.details.sessionName, "auth-flow");
});

test("updates an existing launch row when the child session name becomes available", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const theme = {
    bold: (text) => text,
    fg: (_color, text) => text,
  };
  const context = {
    state: {},
    expanded: false,
    isError: false,
  };
  const input = { prompt: "Name this child" };
  const call = harness.agentTool.renderCall(input, theme, context);
  assert.equal(call.render(80)[0], "background_agent");

  const launched = await harness.agentTool.execute(
    "start",
    input,
    undefined,
    undefined,
    harness.ctx,
  );
  harness.agentTool.renderResult(launched, { expanded: false }, theme, context);
  await appendFile(
    harness.childPath(),
    `${JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
    })}\n` +
      `${JSON.stringify({ type: "session_info", name: "named-child" })}\n`,
  );
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "named child did not settle");

  assert.equal(call.render(80)[0], "background_agent named-child (openai/gpt-5.6-sol:xhigh)");
});

test("returns from a cold launch before Pi creates its lazy session file", async () => {
  const harness = await createHarness({
    sessionReadyAttempts: 0,
    exec: async ({ args, execOptions, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "start") {
        return ok({ agent: { name: HANDLE, agent: "pi", agent_status: "idle" } });
      }
      return defaultExec(args, execOptions);
    },
  });
  tempDirs.push(harness.dir);

  const launched = await harness.agentTool.execute(
    "start", { prompt: "Create the session" }, undefined, undefined, harness.ctx,
  );
  assert.equal(launched.details.phase, "running");
  assert.deepEqual(harness.calls.slice(0, 3).map((args) => args.slice(0, 2)), [
    ["tab", "create"],
    ["agent", "start"],
    ["agent", "prompt"],
  ]);
  assert.equal(harness.latestState().childSessionPath, undefined);

  const childPath = join(harness.dir, `lazy_${CHILD_ID}.jsonl`);
  await writeFile(
    childPath,
    `${JSON.stringify({ type: "session", version: 3, id: CHILD_ID, cwd: "/repo" })}\n` +
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Cold answer" }], stopReason: "stop" },
      })}\n`,
  );
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "cold run did not settle");
  assert.equal(harness.latestState().childSessionPath, childPath);
  assert.equal(harness.latestState().childRevision, (await stat(childPath)).size);
});

test("allows only settled follow-ups and resumes immutable session configuration", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const first = await harness.agentTool.execute("start", {
    prompt: "First task",
    model: "openai/gpt-5.6-luna",
    thinking: "low",
  }, undefined, undefined, harness.ctx);

  await assert.rejects(
    harness.agentTool.execute("overlap", { prompt: "Too soon", session: first.details.session }, undefined, undefined, harness.ctx),
    /already running|settle/i,
  );

  await appendFile(
    harness.childPath(),
    `${JSON.stringify({ type: "session_info", name: "reusable-child" })}\n` +
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "First answer" }], stopReason: "stop" },
      })}\n`,
  );
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "first run did not settle");
  assert.equal(harness.latestState().sessionName, "reusable-child");

  await assert.rejects(
    harness.agentTool.execute("bad-options", {
      prompt: "Continue", session: first.details.session, thinking: "max",
    }, undefined, undefined, harness.ctx),
    /thinking.*new.*session/i,
  );

  const followUp = await harness.agentTool.execute("follow-up", {
    prompt: "Compare that result",
    session: first.details.session,
  }, undefined, undefined, harness.ctx);
  assert.equal(followUp.details.session, first.details.session);
  assert.equal(followUp.details.sessionName, "reusable-child");
  assert.equal(followUp.details.runId, "run_0000000000000002");
  assert.notEqual(followUp.details.runId, first.details.runId);

  const resume = harness.calls.find((args, index) => index > 2 && args[0] === "agent" && args[1] === "start");
  assert.deepEqual(resume, [
    "agent", "start", HANDLE, "--kind", "pi", "--pane", "w1:p3", "--",
    "--session", harness.childPath(),
    "--model", "openai/gpt-5.6-luna", "--thinking", "low",
    "--tools", "read,bash", "--approve",
  ]);

  const callsBefore = harness.calls.length;
  const attempts = await Promise.allSettled([
    harness.agentTool.execute("race-a", { prompt: "A", session: HANDLE }, undefined, undefined, harness.ctx),
    harness.agentTool.execute("race-b", { prompt: "B", session: HANDLE }, undefined, undefined, harness.ctx),
  ]);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 2);
  assert.equal(harness.calls.length, callsBefore, "rejected overlaps must have no backend effects");
});

test("accepts a late session-name update without weakening revision checks", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const first = await harness.agentTool.execute(
    "start",
    { prompt: "Finish before naming" },
    undefined,
    undefined,
    harness.ctx,
  );
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "first run did not settle");

  await appendFile(
    harness.childPath(),
    `${JSON.stringify({ type: "session_info", name: "late-name" })}\n`,
  );
  const followUp = await harness.agentTool.execute(
    "follow-up",
    { prompt: "Continue", session: first.details.session },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.equal(followUp.details.sessionName, "late-name");
  assert.equal(harness.latestState().baselineBytes, (await stat(harness.childPath())).size);
});

test("rejects follow-ups when current parent trust differs from stored child trust", async () => {
  let trusted = true;
  const harness = await createHarness({ getTrusted: () => trusted });
  tempDirs.push(harness.dir);
  const first = await harness.agentTool.execute("start", { prompt: "First" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "first run did not settle");

  trusted = false;
  const callsBefore = harness.calls.length;
  await assert.rejects(
    harness.agentTool.execute(
      "follow-up", { prompt: "Continue", session: first.details.session }, undefined, undefined, harness.ctx,
    ),
    /trust.*changed|new.*session/i,
  );
  assert.equal(harness.calls.length, callsBefore);
});

test("allows a branch to resume only the exact child transcript revision it observed", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const first = await harness.agentTool.execute("start", { prompt: "First" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "first run did not settle");
  assert.equal(harness.latestState().childRevision, (await stat(harness.childPath())).size);

  await appendFile(harness.childPath(), `${JSON.stringify({ type: "custom", data: { otherBranch: true } })}\n`);
  const callsBefore = harness.calls.length;
  await assert.rejects(
    harness.agentTool.execute(
      "follow-up", { prompt: "Cross branch", session: first.details.session }, undefined, undefined, harness.ctx,
    ),
    /transcript.*changed|revision|new.*session/i,
  );
  assert.equal(harness.calls.length, callsBefore);
});

test("places every run in the parent runtime's current workspace", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const first = await harness.agentTool.execute("start", { prompt: "First" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "first run did not settle");

  harness.env.HERDR_WORKSPACE_ID = "w2";
  const followUp = await harness.agentTool.execute(
    "follow-up", { prompt: "Next", session: first.details.session }, undefined, undefined, harness.ctx,
  );
  assert.equal(followUp.details.phase, "running");
  const creates = harness.calls.filter((args) => args[0] === "tab" && args[1] === "create");
  assert.equal(creates.at(-1)[creates.at(-1).indexOf("--workspace") + 1], "w2");
  assert.equal(harness.latestState().workspaceId, "w2");
  assert.match(harness.latestState().tabId, /^w2:/);
});

test("keeps a lifecycle-settled transcript failure safely reusable", async () => {
  const harness = await createHarness({ transcriptAttempts: 1 });
  tempDirs.push(harness.dir);
  const first = await harness.agentTool.execute("start", { prompt: "Fail cleanly" }, undefined, undefined, harness.ctx);
  await appendFile(
    harness.childPath(),
    `${JSON.stringify({ type: "session_info", name: "failed-child" })}\n` +
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" },
      })}\n`,
  );
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "failed", "failed reply did not settle");
  await waitFor(() => harness.sent.length === 1, "failed reply was not announced");
  assert.equal(harness.latestState().childRevision, (await stat(harness.childPath())).size);
  assert.equal(harness.latestState().sessionName, "failed-child");
  assert.equal(harness.sent[0].message.details.sessionName, "failed-child");
  const theme = { bold: (text) => text, fg: (_color, text) => text };
  const resultCall = harness.resultTool.renderCall(
    { run_id: first.details.runId },
    theme,
    { state: {}, expanded: false },
  );
  assert.deepEqual(resultCall.render(80), [
    "background_agent_result failed-child (openai/gpt-5.6-sol:xhigh)",
  ]);
  const followUpCall = harness.agentTool.renderCall(
    { prompt: "Try again", session: first.details.session },
    theme,
    { state: {}, expanded: false },
  );
  assert.equal(followUpCall.render(80)[0],
    "background_agent failed-child (openai/gpt-5.6-sol:xhigh)");
  await assert.rejects(
    harness.resultTool.execute("result", { run_id: first.details.runId }, undefined, undefined, harness.ctx),
    /provider failed/i,
  );

  const followUp = await harness.agentTool.execute(
    "follow-up", { prompt: "Try again", session: first.details.session }, undefined, undefined, harness.ctx,
  );
  assert.equal(followUp.details.phase, "running");
  assert.equal(followUp.details.sessionName, "failed-child");
});

test("clears stale revisions when a later lifecycle failure is not safely resumable", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const first = await harness.agentTool.execute("start", { prompt: "First" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "first run did not settle");

  await harness.agentTool.execute(
    "follow-up", { prompt: "Block", session: first.details.session }, undefined, undefined, harness.ctx,
  );
  harness.prompts[1].resolve(ok({ agent: { agent_status: "blocked" } }));
  await waitFor(() => harness.latestState().phase === "failed", "blocked follow-up did not fail");
  assert.equal(harness.latestState().childRevision, undefined);
  await assert.rejects(
    harness.agentTool.execute(
      "third", { prompt: "Unsafe retry", session: first.details.session }, undefined, undefined, harness.ctx,
    ),
    /not safely resumable|new.*session/i,
  );
});

test("does not relaunch a settled session until prior tab cleanup finishes", async () => {
  const close = deferred();
  let closeCalls = 0;
  const harness = await createHarness({
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "tab" && args[1] === "close" && closeCalls++ === 0) return close.promise;
      return defaultExec(args);
    },
  });
  tempDirs.push(harness.dir);
  const first = await harness.agentTool.execute("start", { prompt: "First" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.sent.length === 1, "completion was not announced");

  const followUp = harness.agentTool.execute(
    "follow-up", { prompt: "Next", session: first.details.session }, undefined, undefined, harness.ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    harness.calls.filter((args) => args[0] === "tab" && args[1] === "create").length,
    1,
    "follow-up must wait for prior cleanup",
  );

  close.resolve(ok({ type: "ok" }));
  await followUp;
  assert.equal(harness.calls.filter((args) => args[0] === "tab" && args[1] === "create").length, 2);
});

test("serializes simultaneous follow-ups so exactly one starts", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const first = await harness.agentTool.execute("start", { prompt: "First" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "first run did not settle");

  const attempts = await Promise.allSettled([
    harness.agentTool.execute("race-a", { prompt: "A", session: first.details.session }, undefined, undefined, harness.ctx),
    harness.agentTool.execute("race-b", { prompt: "B", session: first.details.session }, undefined, undefined, harness.ctx),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  assert.match(attempts.find((result) => result.status === "rejected").reason.message, /already running|settle/i);
  assert.equal(harness.calls.filter((args) => args[0] === "agent" && args[1] === "prompt").length, 2);
});

test("keeps concurrent sessions independent", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const [first, second] = await Promise.all([
    harness.agentTool.execute("one", { prompt: "One" }, undefined, undefined, harness.ctx),
    harness.agentTool.execute("two", { prompt: "Two" }, undefined, undefined, harness.ctx),
  ]);

  assert.notEqual(first.details.session, second.details.session);
  assert.notEqual(first.details.runId, second.details.runId);
  assert.equal(harness.prompts.length, 2);
  assert.equal(harness.stateEntries().filter((entry) => entry.data.phase === "running").length, 2);
  assert.equal(harness.sent.length, 0);
});

test("notifies exactly once for each concurrent live completion while the parent is active", async () => {
  let parentActive = true;
  const deliveredWhileActive = [];
  const harness = await createHarness({
    onSendMessage: (notification) => deliveredWhileActive.push({ notification, parentActive }),
  });
  tempDirs.push(harness.dir);
  const [first, second] = await Promise.all([
    harness.agentTool.execute("one", { prompt: "One" }, undefined, undefined, harness.ctx),
    harness.agentTool.execute("two", { prompt: "Two" }, undefined, undefined, harness.ctx),
  ]);
  for (const [run, answer] of [[first, "First"], [second, "Second"]]) {
    await appendFile(harness.childPath(run.details.session), `${JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" },
    })}\n`);
  }
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  harness.prompts[1].resolve(ok({ agent: { agent_status: "done" } }));
  await waitFor(() => harness.sent.length === 2, "both completion notices were not sent");
  parentActive = false;

  for (const run of [first, second]) {
    assert.equal(
      harness.sent.filter((item) => item.message.details.runId === run.details.runId).length,
      1,
      `run ${run.details.runId} must notify exactly once`,
    );
  }
  assert.ok(deliveredWhileActive.every((item) => item.parentActive));
});

test("bounds model-selection and unknown-identifier errors", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  harness.ctx.scopedModels = Array.from({ length: 1000 }, (_, index) => ({
    model: { provider: "provider", id: `model-${index}-${"x".repeat(100)}` },
  }));
  const invalidModel = `provider/${"y".repeat(100_000)}`;
  await assert.rejects(
    harness.agentTool.execute(
      "model", { prompt: "Work", model: invalidModel }, undefined, undefined, harness.ctx,
    ),
    (error) => Buffer.byteLength(error.message) < 4096 && !error.message.includes("y".repeat(1000)),
  );
  await assert.rejects(
    harness.resultTool.execute(
      "result", { run_id: `run_${"f".repeat(100_000)}` }, undefined, undefined, harness.ctx,
    ),
    (error) => Buffer.byteLength(error.message) < 1024,
  );
  await assert.rejects(
    harness.agentTool.execute(
      "follow-up", { prompt: "Work", session: `sub_${"f".repeat(100_000)}` }, undefined, undefined, harness.ctx,
    ),
    (error) => Buffer.byteLength(error.message) < 1024,
  );
});

test("uses the exact generated run ID shape in the result schema", () => {
  const tools = [];
  installBackgroundAgent({ registerTool: (tool) => tools.push(tool), on() {} }, { agent: {} }, {
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
    outputLimits: { maxBytes: 50 * 1024, maxLines: 2000 },
    truncateOutput,
  });
  assert.equal(
    tools.find((tool) => tool.name === BACKGROUND_AGENT_RESULT_TOOL_NAME)
      .parameters.properties.run_id.pattern,
    "^run_[a-f0-9]{16}$",
  );
});

test("keeps live notification entitlement across a same-branch tree rebind", async () => {
  let recoveryWait;
  const harness = await createHarness({
    exec: async ({ args, execOptions, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        return ok({ agent: {
          name: HANDLE,
          agent: "pi",
          agent_status: "working",
          pane_id: "w1:p2",
          tab_id: "w1:t2",
          workspace_id: "w1",
          agent_session: { kind: "path", value: harness.childPath() },
        } });
      }
      if (args[0] === "agent" && args[1] === "wait") {
        recoveryWait = { ...deferred(), signal: execOptions?.signal };
        return recoveryWait.promise;
      }
      return defaultExec(args, execOptions);
    },
  });
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute(
    "start", { prompt: "Stay live across tree navigation" }, undefined, undefined, harness.ctx,
  );

  await harness.handlers.get("session_tree")({ oldLeafId: "old", newLeafId: "same-branch" }, harness.ctx);
  assert.equal(harness.prompts[0].signal.aborted, true, "tree rebind should replace the original waiter");
  await waitFor(() => recoveryWait !== undefined, "same-branch monitor did not reattach");
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Rebound answer" }], stopReason: "stop" },
  })}\n`);
  recoveryWait.resolve(ok({ agent: { agent_status: "done" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "rebound run did not settle");
  await waitFor(() => harness.sent.length === 1, "rebound live run did not notify");
  assert.equal(harness.sent[0].message.details.runId, launched.details.runId);
});

test("bounds persisted and returned child output", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute(
    "start", { prompt: "Return a large result" }, undefined, undefined, harness.ctx,
  );
  const fullAnswer = Array.from({ length: 3000 }, (_, index) => `result line ${index.toString().padStart(4, "0")} ${"x".repeat(24)}`).join("\n");
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: fullAnswer }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "large result did not settle");

  const persisted = harness.latestState().result;
  assert.ok(Buffer.byteLength(persisted) <= 50 * 1024, "persisted result exceeded the byte budget");
  assert.ok(persisted.split("\n").length <= 2000, "persisted result exceeded the line budget");
  assert.match(persisted, /Output truncated/i);
  assert.match(persisted, new RegExp(harness.basename(harness.childPath()).replaceAll(".", "\\.")));

  const result = await harness.resultTool.execute(
    "collect", { run_id: launched.details.runId }, undefined, undefined, harness.ctx,
  );
  assert.equal(result.content[0].text, persisted);
});
