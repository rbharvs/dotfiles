import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { installSessionNaming } from "../core.ts";
import {
  MAX_SESSION_NAME_LENGTH,
  fallbackSessionName,
  isValidSessionName,
  normalizeSessionName,
} from "../session-naming.ts";

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("condition was not met"));
      setTimeout(check, 5);
    };
    check();
  });
}

function textMessage(role, text) {
  return { role, content: [{ type: "text", text }] };
}

function createHarness({
  initialName,
  generated = "herdr-naming",
  modelAvailable = true,
  streamError,
  response,
  messages = [],
  branchEntries = [],
  allEntries = branchEntries,
  header = { timestamp: "2026-08-09T16:00:00.000Z" },
  execute = () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
  env = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_TAB_ID: "w1:t1",
  },
} = {}) {
  const handlers = new Map();
  const calls = [];
  const streamContexts = [];
  const streamOptions = [];
  let name = initialName;
  let modelCalls = 0;
  let ctx;

  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    getSessionName() { return name; },
    setSessionName(next) {
      name = next;
      void handlers.get("session_info_changed")?.({ name: next }, ctx);
    },
    exec(command, args) {
      calls.push([command, ...args]);
      return execute(command, args);
    },
  };

  ctx = {
    cwd: "/repo/example-project",
    sessionManager: {
      buildSessionProjection: () => ({ messages }),
      getBranch: () => branchEntries,
      getEntries: () => allEntries,
      getHeader: () => header,
    },
    modelRegistry: {
      find: () => modelAvailable ? { provider: "openai", id: "gpt-5.6-luna" } : undefined,
      streamSimple(_model, context, options) {
        modelCalls += 1;
        streamContexts.push(context);
        streamOptions.push(options);
        return {
          result: async () => {
            if (streamError) throw streamError;
            return response ? await response : { content: [{ type: "text", text: generated }] };
          },
        };
      },
    },
  };

  installSessionNaming(pi, {
    env,
    serializeContext: (contextMessages) => JSON.stringify(contextMessages),
  });

  return {
    handlers,
    setName: (value) => pi.setSessionName(value),
    calls,
    streamContexts,
    streamOptions,
    ctx,
    env,
    get name() { return name; },
    get modelCalls() { return modelCalls; },
  };
}

test("normalizes model names without removing semantic prefixes or counters", () => {
  assert.equal(MAX_SESSION_NAME_LENGTH, 22);
  assert.equal(normalizeSessionName("research-herdr-naming"), "research-herdr-naming");
  assert.equal(normalizeSessionName("Phase 2 Review"), "phase-2-review");
  assert.equal(fallbackSessionName("Please investigate token refresh failures"), "token-refresh-failures");
  assert.equal(isValidSessionName("research-title"), true);
  assert.equal(isValidSessionName("phase-2-review"), true);
});

test("names an unnamed session from its first prompt and syncs all Herdr projections", async () => {
  const harness = createHarness();
  harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  harness.handlers.get("before_agent_start")({ messageType: "user", prompt: "Research naming extensions for Herdr" }, harness.ctx);

  await waitFor(() => harness.name === "herdr-naming");
  await waitFor(() => harness.calls.length >= 5);

  assert.equal(harness.modelCalls, 1);
  assert.equal(harness.streamOptions[0].reasoning, undefined);
  assert.equal(harness.streamOptions[0].maxTokens, 32);
  assert.deepEqual(harness.calls.find((call) => call[1] === "tab"), [
    "herdr", "tab", "rename", "w1:t1", "herdr-naming",
  ]);
  assert.deepEqual(harness.calls.find(
    (call) => call[1] === "pane" && call[2] === "rename" && call.includes("herdr-naming"),
  ), [
    "herdr", "pane", "rename", "w1:p1", "herdr-naming",
  ]);
  const metadata = harness.calls.find(
    (call) => call[1] === "pane" && call[2] === "report-metadata" && call.includes("--title"),
  );
  assert.ok(metadata.includes("--clear-display-agent"));
  assert.ok(metadata.includes("--title") && metadata.includes("herdr-naming"));
  assert.ok(metadata.includes("--token") && metadata.includes("session=herdr-naming"));
  assert.equal(metadata.includes("--display-agent"), false);
});

