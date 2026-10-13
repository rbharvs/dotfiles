import assert from "node:assert/strict";
import { appendFile, rm } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { BACKGROUND_AGENT_RESULT_TOOL_NAME, STATE_ENTRY_TYPE } from "../core.ts";
import { HANDLE, createHarness, deferred, herdrError, ok, waitFor } from "./harness.mjs";

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("records launch failure and rolls back only the tab it created", async () => {
  const harness = await createHarness({
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "start") {
        return herdrError("agent_start_failed", "Pi failed to start");
      }
      return defaultExec(args);
    },
  });
  tempDirs.push(harness.dir);

  await assert.rejects(
    harness.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, harness.ctx),
    /Pi failed to start/,
  );

  assert.equal(harness.latestState().phase, "failed");
  assert.match(harness.latestState().error, /Pi failed to start/);
  assert.deepEqual(harness.closedTabs, ["w1:t2"]);
  assert.equal(harness.sent.length, 0, "a synchronous tool error must not also inject a completion");
  assert.equal(harness.calls.some((args) => args[0] === "agent" && args[1] === "prompt"), false);
});

test("fails safely after settlement when the expected Pi session never appears", async () => {
  const harness = await createHarness({
    sessionReadyAttempts: 0,
    transcriptAttempts: 1,
    exec: async ({ args, execOptions, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "start") {
        return ok({ agent: { name: HANDLE, agent: "pi", agent_status: "idle" } });
      }
      return defaultExec(args, execOptions);
    },
  });
  tempDirs.push(harness.dir);

  const launched = await harness.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, harness.ctx);
  assert.equal(launched.details.phase, "running");
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "failed", "missing transcript did not fail");
  assert.deepEqual(harness.closedTabs, ["w1:t2"]);
  await assert.rejects(
    harness.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx),
    /did not attach the expected Pi session/,
  );
});

test("turns asynchronous backend and transcript failures into collectible run errors", async () => {
  const backend = await createHarness({
    transcriptAttempts: 1,
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "prompt") {
        return herdrError("agent_wait_failed", "wait failed");
      }
      return defaultExec(args);
    },
  });
  tempDirs.push(backend.dir);
  const launched = await backend.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, backend.ctx);
  await waitFor(() => backend.latestState().phase === "failed", "backend failure did not settle");
  assert.equal(backend.sent.length, 1);
  await assert.rejects(
    backend.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, backend.ctx),
    /wait failed/,
  );

  const transcript = await createHarness({ transcriptAttempts: 1 });
  tempDirs.push(transcript.dir);
  const second = await transcript.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, transcript.ctx);
  transcript.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => transcript.latestState().phase === "failed", "missing transcript result did not settle");
  await assert.rejects(
    transcript.resultTool.execute("result", { run_id: second.details.runId }, undefined, undefined, transcript.ctx),
    /without a new final assistant reply/,
  );
});

test("never promotes a live lifecycle failure from a final-looking transcript", async () => {
  const harness = await createHarness({ transcriptAttempts: 1 });
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Looks final" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(herdrError("agent_wait_failed", "wait failed authoritatively"));
  await waitFor(() => harness.latestState().phase === "failed", "lifecycle failure did not settle");
  await assert.rejects(
    harness.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx),
    /wait failed authoritatively/i,
  );
});

test("stabilizes one unknown live status and then fails if it remains unclassifiable", async () => {
  let gets = 0;
  const harness = await createHarness({
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        gets += 1;
        return ok({ agent: { name: HANDLE, agent: "pi", agent_status: "unknown" } });
      }
      return defaultExec(args);
    },
  });
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, harness.ctx);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "unknown" } }));
  await waitFor(() => harness.latestState().phase === "failed", "unknown child did not fail");
  assert.equal(gets, 1, "unknown status should receive exactly one fresh stabilization lookup");
  await assert.rejects(
    harness.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx),
    /unknown|unclassifiable/i,
  );
});

test("accepts idle after one unknown-status stabilization check", async () => {
  let gets = 0;
  const harness = await createHarness({
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        gets += 1;
        return ok({ agent: { name: HANDLE, agent: "pi", agent_status: "idle" } });
      }
      return defaultExec(args);
    },
  });
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Settled" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "unknown" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "stabilized child did not succeed");
  assert.equal(gets, 1);
  const result = await harness.resultTool.execute(
    "result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx,
  );
  assert.equal(result.content[0].text, "Settled");
});

