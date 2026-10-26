import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import runAndNotify from "../index.ts";

export const NOTICE_TYPE = "run-and-notify";

// Real AgentSession with Pi's in-process faux provider. The extension receives the real ExtensionAPI;
// the wrapper only records sendMessage submissions (per extension runtime) before forwarding them.
export async function startSession(t, { responses, settings = {}, gate = async () => {} }) {
  const root = await mkdtemp(join(tmpdir(), "run-and-notify-test-"));
  const previousEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TMPDIR: process.env.TMPDIR };
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const tmp = join(root, "tmp");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(tmp)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TMPDIR = tmp;

  const submissions = [];
  const submitted = new EventEmitter();
  let runtimes = 0;
  const observed = (pi) => {
    const runtime = ++runtimes;
    return runAndNotify(new Proxy(pi, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== "sendMessage") return typeof value === "function" ? value.bind(target) : value;
        return (message, options) => {
          submissions.push({ runtime, message });
          submitted.emit("submit");
          return value.call(target, message, options);
        };
      },
    }));
  };
  const gateTool = (pi) => pi.registerTool({
    name: "gate", label: "gate", description: "Test barrier", parameters: Type.Object({}),
    async execute() { await gate(); return { content: [{ type: "text", text: "gate open" }], details: undefined }; },
  });

  const faux = fauxProvider({ provider: `faux-${root.slice(-6)}` });
  const contexts = [];
  faux.setResponses(responses.map((step) => async (context, options, state, model) => {
    contexts.push(context);
    return typeof step === "function" ? step(context, options, state, model) : step;
  }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.models[0].provider, "not-a-real-key");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [observed, gateTool, createCodemodeExtension({ models: false })],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), settingsManager,
  });
  await session.bindExtensions({ mode: "rpc" });
  // Apply after startup reloads, just as command-line/session overrides affect the live session.
  settingsManager.applyOverrides(settings);
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);

  // Same order as AgentSessionRuntime.dispose(): the quit shutdown event, then invalidation.
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const toolResults = [];
  session.subscribe((event) => { if (event.type === "tool_execution_end") toolResults.push(event); });

  return {
    root, cwd, tmp, agentDir, session, settingsManager, faux, contexts, submissions, toolResults,
    /** Resolves once at least `count` notices have been submitted. Event-driven, no polling. */
    submittedCount(count) {
      return new Promise((resolve) => {
        const check = () => { if (submissions.length >= count) { submitted.off("submit", check); resolve(); } };
        submitted.on("submit", check);
        check();
      });
    },
    entries: () => session.sessionManager.getEntries(),
    notices: () => session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === NOTICE_TYPE),
    outputOf: (toolCallId) => toolResults.find((e) => e.toolCallId === toolCallId)?.result.details?.outputPath,
  };
}

export const done = (text = "ok") => fauxAssistantMessage(text);

export function fifo(path) {
  execFileSync("mkfifo", [path]);
  return path;
}

/** Reads a FIFO until every process holding its write end has exited. */
export function holders(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  let text = "";
  const lines = new EventEmitter();
  stream.on("data", (chunk) => { text += chunk; lines.emit("data"); });
  const ended = new Promise((resolve, reject) => { stream.on("end", () => resolve(text)); stream.on("error", reject); });
  return {
    ended,
    saw: (needle) => new Promise((resolve) => {
      const check = () => { if (text.includes(needle)) { lines.off("data", check); resolve(); } };
      lines.on("data", check);
      check();
    }),
  };
}