test("clears stale pane projections while a session is unnamed", async () => {
  const harness = createHarness();
  harness.handlers.get("session_start")({ reason: "new" }, harness.ctx);

  await waitFor(() => harness.calls.length === 2);
  assert.equal(harness.modelCalls, 0);
  assert.deepEqual(harness.calls.find((call) => call.includes("report-metadata")), [
    "herdr", "pane", "report-metadata", "w1:p1",
    "--source", "user:pi-session-name",
    "--agent", "pi",
    "--applies-to-source", "herdr:pi",
    "--clear-title",
    "--clear-display-agent",
    "--clear-token", "session",
    "--seq", harness.calls.find((call) => call.includes("report-metadata")).at(-1),
  ]);
  assert.deepEqual(harness.calls.find((call) => call[2] === "rename"), [
    "herdr", "pane", "rename", "w1:p1", "--clear",
  ]);
});

test("uses Pi's full compaction-aware branch context", async () => {
  const messages = [
    { role: "compactionSummary", summary: "Compaction summary: the sidebar must center semantic session names." },
    { role: "branchSummary", summary: "The workspace remains a muted second row." },
    { role: "toolResult", content: [{ type: "text", text: "Herdr supports $session metadata." }] },
    textMessage("user", "Apply this naming architecture."),
  ];
  const harness = createHarness({ messages, generated: "session-architecture" });
  harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

  await waitFor(() => harness.name === "session-architecture");
  const prompt = harness.streamContexts[0].messages[0].content[0].text;
  for (const expected of [
    "Compaction summary: the sidebar must center semantic session names.",
    "The workspace remains a muted second row.",
    "Herdr supports $session metadata.",
    "Apply this naming architecture.",
  ]) {
    assert.match(prompt, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("names the real active projection after compaction and context edits", async () => {
  const manager = SessionManager.inMemory("/repo/example-project");
  manager.appendMessage({ ...textMessage("user", "Discarded pre-compaction text"), timestamp: 1 });
  const kept = manager.appendMessage({ ...textMessage("user", "Outdated request"), timestamp: 2 });
  manager.appendCompaction("Current compacted goal", kept, 100);
  const edit = manager.appendContextEdit(kept, { content: "Updated naming request" });
  manager.appendMessage({ ...textMessage("user", "Unrelated abandoned branch"), timestamp: 3 });
  manager.branch(edit);
  const harness = createHarness({ env: {} });
  harness.ctx.sessionManager = {
    buildSessionProjection: () => manager.buildSessionProjection(),
    getEntries: () => manager.getEntries(),
    getHeader: () => manager.getHeader(),
  };
  harness.handlers.get("session_start")({ reason: "resume" }, harness.ctx);
  await waitFor(() => harness.name === "herdr-naming");
  const prompt = harness.streamContexts[0].messages[0].content[0].text;
  assert.match(prompt, /Current compacted goal/);
  assert.match(prompt, /Updated naming request/);
  assert.doesNotMatch(prompt, /Discarded pre-compaction text|Outdated request|Unrelated abandoned branch/);
});

test("uses effective summaries for deterministic fallback naming", async () => {
  const harness = createHarness({
    modelAvailable: false,
    messages: [{ role: "compactionSummary", summary: "Investigate durable naming" }],
  });
  harness.handlers.get("session_start")({ reason: "resume" }, harness.ctx);

  await waitFor(() => harness.name === "durable-naming");
  assert.equal(harness.modelCalls, 0);
});

test("freshens inherited names for built-in forks", async () => {
  const harness = createHarness({
    initialName: "source-session",
    generated: "forked-direction",
    messages: [textMessage("user", "Explore the forked direction")],
  });
  harness.handlers.get("session_start")({ reason: "fork" }, harness.ctx);

  await waitFor(() => harness.name === "forked-direction");
  assert.equal(harness.modelCalls, 1);
});

test("consumes a one-shot fresh-name launch signal", async () => {
  const env = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_TAB_ID: "w1:t1",
    PI_SESSION_NAMING_FRESH: "1",
  };
  const harness = createHarness({
    initialName: "source-session",
    generated: "delegated-delivery",
    messages: [textMessage("assistant", "Implement the agreed delegated delivery scope")],
    env,
  });
  harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

  await waitFor(() => harness.name === "delegated-delivery");
  assert.equal(harness.modelCalls, 1);
  assert.equal("PI_SESSION_NAMING_FRESH" in env, false);
});

test("does not repeat a sticky launch signal after the fork records its name", async () => {
  const env = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_TAB_ID: "w1:t1",
    PI_SESSION_NAMING_FRESH: "1",
  };
  const harness = createHarness({
    initialName: "delegated-delivery",
    messages: [textMessage("assistant", "Inherited delivery context")],
    branchEntries: [{
      type: "session_info",
      name: "delegated-delivery",
      timestamp: "2026-08-09T16:00:01.000Z",
    }],
    env,
  });
  harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

  await waitFor(() => harness.calls.length === 3);
  assert.equal(harness.name, "delegated-delivery");
  assert.equal(harness.modelCalls, 0);
  assert.equal("PI_SESSION_NAMING_FRESH" in env, false);
});

test("consumes a sticky signal when the applied name is off the active branch", async () => {
  const env = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_TAB_ID: "w1:t1",
    PI_SESSION_NAMING_FRESH: "1",
  };
  const appliedName = {
    type: "session_info",
    name: "delegated-name",
    timestamp: "2026-08-09T16:00:01.000Z",
  };
  const harness = createHarness({
    env,
    initialName: "delegated-name",
    messages: [textMessage("user", "Implement delegated naming")],
    branchEntries: [],
    allEntries: [appliedName],
  });

  harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  await waitFor(() => harness.calls.length === 3);

  assert.equal(harness.name, "delegated-name");
  assert.equal(harness.modelCalls, 0);
  assert.equal("PI_SESSION_NAMING_FRESH" in env, false);
});

test("waits for old Herdr projections during session shutdown", async () => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({ initialName: "old-name", execute: () => deferred });
  harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  await waitFor(() => harness.calls.length === 3);

  let settled = false;
  const shutdown = harness.handlers.get("session_shutdown")().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  release({ stdout: "", stderr: "", code: 0 });
  await shutdown;
  assert.equal(settled, true);
});