test("resumes one lifecycle wait when unknown stabilizes back to working", async () => {
  let gets = 0;
  let waits = 0;
  let waitArgs;
  const harness = await createHarness({
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        gets += 1;
        return ok({ agent: { name: HANDLE, agent: "pi", agent_status: "working" } });
      }
      if (args[0] === "agent" && args[1] === "wait") {
        waits += 1;
        waitArgs = args;
        return ok({ agent: { name: HANDLE, agent: "pi", agent_status: "done" } });
      }
      return defaultExec(args);
    },
  });
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, harness.ctx);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Eventually done" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "unknown" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "working child did not resume its wait");
  assert.equal(gets, 1);
  assert.equal(waits, 1);
  assert.deepEqual(waitArgs, [
    "agent", "wait", HANDLE,
    "--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown",
  ]);
  const result = await harness.resultTool.execute(
    "result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx,
  );
  assert.equal(result.content[0].text, "Eventually done");
});

test("allows one post-stabilization wait for working to unknown to working recovery", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute("start", { prompt: "Recover through unknown" }, undefined, undefined, first.ctx);
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);
  await appendFile(first.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Recovered after stabilization" }], stopReason: "stop" },
  })}\n`);

  let gets = 0;
  let waits = 0;
  const lifecycle = [];
  const waitArgs = [];
  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        gets += 1;
        lifecycle.push(`get:working:after-${waits}-waits`);
        return ok({ agent: {
          name: HANDLE,
          agent: "pi",
          agent_status: "working",
          pane_id: "w1:p2",
          tab_id: "w1:t2",
          workspace_id: "w1",
          agent_session: { kind: "path", value: first.childPath() },
        } });
      }
      if (args[0] === "agent" && args[1] === "wait") {
        waits += 1;
        waitArgs.push([...args]);
        const status = waits === 1 ? "unknown" : "done";
        lifecycle.push(`wait:${status}`);
        return ok({ agent: {
          name: HANDLE,
          agent: "pi",
          agent_status: status,
        } });
      }
      return defaultExec(args);
    },
  });
  await waitFor(() => second.latestState().phase !== "running", "recovery did not reach a terminal state");
  await waitFor(() => gets === 3, "recovered cleanup did not perform its ownership lookup");

  assert.equal(second.latestState().phase, "succeeded");
  assert.deepEqual(lifecycle.slice(0, 4), [
    "get:working:after-0-waits",
    "wait:unknown",
    "get:working:after-1-waits",
    "wait:done",
  ]);
  assert.equal(gets, 3, "the third lookup is the separate recovered-cleanup ownership proof");
  assert.equal(waits, 2, "recovery should use one initial wait and one post-stabilization wait");
  for (const args of waitArgs) {
    assert.deepEqual(args, [
      "agent", "wait", HANDLE,
      "--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown",
    ]);
  }
  const result = await second.resultTool.execute(
    "result", { run_id: launched.details.runId }, undefined, undefined, second.ctx,
  );
  assert.equal(result.content[0].text, "Recovered after stabilization");
});

test("bounds a working-to-unknown recovery transition", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, first.ctx);
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);

  let gets = 0;
  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        gets += 1;
        return ok({ agent: {
          name: HANDLE, agent: "pi", agent_status: gets === 1 ? "working" : "unknown",
          pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1",
        } });
      }
      if (args[0] === "agent" && args[1] === "wait") {
        return ok({ agent: { name: HANDLE, agent: "pi", agent_status: "unknown" } });
      }
      return defaultExec(args);
    },
  });
  await waitFor(() => second.latestState().phase === "failed", "unknown recovery did not fail");
  assert.equal(gets, 2, "recovery should perform only one stabilization lookup");
  await assert.rejects(
    second.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, second.ctx),
    /unknown|unclassifiable/i,
  );
});

test("bounds failed child output before returning it to Pi", async () => {
  const harness = await createHarness({ transcriptAttempts: 1 });
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute(
    "start", { prompt: "Fail at length" }, undefined, undefined, harness.ctx,
  );
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "x".repeat(70 * 1024) },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "failed", "large child error did not settle");

  assert.ok(Buffer.byteLength(harness.latestState().error) <= 50 * 1024);
  assert.match(harness.latestState().error, /truncated/i);
  await assert.rejects(
    harness.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx),
    (error) => Buffer.byteLength(error.message) <= 50 * 1024 && /truncated/i.test(error.message),
  );
});

test("treats a newly launched child becoming blocked as terminal failure", async () => {
  const harness = await createHarness();
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute(
    "start", { prompt: "May block" }, undefined, undefined, harness.ctx,
  );
  harness.prompts[0].resolve(ok({ agent: { agent_status: "blocked" } }));
  await waitFor(() => harness.latestState().phase === "failed", "blocked child did not settle");
  await assert.rejects(
    harness.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx),
    /blocked/i,
  );
});

test("retries transient shell readiness without duplicating the tab", async () => {
  let starts = 0;
  const harness = await createHarness({
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "start" && starts++ === 0) {
        return herdrError("agent_pane_busy", "not an available shell");
      }
      return defaultExec(args);
    },
  });
  tempDirs.push(harness.dir);

  await harness.agentTool.execute("start", { prompt: "Work" }, undefined, undefined, harness.ctx);
  assert.equal(harness.calls.filter((args) => args[0] === "tab" && args[1] === "create").length, 1);
  assert.equal(harness.calls.filter((args) => args[0] === "agent" && args[1] === "start").length, 2);
});

test("recovers a settled run silently and does not replay its prompt", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute(
    "start", { prompt: "Recover me" }, undefined, undefined, first.ctx,
  );
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);
  await appendFile(first.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }], stopReason: "stop" },
  })}\n`);

  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        return ok({ agent: {
          name: HANDLE, agent: "pi", agent_status: "idle",
          pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1",
        } });
      }
      return defaultExec(args);
    },
  });
  await waitFor(() => second.latestState().phase === "succeeded", "recovery did not persist the result");

  assert.equal(second.sent.length, 0, "recovery must not wake the parent");
  assert.equal(second.calls.some((args) => args[0] === "agent" && args[1] === "prompt"), false);
  const result = await second.resultTool.execute(
    "result", { run_id: launched.details.runId }, undefined, undefined, second.ctx,
  );
  assert.equal(result.content[0].text, "Recovered answer");
});

