import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  BACKGROUND_AGENT_RESULT_TOOL_NAME,
  BACKGROUND_AGENT_TOOL_NAME,
  STATE_ENTRY_TYPE,
  installBackgroundAgent,
} from "../core.ts";

export const HANDLE = "sub_a1b2c3d4";
export const CHILD_ID = "11111111-1111-7111-8111-111111111111";
export const RUN_ID = "run_0000000000000001";

export function ok(result) {
  return { stdout: JSON.stringify({ id: "test", result }), stderr: "", code: 0, killed: false };
}

export function herdrError(code, message) {
  return {
    stdout: "",
    stderr: JSON.stringify({ error: { code, message } }),
    code: 1,
    killed: false,
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function truncateOutput(content, { maxBytes, maxLines }) {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const kept = [];
  let outputBytes = 0;
  for (const line of lines.slice(0, maxLines)) {
    const lineBytes = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) break;
    kept.push(line);
    outputBytes += lineBytes;
  }
  const totalBytes = Buffer.byteLength(content);
  const truncated = lines.length > kept.length || totalBytes > maxBytes;
  return {
    content: truncated ? kept.join("\n") : content,
    truncated,
    totalLines: lines.length,
    totalBytes,
  };
}

export async function waitFor(predicate, message) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function createHarness(options = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), "background-agent-test-"));
  const parentPath = join(dir, "outer.jsonl");
  await writeFile(parentPath, "", { flag: "a" });

  const tools = new Map();
  const handlers = new Map();
  const messageRenderers = new Map();
  const entries = options.entries ?? [];
  const branchEntries = options.branchEntries ?? entries;
  const calls = [];
  const sent = [];
  const prompts = [];
  const closedTabs = [];
  const childPaths = new Map();
  let tabSequence = 1;
  let lastTabId;

  async function defaultExec(args, execOptions) {
    if (args[0] === "tab" && args[1] === "create") {
      const id = ++tabSequence;
      const workspace = args[args.indexOf("--workspace") + 1];
      lastTabId = `${workspace}:t${id}`;
      return ok({
        tab: { tab_id: `${workspace}:t${id}`, workspace_id: workspace },
        root_pane: { pane_id: `${workspace}:p${id}` },
      });
    }
    if (args[0] === "tab" && args[1] === "close") {
      closedTabs.push(args[2]);
      return ok({ type: "ok" });
    }
    if (args[0] === "agent" && args[1] === "start") {
      const separator = args.indexOf("--");
      const piArgs = args.slice(separator + 1);
      const sessionIdIndex = piArgs.indexOf("--session-id");
      const resumeIndex = piArgs.indexOf("--session");
      let sessionPath;
      let childId;
      if (sessionIdIndex >= 0) {
        childId = piArgs[sessionIdIndex + 1];
        const sessionDir = piArgs[piArgs.indexOf("--session-dir") + 1];
        sessionPath = join(sessionDir, `2026-01-01T00-00-00-000Z_${childId}.jsonl`);
        await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: childId, cwd: "/repo" })}\n`);
        childPaths.set(args[2], sessionPath);
      } else {
        sessionPath = piArgs[resumeIndex + 1];
        const header = JSON.parse((await readFile(sessionPath, "utf8")).split("\n")[0]);
        childId = header.id;
        childPaths.set(args[2], sessionPath);
      }
      return ok({ agent: {
        name: args[2],
        agent: "pi",
        agent_status: "idle",
        pane_id: args[args.indexOf("--pane") + 1],
        tab_id: lastTabId,
        workspace_id: lastTabId.split(":")[0],
        agent_session: { kind: "path", value: sessionPath },
      } });
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      const pending = deferred();
      prompts.push({ args, signal: execOptions?.signal, ...pending });
      return pending.promise;
    }
    if (args[0] === "agent" && args[1] === "get") {
      const path = childPaths.get(args[2]);
      if (!path) return herdrError("agent_not_found", "agent not found");
      return ok({ agent: {
        name: args[2], agent: "pi", agent_status: "working",
        pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1",
        agent_session: { kind: "path", value: path },
      } });
    }
    if (args[0] === "agent" && args[1] === "wait") return new Promise(() => {});
    throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
  }

  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMessageRenderer(type, renderer) { messageRenderers.set(type, renderer); },
    on(event, handler) { handlers.set(event, handler); },
    getActiveTools: () => options.activeTools ?? ["read", "bash", BACKGROUND_AGENT_TOOL_NAME, BACKGROUND_AGENT_RESULT_TOOL_NAME],
    getThinkingLevel: () => "high",
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message, delivery) {
      const notification = {
        message,
        delivery,
        state: entries.filter((entry) => entry.customType === STATE_ENTRY_TYPE).at(-1)?.data,
        closedTabs: [...closedTabs],
      };
      sent.push(notification);
      options.onSendMessage?.(notification);
    },
    async exec(command, args, execOptions) {
      assert.equal(command, "herdr");
      const call = [...args];
      calls.push(call);
      return options.exec
        ? options.exec({ args, execOptions, defaultExec, childPaths, dir })
        : defaultExec(args, execOptions);
    },
  };

  const ids = options.ids ?? {
    handles: [HANDLE, "sub_b2c3d4e5"],
    children: [CHILD_ID, "22222222-2222-7222-8222-222222222222"],
    runs: [
      "run_0000000000000001",
      "run_0000000000000002",
      "run_0000000000000003",
      "run_0000000000000004",
    ],
  };
  const env = options.env ?? {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_WORKSPACE_ID: "w1",
    PI_BACKGROUND_AGENT_DEPTH: "0",
  };
  installBackgroundAgent(pi, { agent: {}, result: {} }, {
    env,
    createHandle: () => ids.handles.shift(),
    createChildSessionId: () => ids.children.shift(),
    createRunId: () => ids.runs.shift(),
    sleep: async () => {},
    sessionReadyAttempts: options.sessionReadyAttempts,
    transcriptAttempts: options.transcriptAttempts,
    transcriptRetryDelayMs: 0,
    unknownStabilizationDelayMs: 0,
    outputLimits: options.outputLimits ?? { maxBytes: 50 * 1024, maxLines: 2000 },
    truncateOutput: options.truncateOutput ?? truncateOutput,
  });

  const ctx = {
    cwd: "/repo",
    model: { provider: "openai", id: "gpt-5.6-sol" },
    scopedModels: [
      { model: { provider: "openai", id: "gpt-5.6-sol" } },
      { model: { provider: "openai", id: "gpt-5.6-luna" } },
    ],
    thinkingLevel: "xhigh",
    isProjectTrusted: () => options.getTrusted?.() ?? options.trusted ?? true,
    sessionManager: {
      getBranch: () => options.getBranch?.() ?? branchEntries,
      getSessionFile: () => parentPath,
      getSessionId: () => "outer",
    },
  };

  if (handlers.has("session_start") && options.startSession !== false) {
    await handlers.get("session_start")({ reason: "startup" }, ctx);
  }

  return {
    dir, parentPath, tools, handlers, messageRenderers, entries, calls, sent, prompts, closedTabs,
    childPaths, ctx, pi, env,
    agentTool: tools.get(BACKGROUND_AGENT_TOOL_NAME),
    resultTool: tools.get(BACKGROUND_AGENT_RESULT_TOOL_NAME),
    childPath(handle = HANDLE) { return childPaths.get(handle); },
    latestState() { return entries.filter((entry) => entry.customType === STATE_ENTRY_TYPE).at(-1)?.data; },
    stateEntries() { return entries.filter((entry) => entry.customType === STATE_ENTRY_TYPE); },
    basename,
  };
}