test("ignores persisted system prompts for fallback naming", async () => {
  const harness = createHarness({
    env: {}, modelAvailable: false,
    messages: [textMessage("system", "You are an expert coding assistant"),
      textMessage("user", "Investigate token refresh failures")],
  });
  harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  await waitFor(() => harness.name === "token-refresh-failures");
});

test("system-only history waits for a user prompt", async () => {
  const harness = createHarness({ env: {}, messages: [textMessage("system", "Harness instructions")] });
  harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  assert.equal(harness.modelCalls, 0);
  assert.equal(harness.name, undefined);
  harness.handlers.get("before_agent_start")({ messageType: "user", prompt: "Investigate naming" }, harness.ctx);
  await waitFor(() => harness.name === "herdr-naming");
  assert.doesNotMatch(harness.streamContexts[0].messages[0].content[0].text, /Harness instructions/);
});

test("custom-message runs name projected history without reading prompt", async () => {
  const harness = createHarness({ env: {}, messages: [textMessage("user", "Investigate naming")] });
  harness.handlers.get("before_agent_start")({
    messageType: "custom", message: { customType: "test", content: "done" },
    get prompt() { throw new Error("custom events have no prompt"); },
  }, harness.ctx);
  await waitFor(() => harness.name === "herdr-naming");
  assert.match(harness.streamContexts[0].messages[0].content[0].text, /Investigate naming/);
});

for (const failure of [{ streamError: new Error("fake provider failed") }, { generated: "" }]) {
  test(`uses fallback on ${failure.streamError ? "registry failure" : "empty response"}`, async () => {
    const harness = createHarness({ env: {}, ...failure,
      messages: [textMessage("user", "Investigate token refresh failures")] });
    harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    await waitFor(() => harness.name === "token-refresh-failures");
    assert.equal(harness.modelCalls, 1);
    assert.equal(harness.streamOptions[0].cacheRetention, "none");
    assert.equal("apiKey" in harness.streamOptions[0], false);
  });
}

for (const action of ["manual rename", "shutdown"]) {
  test(`does not apply a late response after ${action}`, async () => {
    let resolve;
    const response = new Promise((done) => { resolve = done; });
    const harness = createHarness({ env: {}, response,
      messages: [textMessage("user", "Investigate naming")] });
    harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    if (action === "manual rename") {
      // Use the same Pi setter used by the application to model a manual rename.
      harness.setName("manual-name");
    } else {
      await harness.handlers.get("session_shutdown")();
      assert.equal(harness.streamOptions[0].signal.aborted, true);
    }
    resolve({ content: [{ type: "text", text: "late-name" }] });
    await new Promise((done) => setImmediate(done));
    assert.equal(harness.name, action === "manual rename" ? "manual-name" : undefined);
  });
}

test("preserves and syncs a name supplied at startup", async () => {
  const harness = createHarness({ initialName: "auth-review" });
  harness.handlers.get("session_start")({ reason: "resume" }, harness.ctx);

  await waitFor(() => harness.calls.length === 3);
  assert.equal(harness.name, "auth-review");
  assert.equal(harness.modelCalls, 0);
});