test("does not close a recovered tab without fresh complete ownership proof", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  await first.agentTool.execute("start", { prompt: "Recover me" }, undefined, undefined, first.ctx);
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);
  await appendFile(first.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Recovered" }], stopReason: "stop" },
  })}\n`);

  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        return ok({ agent: { name: HANDLE, agent: "pi", agent_status: "idle" } });
      }
      return defaultExec(args);
    },
  });
  await waitFor(() => second.latestState().phase === "succeeded", "recovery did not settle");
  assert.deepEqual(second.closedTabs, []);
});

test("closes a recovered tab only after a fresh lookup proves full ownership", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  await first.agentTool.execute("start", { prompt: "Recover me" }, undefined, undefined, first.ctx);
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);
  await appendFile(first.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Recovered" }], stopReason: "stop" },
  })}\n`);

  let gets = 0;
  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        gets += 1;
        return ok({ agent: {
          name: HANDLE,
          agent: "pi",
          agent_status: "idle",
          pane_id: "w1:p2",
          tab_id: "w1:t2",
          workspace_id: "w1",
          agent_session: { kind: "path", value: first.childPath() },
        } });
      }
      return defaultExec(args);
    },
  });
  await waitFor(() => second.closedTabs.length === 1, "proved recovered tab was not closed");
  assert.ok(gets >= 2, "cleanup requires a lookup fresh from the lifecycle observation");
  assert.deepEqual(second.closedTabs, ["w1:t2"]);
});

test("reattaches to a live child without prompting it again", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute("start", { prompt: "Keep working" }, undefined, undefined, first.ctx);
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);

  let settleWait;
  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async ({ args, execOptions, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        return ok({ agent: {
          name: HANDLE, agent: "pi", agent_status: "working",
          pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1",
        } });
      }
      if (args[0] === "agent" && args[1] === "wait") {
        settleWait = { ...deferred(), signal: execOptions?.signal };
        return settleWait.promise;
      }
      return defaultExec(args, execOptions);
    },
  });
  await waitFor(() => settleWait !== undefined, "recovery waiter did not attach");
  await appendFile(first.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Live recovery" }], stopReason: "stop" },
  })}\n`);
  settleWait.resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => second.latestState().phase === "succeeded", "live recovery did not settle");

  assert.equal(second.calls.some((args) => args[0] === "agent" && args[1] === "prompt"), false);
  assert.equal(second.sent.length, 0);
  const result = await second.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, second.ctx);
  assert.equal(result.content[0].text, "Live recovery");
});

test("marks a missing active child failed instead of relaunching or replaying", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute(
    "start", { prompt: "Do not replay" }, undefined, undefined, first.ctx,
  );
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);

  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        return herdrError("agent_not_found", "agent not found");
      }
      return defaultExec(args);
    },
  });
  await waitFor(() => second.latestState().phase === "failed", "missing child was not failed");

  assert.equal(second.calls.some((args) => args[0] === "agent" && ["start", "prompt"].includes(args[1])), false);
  assert.equal(second.sent.length, 0);
  await assert.rejects(
    second.resultTool.execute(
      "result", { run_id: launched.details.runId }, undefined, undefined, second.ctx,
    ),
    /agent not found|final assistant reply/i,
  );
});

test("agent_not_found remains a lifecycle failure even with a final-looking transcript", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute("start", { prompt: "Do not infer success" }, undefined, undefined, first.ctx);
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);
  await appendFile(first.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Looks complete" }], stopReason: "stop" },
  })}\n`);

  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async ({ args, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        return herdrError("agent_not_found", "agent definitely missing");
      }
      return defaultExec(args);
    },
  });
  await waitFor(() => second.latestState().phase === "failed", "missing agent did not fail");
  await assert.rejects(
    second.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, second.ctx),
    /agent definitely missing/i,
  );
});

test("ignores state outside the active parent branch", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute(
    "start", { prompt: "Inactive" }, undefined, undefined, first.ctx,
  );
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);

  const second = await createHarness({ dir: first.dir, entries: first.entries, branchEntries: [] });
  await assert.rejects(
    second.tools.get(BACKGROUND_AGENT_RESULT_TOOL_NAME).execute(
      "result", { run_id: launched.details.runId }, undefined, undefined, second.ctx,
    ),
    /unknown background-agent run/i,
  );
  assert.equal(second.calls.length, 0);
});

test("rebinds state when tree navigation changes the active branch", async () => {
  const entries = [];
  let branch = entries;
  const harness = await createHarness({ entries, getBranch: () => branch });
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute(
    "start", { prompt: "Branch-local work" }, undefined, undefined, harness.ctx,
  );
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Branch answer" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => harness.latestState().phase === "succeeded", "branch run did not settle");

  branch = [];
  assert.ok(harness.handlers.has("session_tree"), "tree navigation must rebind extension state");
  await harness.handlers.get("session_tree")({ oldLeafId: "old", newLeafId: "other" }, harness.ctx);
  await assert.rejects(
    harness.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx),
    /unknown background-agent run/i,
  );
  await assert.rejects(
    harness.agentTool.execute(
      "follow-up", { prompt: "Cross the branch", session: launched.details.session }, undefined, undefined, harness.ctx,
    ),
    /unknown background-agent session/i,
  );

  branch = entries;
  await harness.handlers.get("session_tree")({ oldLeafId: "other", newLeafId: "old" }, harness.ctx);
  const restored = await harness.resultTool.execute(
    "result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx,
  );
  assert.equal(restored.content[0].text, "Branch answer");
});

test("keeps active monitors bound to their parent branch", async () => {
  const entries = [];
  let branch = entries;
  const harness = await createHarness({
    entries,
    getBranch: () => branch,
    exec: async ({ args, execOptions, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        return ok({ agent: {
          name: HANDLE, agent: "pi", agent_status: "idle",
          pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1",
        } });
      }
      return defaultExec(args, execOptions);
    },
  });
  tempDirs.push(harness.dir);
  const launched = await harness.agentTool.execute(
    "start", { prompt: "Finish on this branch" }, undefined, undefined, harness.ctx,
  );

  branch = [];
  await harness.handlers.get("session_tree")({ oldLeafId: "old", newLeafId: "other" }, harness.ctx);
  assert.equal(harness.prompts[0].signal.aborted, true);
  await appendFile(harness.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Late branch answer" }], stopReason: "stop" },
  })}\n`);
  harness.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.sent.length, 0, "an abandoned branch must not receive completion");
  await assert.rejects(
    harness.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx),
    /unknown background-agent run/i,
  );

  branch = entries;
  await harness.handlers.get("session_tree")({ oldLeafId: "other", newLeafId: "old" }, harness.ctx);
  await waitFor(() => harness.latestState().phase === "succeeded", "returning branch did not recover");
  const result = await harness.resultTool.execute(
    "result", { run_id: launched.details.runId }, undefined, undefined, harness.ctx,
  );
  assert.equal(result.content[0].text, "Late branch answer");
});

test("treats a child becoming blocked while recovering as terminal failure", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute(
    "start", { prompt: "May block" }, undefined, undefined, first.ctx,
  );
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);

  let settleWait;
  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async ({ args, execOptions, defaultExec }) => {
      if (args[0] === "agent" && args[1] === "get") {
        return ok({ agent: {
          name: HANDLE, agent: "pi", agent_status: "working",
          pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1",
        } });
      }
      if (args[0] === "agent" && args[1] === "wait") {
        settleWait = { ...deferred(), args, signal: execOptions?.signal };
        return settleWait.promise;
      }
      return defaultExec(args, execOptions);
    },
  });
  await waitFor(() => settleWait !== undefined, "recovery waiter did not attach");
  assert.deepEqual(settleWait.args, [
    "agent", "wait", HANDLE, "--until", "idle", "--until", "done", "--until", "blocked",
    "--until", "unknown",
  ]);
  settleWait.resolve(ok({ agent: { agent_status: "blocked" } }));
  await waitFor(() => second.latestState().phase === "failed", "blocked child did not settle");
  await assert.rejects(
    second.resultTool.execute("result", { run_id: launched.details.runId }, undefined, undefined, second.ctx),
    /blocked/i,
  );
});

test("bounds results recovered from older parent state", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute(
    "start", { prompt: "Persist me" }, undefined, undefined, first.ctx,
  );
  await appendFile(first.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Original" }], stopReason: "stop" },
  })}\n`);
  first.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => first.latestState().phase === "succeeded", "first run did not settle");
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);
  const terminal = first.entries.findLast(
    (entry) => entry.customType === STATE_ENTRY_TYPE && entry.data.runId === launched.details.runId && entry.data.phase === "succeeded",
  );
  terminal.data.result = Array.from({ length: 3000 }, (_, index) => `legacy line ${index} ${"x".repeat(24)}`).join("\n");

  const second = await createHarness({ dir: first.dir, entries: first.entries });
  const result = await second.resultTool.execute(
    "result", { run_id: launched.details.runId }, undefined, undefined, second.ctx,
  );
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
  assert.ok(result.content[0].text.split("\n").length <= 2000);
  assert.match(result.content[0].text, /truncated/i);
});

test("keeps legacy terminal results collectible but fails follow-up closed without a revision", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute("start", { prompt: "Legacy" }, undefined, undefined, first.ctx);
  await appendFile(first.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Legacy answer" }], stopReason: "stop" },
  })}\n`);
  first.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => first.latestState().phase === "succeeded", "run did not settle");
  await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);
  for (const entry of first.entries) {
    if (entry.customType === STATE_ENTRY_TYPE && entry.data?.runId === launched.details.runId) {
      delete entry.data.childRevision;
    }
  }

  const second = await createHarness({ dir: first.dir, entries: first.entries });
  const result = await second.resultTool.execute(
    "result", { run_id: launched.details.runId }, undefined, undefined, second.ctx,
  );
  assert.equal(result.content[0].text, "Legacy answer");
  await assert.rejects(
    second.agentTool.execute(
      "follow-up", { prompt: "Continue", session: launched.details.session }, undefined, undefined, second.ctx,
    ),
    /no resumable.*revision|new.*session/i,
  );
});

test("duplicate terminal recovery is idempotent", async () => {
  const first = await createHarness();
  tempDirs.push(first.dir);
  const launched = await first.agentTool.execute("start", { prompt: "Once" }, undefined, undefined, first.ctx);
  await appendFile(first.childPath(), `${JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Once only" }], stopReason: "stop" },
  })}\n`);
  first.prompts[0].resolve(ok({ agent: { agent_status: "idle" } }));
  await waitFor(() => first.latestState().phase === "succeeded", "run did not complete");
  const terminalCount = first.entries.filter(
    (entry) => entry.customType === STATE_ENTRY_TYPE && entry.data.runId === launched.details.runId && entry.data.phase === "succeeded",
  ).length;

  const second = await createHarness({
    dir: first.dir,
    entries: first.entries,
    exec: async () => { throw new Error("terminal state must not touch Herdr"); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(second.entries.filter(
    (entry) => entry.customType === STATE_ENTRY_TYPE && entry.data.runId === launched.details.runId && entry.data.phase === "succeeded",
  ).length, terminalCount);
  assert.equal(second.calls.length, 0);
});
