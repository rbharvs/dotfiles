import { randomBytes, randomUUID } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export const MAX_DELEGATION_DEPTH = 2;
export const BACKGROUND_AGENT_TOOL_NAME = "background_agent";
export const BACKGROUND_AGENT_RESULT_TOOL_NAME = "background_agent_result";
export const STATE_ENTRY_TYPE = "background-agent-state";
export const COMPLETION_MESSAGE_TYPE = "background-agent-completion";

const WAIT_GUIDANCE = "Do not run `sleep` or poll for completion.";
const ASYNC_GUIDANCE = `${WAIT_GUIDANCE} Continue with other useful work; if none remains, end your turn. A live completion notice will resume you automatically. Recovery after a parent restart is silent.`;
const AGENT_DESCRIPTION = `Start a reusable background-agent session or send a follow-up after its active run settles. The call returns after launch. ${WAIT_GUIDANCE}`;
const RESULT_DESCRIPTION = `Collect a persisted background-agent result after its completion notice or after resuming a restarted parent. Results are limited to 50KB or 2,000 lines; a truncated result names the full child transcript. ${WAIT_GUIDANCE}`;
export const RUNNING_MESSAGE = `This background-agent run is still active. ${WAIT_GUIDANCE} Continue with other useful work; if none remains, end your turn.`;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ACTIVE_PHASES = new Set(["starting", "running"]);
const PROMPT_PREVIEW_LINES = 3;
const RESULT_PREVIEW_LINES = 8;
const SESSION_READY_ATTEMPTS = 50;
const SESSION_READY_DELAY_MS = 100;
const TRANSCRIPT_ATTEMPTS = 5;
const TRANSCRIPT_RETRY_DELAY_MS = 50;
const UNKNOWN_STABILIZATION_DELAY_MS = 250;
const MAX_RUN_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_METADATA_TAIL_BYTES = 1024 * 1024;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const MAX_MODEL_LENGTH = 256;
const MAX_SESSION_NAME_LENGTH = 256;
const MAX_MODEL_ERROR_CHOICES = 10;
const MAX_MODEL_ERROR_CHOICE_LENGTH = 128;
const SESSION_PATTERN = /^sub_[a-f0-9]{8}$/;
const RUN_PATTERN = /^run_[a-f0-9]{16}$/;
const CHILD_SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETTLED_WAIT_ARGS = [
  "--until", "idle",
  "--until", "done",
  "--until", "blocked",
  "--until", "unknown",
];

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

interface ExtensionLike {
  registerTool(definition: Record<string, any>): void;
  registerMessageRenderer?(customType: string, renderer: (...args: any[]) => any): void;
  on?(event: string, handler: (...args: any[]) => unknown): void;
  exec?(command: string, args: string[], options?: { signal?: AbortSignal }): Promise<ExecResult>;
  getActiveTools?(): string[];
  getThinkingLevel?(): string;
  appendEntry?(customType: string, data?: unknown): void;
  sendMessage?(message: Record<string, unknown>, options?: Record<string, unknown>): void;
}

interface ToolParameters {
  agent: unknown;
  result: unknown;
}

interface OutputLimits {
  maxBytes: number;
  maxLines: number;
}

interface OutputTruncation {
  content: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
}

interface InstallOptions {
  env?: Record<string, string | undefined>;
  createHandle?: () => string | undefined;
  createChildSessionId?: () => string | undefined;
  createRunId?: () => string | undefined;
  sleep?: (milliseconds: number) => Promise<void>;
  sessionReadyAttempts?: number;
  transcriptAttempts?: number;
  transcriptRetryDelayMs?: number;
  unknownStabilizationDelayMs?: number;
  outputLimits?: OutputLimits;
  truncateOutput?: (content: string, limits: OutputLimits) => OutputTruncation;
}

type JobPhase = "starting" | "running" | "succeeded" | "failed";

interface JobRecord {
  version: 1;
  runId: string;
  session: string;
  childSessionId: string;
  childSessionPath?: string;
  sessionDir: string;
  workspaceId: string;
  tabId?: string;
  paneId?: string;
  cwd: string;
  model: string;
  thinkingLevel: string;
  tools: string[];
  trusted: boolean;
  prompt: string;
  baselineBytes: number;
  childRevision?: number;
  sessionName?: string;
  phase: JobPhase;
  result?: string;
  error?: string;
  createdAt: number;
}

interface AgentInfo {
  name?: string;
  agent?: string;
  agent_status?: string;
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
  agent_session?: { kind?: string; value?: string };
}

interface ParsedHerdrError {
  message: string;
  code?: string;
}

class HerdrCommandError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HerdrCommandError";
    this.code = code;
  }
}

class AssistantTranscriptError extends Error {
  sessionNameObserved: boolean;
  sessionName?: string;

  constructor(message: string, sessionNameObserved: boolean, sessionName?: string) {
    super(message);
    this.name = "AssistantTranscriptError";
    this.sessionNameObserved = sessionNameObserved;
    this.sessionName = sessionName;
  }
}

class SettledTranscriptError extends Error {
  record: JobRecord;
  revision: number;
  original: unknown;

  constructor(original: unknown, record: JobRecord, revision: number) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "SettledTranscriptError";
    this.record = record;
    this.revision = revision;
    this.original = original;
  }
}

function readDepth(raw: string | undefined): number | undefined {
  if (raw === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function defaultHandle(): string {
  return `sub_${randomBytes(4).toString("hex")}`;
}

function defaultRunId(): string {
  return `run_${randomBytes(8).toString("hex")}`;
}

function requireGenerated(
  value: string | undefined,
  label: string,
  pattern: RegExp,
): string {
  if (!value || !pattern.test(value)) {
    throw new Error(`Could not generate a valid background-agent ${label}`);
  }
  return value;
}

function cloneRecord(record: JobRecord): JobRecord {
  return { ...record, tools: [...record.tools] };
}

function normalizeRecord(value: unknown): JobRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<JobRecord>;
  if (
    record.version !== 1 ||
    typeof record.runId !== "string" || !RUN_PATTERN.test(record.runId) ||
    typeof record.session !== "string" || !SESSION_PATTERN.test(record.session) ||
    typeof record.childSessionId !== "string" || !CHILD_SESSION_PATTERN.test(record.childSessionId) ||
    typeof record.sessionDir !== "string" ||
    typeof record.workspaceId !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.model !== "string" || record.model.length > MAX_MODEL_LENGTH ||
    typeof record.thinkingLevel !== "string" || !THINKING_LEVELS.has(record.thinkingLevel) ||
    !Array.isArray(record.tools) ||
    typeof record.trusted !== "boolean" ||
    typeof record.prompt !== "string" ||
    typeof record.baselineBytes !== "number" || !Number.isSafeInteger(record.baselineBytes) || record.baselineBytes < 0 ||
    (record.childRevision !== undefined && (
      typeof record.childRevision !== "number" ||
      !Number.isSafeInteger(record.childRevision) ||
      record.childRevision < 0
    )) ||
    (record.sessionName !== undefined && (
      typeof record.sessionName !== "string" ||
      record.sessionName.length > MAX_SESSION_NAME_LENGTH ||
      normalizeSessionName(record.sessionName) !== record.sessionName
    )) ||
    !["starting", "running", "succeeded", "failed"].includes(record.phase ?? "") ||
    typeof record.createdAt !== "number"
  ) return undefined;
  if (record.phase === "succeeded" && typeof record.result !== "string") return undefined;
  if (record.phase === "failed" && typeof record.error !== "string") return undefined;
  return cloneRecord(record as JobRecord);
}

function normalizeSessionName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return [...normalized].slice(0, MAX_SESSION_NAME_LENGTH).join("");
}

function parseErrorOutput(output: string): ParsedHerdrError | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string; code?: string } };
    return {
      message: parsed.error?.message ?? parsed.error?.code ?? trimmed,
      code: parsed.error?.code,
    };
  } catch {
    return { message: trimmed };
  }
}

function isTransientShellError(error: unknown): boolean {
  return error instanceof HerdrCommandError && (
    error.code === "agent_pane_busy" ||
    error.code === "agent_pane_unavailable" ||
    error.message.includes("not an available shell")
  );
}

function canonicalModel(model: any): string | undefined {
  return typeof model?.provider === "string" && typeof model?.id === "string"
    ? `${model.provider}/${model.id}`
    : undefined;
}

function availableModels(ctx: any): string[] {
  let models: any[] = [];
  if (Array.isArray(ctx?.scopedModels) && ctx.scopedModels.length > 0) {
    models = ctx.scopedModels.map((entry: any) => entry?.model).filter(Boolean);
  } else if (ctx?.modelRegistry?.getAvailable) {
    models = ctx.modelRegistry.getAvailable();
  } else if (ctx?.model) {
    models = [ctx.model];
  }
  return [...new Set(models.map(canonicalModel).filter((value): value is string => Boolean(value)))];
}

function boundedModelChoices(models: string[]): string {
  const choices = models
    .slice(0, MAX_MODEL_ERROR_CHOICES)
    .map((model) => model.slice(0, MAX_MODEL_ERROR_CHOICE_LENGTH));
  if (choices.length === 0) return "none";
  const suffix = models.length > choices.length ? `, and ${models.length - choices.length} more` : "";
  return `${choices.join(", ")}${suffix}`;
}

function selectModel(input: unknown, ctx: any): string {
  const model = input === undefined ? canonicalModel(ctx?.model) : input;
  if (typeof model !== "string" || model.length > MAX_MODEL_LENGTH || !model.includes("/")) {
    throw new Error("'model' must be an exact provider/model-id reference of at most 256 characters");
  }
  const available = availableModels(ctx);
  if (!available.includes(model)) {
    throw new Error(`The requested model is not available in this session. Available models: ${boundedModelChoices(available)}`);
  }
  return model;
}

function selectThinking(input: unknown, ctx: any, pi: ExtensionLike): string {
  const thinking = input ?? ctx?.thinkingLevel ?? pi.getThinkingLevel?.() ?? "off";
  if (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking)) {
    throw new Error(`'thinking' must be one of: ${[...THINKING_LEVELS].join(", ")}`);
  }
  return thinking;
}

async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

async function readSessionHeader(file: FileHandle): Promise<{ id: string }> {
  const bytes = Buffer.alloc(MAX_SESSION_HEADER_BYTES);
  const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
  const firstNewline = bytes.subarray(0, bytesRead).indexOf(0x0a);
  if (firstNewline < 0) throw new Error("The child Pi session has no bounded, complete header");
  let header: any;
  try {
    header = JSON.parse(bytes.subarray(0, firstNewline).toString("utf8"));
  } catch {
    throw new Error("The child Pi session has an invalid header");
  }
  if (header?.type !== "session" || typeof header.id !== "string") {
    throw new Error("The child Pi session has an invalid header");
  }
  return { id: header.id };
}

async function sessionHeaderId(filePath: string): Promise<string | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(filePath, "r");
    return (await readSessionHeader(file)).id;
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

export async function findChildSessionPath(sessionDir: string, childSessionId: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return undefined;
  }
  const suffix = `_${childSessionId}.jsonl`;
  for (const name of names.filter((candidate) => candidate.endsWith(suffix)).sort().reverse()) {
    const candidate = path.join(sessionDir, name);
    if (await sessionHeaderId(candidate) === childSessionId) return candidate;
  }
  return undefined;
}

async function readRange(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(bytes, offset, length - offset, start + offset);
    if (bytesRead === 0) throw new Error("The child Pi session changed while its result was being read");
    offset += bytesRead;
  }
  return bytes;
}

interface SessionMetadataTail {
  revision: number;
  sessionNameObserved: boolean;
  sessionName?: string;
}

async function readSessionMetadataTail(
  sessionPath: string,
  start: number,
  expectedSessionId: string,
): Promise<SessionMetadataTail | undefined> {
  const file = await open(sessionPath, "r");
  try {
    const header = await readSessionHeader(file);
    if (header.id !== expectedSessionId) return undefined;
    const revision = (await file.stat()).size;
    const length = revision - start;
    if (length <= 0 || length > MAX_SESSION_METADATA_TAIL_BYTES) return undefined;
    const bytes = await readRange(file, start, length);
    if (bytes.at(-1) !== 0x0a || (await file.stat()).size !== revision) return undefined;

    let sessionNameObserved = false;
    let sessionName: string | undefined;
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        return undefined;
      }
      if (entry?.type === "usage") continue;
      if (entry?.type !== "session_info") return undefined;
      sessionNameObserved = true;
      if (entry.name === undefined || entry.name === null) {
        sessionName = undefined;
      } else if (typeof entry.name === "string") {
        sessionName = normalizeSessionName(entry.name);
      } else {
        return undefined;
      }
    }
    return { revision, sessionNameObserved, sessionName };
  } finally {
    await file.close();
  }
}

interface FinalAssistantSnapshot {
  result: string;
  revision: number;
  sessionNameObserved: boolean;
  sessionName?: string;
}

async function readFinalAssistantSnapshot(
  sessionPath: string,
  baselineBytes: number,
  expectedSessionId: string,
): Promise<FinalAssistantSnapshot> {
  const file = await open(sessionPath, "r");
  try {
    const header = await readSessionHeader(file);
    if (header.id !== expectedSessionId) {
      throw new Error("The child transcript belongs to a different Pi session");
    }

    const size = (await file.stat()).size;
    if (!Number.isSafeInteger(baselineBytes) || baselineBytes < 0 || baselineBytes > size) {
      throw new Error("The child run has an invalid transcript baseline");
    }
    const runBytes = size - baselineBytes;
    if (runBytes > MAX_RUN_TRANSCRIPT_BYTES) {
      throw new Error("The current child run transcript is too large to read safely");
    }
    const bytes = await readRange(file, baselineBytes, runBytes);
    let finalMessage: any;
    let sessionNameObserved = false;
    let sessionName: string | undefined;
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === "session_info") {
        if (entry.name === undefined || entry.name === null) {
          sessionNameObserved = true;
          sessionName = undefined;
        } else if (typeof entry.name === "string") {
          sessionNameObserved = true;
          sessionName = normalizeSessionName(entry.name);
        }
        continue;
      }
      if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
      if (entry.message.stopReason === "toolUse" || entry.message.stopReason === "pending") continue;
      finalMessage = entry.message;
    }

    if (!finalMessage) {
      throw new AssistantTranscriptError(
        "The child settled without a new final assistant reply",
        sessionNameObserved,
        sessionName,
      );
    }
    if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
      throw new AssistantTranscriptError(
        finalMessage.errorMessage || `Child reply ended with ${finalMessage.stopReason}`,
        sessionNameObserved,
        sessionName,
      );
    }
    const text = Array.isArray(finalMessage.content)
      ? finalMessage.content
          .filter((part: any) => part?.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text)
          .join("")
      : typeof finalMessage.content === "string"
        ? finalMessage.content
        : "";
    if (!text.trim()) {
      throw new AssistantTranscriptError(
        "The child's final assistant reply contained no text",
        sessionNameObserved,
        sessionName,
      );
    }
    return { result: text, revision: size, sessionNameObserved, sessionName };
  } finally {
    await file.close();
  }
}

export async function readFinalAssistant(
  sessionPath: string,
  baselineBytes: number,
  expectedSessionId: string,
): Promise<string> {
  return (await readFinalAssistantSnapshot(sessionPath, baselineBytes, expectedSessionId)).result;
}

function resultDetails(record: JobRecord): Record<string, unknown> {
  return {
    session: record.session,
    runId: record.runId,
    sessionName: record.sessionName,
    model: record.model,
    thinking: record.thinkingLevel,
    phase: record.phase,
  };
}

function fitWithNotice(
  output: string,
  notice: string,
  limits: OutputLimits,
  truncateOutput: (content: string, limits: OutputLimits) => OutputTruncation,
): string {
  const noticeBytes = Buffer.byteLength(notice);
  if (noticeBytes > limits.maxBytes) {
    throw new Error("The background-agent truncation notice is too large to report safely");
  }
  const content = truncateOutput(output, {
    maxBytes: Math.max(0, limits.maxBytes - noticeBytes - 2),
    maxLines: Math.max(0, limits.maxLines - 2),
  }).content;
  return content ? `${content}\n\n${notice}` : notice;
}

function formatResult(
  result: string,
  transcriptPath: string | undefined,
  limits: OutputLimits,
  truncateOutput: (content: string, limits: OutputLimits) => OutputTruncation,
): string {
  const truncated = truncateOutput(result, limits);
  if (!truncated.truncated) return result;
  const location = transcriptPath ? ` Full output: ${transcriptPath}.` : "";
  return fitWithNotice(
    result,
    `[Output truncated from ${truncated.totalLines} lines and ${truncated.totalBytes} bytes.${location}]`,
    limits,
    truncateOutput,
  );
}

function formatError(
  error: unknown,
  transcriptPath: string | undefined,
  limits: OutputLimits,
  truncateOutput: (content: string, limits: OutputLimits) => OutputTruncation,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const truncated = truncateOutput(message, limits);
  if (!truncated.truncated) return message;
  const location = transcriptPath ? ` Child transcript: ${transcriptPath}.` : "";
  return fitWithNotice(
    message,
    `[Error truncated from ${truncated.totalLines} lines and ${truncated.totalBytes} bytes.${location}]`,
    limits,
    truncateOutput,
  );
}

interface ToolRenderState {
  session?: string;
  runId?: string;
  sessionName?: string;
  model?: string;
  thinking?: string;
  resolveSession?: (session: string) => JobRecord | undefined;
  resolveRun?: (runId: string) => JobRecord | undefined;
}

function textContent(result: any): string {
  return Array.isArray(result?.content)
    ? result.content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
    : "";
}

function wrapLine(line: string, width: number): string[] {
  if (line.length === 0) return [""];
  const lines: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    let splitAt = remaining.lastIndexOf(" ", width);
    if (splitAt <= 0) splitAt = width;
    lines.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt);
    if (remaining.startsWith(" ")) remaining = remaining.slice(1);
  }
  lines.push(remaining);
  return lines;
}

function wrapPlainText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    lines.push(...wrapLine(line, safeWidth));
  }
  return lines;
}

function previewLines(lines: string[], maximum: number, width: number): string[] {
  if (lines.length <= maximum) return lines;
  const visible = lines.slice(0, maximum);
  const last = visible.length - 1;
  visible[last] = `${visible[last].slice(0, Math.max(0, width - 1)).trimEnd()}…`;
  return visible;
}

function renderHeader(
  toolName: string,
  state: ToolRenderState,
  args: any,
  theme: any,
): string {
  let text = theme.fg("toolTitle", theme.bold(toolName));
  const record = state.session
    ? state.resolveSession?.(state.session)
    : state.runId
      ? state.resolveRun?.(state.runId)
      : undefined;
  const identity = state.sessionName ?? record?.sessionName ?? record?.session ?? state.session;
  if (identity) text += ` ${theme.fg("accent", identity)}`;
  const model = state.model ?? record?.model ?? (
    typeof args?.model === "string" ? args.model : undefined
  );
  const thinking = state.thinking ?? record?.thinkingLevel ?? (
    typeof args?.thinking === "string" ? args.thinking : undefined
  );
  const config = model && thinking ? `${model}:${thinking}` : model ?? thinking;
  if (config) text += theme.fg("muted", ` (${config})`);
  return text;
}

interface RenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

function renderComponent(render: (width: number) => string[]): RenderComponent {
  return { render, invalidate() {} };
}

function renderLaunch(args: any, state: ToolRenderState, theme: any, expanded: boolean): RenderComponent {
  return renderComponent((width) => {
    const header = renderHeader(BACKGROUND_AGENT_TOOL_NAME, state, args, theme);
    const prompt = typeof args?.prompt === "string" ? args.prompt : "";
    if (!prompt) return [header];
    const wrapped = wrapPlainText(prompt, width);
    const visible = expanded ? wrapped : previewLines(wrapped, PROMPT_PREVIEW_LINES, width);
    return [header, "", ...visible.map((line) => theme.fg("toolOutput", line))];
  });
}

function renderToolHeader(
  toolName: string,
  args: any,
  state: ToolRenderState,
  theme: any,
): RenderComponent {
  return renderComponent(() => [renderHeader(toolName, state, args, theme)]);
}

function renderBody(
  body: string,
  theme: any,
  expanded: boolean,
  color = "toolOutput",
  previewLimit = RESULT_PREVIEW_LINES,
): RenderComponent {
  return renderComponent((width) => {
    if (!body) return [];
    const wrapped = wrapPlainText(body, width);
    const visible = expanded ? wrapped : previewLines(wrapped, previewLimit, width);
    return ["", ...visible.map((line) => theme.fg(color, line))];
  });
}

function updateRenderState(state: ToolRenderState, details: any): void {
  if (!details) return;
  if (typeof details.session === "string" && SESSION_PATTERN.test(details.session)) {
    state.session = details.session;
  }
  if (typeof details.runId === "string" && RUN_PATTERN.test(details.runId)) {
    state.runId = details.runId;
  }
  if ("sessionName" in details) {
    state.sessionName = normalizeSessionName(details.sessionName);
  }
  if (typeof details.model === "string") state.model = details.model;
  if (typeof details.thinking === "string") state.thinking = details.thinking;
}

export function installBackgroundAgent(
  pi: ExtensionLike,
  parameters: Partial<ToolParameters> | unknown,
  options: InstallOptions = {},
): void {
  const env = options.env ?? process.env;
  const depth = readDepth(env.PI_BACKGROUND_AGENT_DEPTH);
  if (
    env.HERDR_ENV !== "1" ||
    !env.HERDR_PANE_ID ||
    !env.HERDR_WORKSPACE_ID ||
    depth === undefined ||
    depth >= MAX_DELEGATION_DEPTH
  ) return;

  const parameterSet = parameters as Partial<ToolParameters>;
  const agentParameters = parameterSet?.agent ?? parameters;
  const resultParameters = parameterSet?.result ?? {
    type: "object",
    properties: { run_id: { type: "string", pattern: "^run_[a-f0-9]{16}$" } },
    required: ["run_id"],
    additionalProperties: false,
  };
  const childDepth = depth + 1;
  const createHandle = options.createHandle ?? defaultHandle;
  const createChildSessionId = options.createChildSessionId ?? randomUUID;
  const createRunId = options.createRunId ?? defaultRunId;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const sessionReadyAttempts = options.sessionReadyAttempts ?? SESSION_READY_ATTEMPTS;
  const transcriptAttempts = options.transcriptAttempts ?? TRANSCRIPT_ATTEMPTS;
  const transcriptRetryDelayMs = options.transcriptRetryDelayMs ?? TRANSCRIPT_RETRY_DELAY_MS;
  const unknownStabilizationDelayMs = options.unknownStabilizationDelayMs ?? UNKNOWN_STABILIZATION_DELAY_MS;
  if (!options.outputLimits || !options.truncateOutput) {
    throw new Error("The background-agent output limiter is unavailable");
  }
  const outputLimits = options.outputLimits;
  const truncateOutput = options.truncateOutput;

  const runs = new Map<string, JobRecord>();
  const sessions = new Map<string, JobRecord>();
  const monitors = new Map<string, AbortController>();
  const livePlacements = new Map<string, OwnedPlacement>();
  const lockTails = new Map<string, Promise<void>>();
  let active = true;
  let branchEpoch = 0;

  function bindRenderState(state: ToolRenderState): ToolRenderState {
    state.resolveSession = (session) => sessions.get(session);
    state.resolveRun = (runId) => runs.get(runId);
    return state;
  }

  async function withSessionLock<T>(session: string, operation: () => Promise<T>): Promise<T> {
    const previous = lockTails.get(session) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    lockTails.set(session, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (lockTails.get(session) === tail) lockTails.delete(session);
    }
  }

  async function execHerdr<T>(args: string[], signal?: AbortSignal): Promise<T> {
    if (!pi.exec) throw new Error("The background-agent backend is unavailable");
    const response = await pi.exec("herdr", args, { signal });
    if (response.killed || signal?.aborted) throw new Error("Aborted");
    if (response.code !== 0) {
      const parsed = parseErrorOutput(response.stderr) ?? parseErrorOutput(response.stdout);
      throw new HerdrCommandError(
        parsed?.message ?? `Background-agent backend failed with exit code ${response.code}`,
        parsed?.code,
      );
    }
    let envelope: { result?: T; error?: { message?: string; code?: string } };
    try {
      envelope = JSON.parse(response.stdout) as typeof envelope;
    } catch {
      throw new Error("The background-agent backend returned invalid JSON");
    }
    if (envelope.error) {
      throw new HerdrCommandError(
        envelope.error.message ?? envelope.error.code ?? "Background-agent backend request failed",
        envelope.error.code,
      );
    }
    if (envelope.result === undefined) throw new Error("The background-agent backend returned no result");
    return envelope.result;
  }

  function remember(record: JobRecord): void {
    const copy = cloneRecord(record);
    runs.set(copy.runId, copy);
    sessions.set(copy.session, copy);
  }

  function persist(record: JobRecord, epoch: number): void {
    if (!active || epoch !== branchEpoch) {
      throw new Error("The parent session branch changed during background-agent work");
    }
    remember(record);
    pi.appendEntry?.(STATE_ENTRY_TYPE, cloneRecord(record));
  }

  function isCurrentActive(record: JobRecord): boolean {
    const currentRun = runs.get(record.runId);
    const currentSession = sessions.get(record.session);
    return Boolean(
      currentRun && ACTIVE_PHASES.has(currentRun.phase) &&
      currentSession?.runId === record.runId && ACTIVE_PHASES.has(currentSession.phase),
    );
  }

  function buildPiArgs(record: JobRecord, resume: boolean): string[] {
    const args = resume
      ? ["--session", record.childSessionPath!]
      : ["--session-id", record.childSessionId, "--session-dir", record.sessionDir];
    args.push("--model", record.model, "--thinking", record.thinkingLevel);
    if (record.tools.length > 0) args.push("--tools", record.tools.join(","));
    else args.push("--no-tools");
    args.push(record.trusted ? "--approve" : "--no-approve");
    return args;
  }

  async function startAgentWhenShellReady(args: string[], signal?: AbortSignal): Promise<{ agent: AgentInfo }> {
    const delays = [25, 50, 100, 200, 400, 800, 1000, 1000, 1000, 1000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await execHerdr<{ agent: AgentInfo }>(args, signal);
      } catch (error) {
        if (!isTransientShellError(error) || attempt >= delays.length) throw error;
        await sleep(delays[attempt]);
      }
    }
  }

  async function resolveChildSessionPath(record: JobRecord): Promise<string> {
    if (record.childSessionPath && await sessionHeaderId(record.childSessionPath) === record.childSessionId) {
      return record.childSessionPath;
    }
    for (let attempt = 0; attempt <= sessionReadyAttempts; attempt += 1) {
      const found = await findChildSessionPath(record.sessionDir, record.childSessionId);
      if (found) return found;
      if (attempt < sessionReadyAttempts) await sleep(SESSION_READY_DELAY_MS);
    }
    throw new Error("The background agent did not attach the expected Pi session");
  }

  interface SettledResult {
    record: JobRecord;
    result: string;
    revision: number;
    sessionNameObserved: boolean;
    sessionName?: string;
  }

  async function readResultWithRetry(source: JobRecord): Promise<SettledResult> {
    const childSessionPath = await resolveChildSessionPath(source);
    const record = { ...source, childSessionPath };
    let lastError: unknown;
    let stableRevision: number | undefined;
    for (let attempt = 0; attempt < transcriptAttempts; attempt += 1) {
      try {
        const snapshot = await readFinalAssistantSnapshot(
          childSessionPath,
          record.baselineBytes,
          record.childSessionId,
        );
        await sleep(transcriptRetryDelayMs);
        if (await fileSize(childSessionPath) !== snapshot.revision) {
          throw new Error("The child transcript was still flushing after settlement");
        }
        return {
          record,
          result: formatResult(snapshot.result, childSessionPath, outputLimits, truncateOutput),
          revision: snapshot.revision,
          sessionNameObserved: snapshot.sessionNameObserved,
          sessionName: snapshot.sessionName,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof AssistantTranscriptError && error.sessionNameObserved) {
          record.sessionName = error.sessionName;
        }
        try {
          const candidate = await fileSize(childSessionPath);
          await sleep(transcriptRetryDelayMs);
          stableRevision = await fileSize(childSessionPath) === candidate ? candidate : undefined;
        } catch {
          stableRevision = undefined;
        }
      }
    }
    if (stableRevision !== undefined) {
      throw new SettledTranscriptError(lastError, record, stableRevision);
    }
    throw lastError;
  }

  interface OwnedPlacement {
    workspaceId: string;
    tabId: string;
    paneId: string;
  }

  type CompletionOperation =
    | { kind: "live"; placement: OwnedPlacement }
    | { kind: "recovery" };

  async function closeTab(tabId: string): Promise<void> {
    try {
      await execHerdr(["tab", "close", tabId]);
    } catch {
      // Completion is already durable. Cleanup remains best-effort.
    }
  }

  function deliverLiveCompletion(record: JobRecord): void {
    if (!active) return;
    const status = record.phase === "succeeded" ? "completed" : "failed";
    pi.sendMessage?.({
      customType: COMPLETION_MESSAGE_TYPE,
      content: `Background agent ${record.session} ${status}. Call ${BACKGROUND_AGENT_RESULT_TOOL_NAME} with {"run_id":"${record.runId}"} to retrieve the result.`,
      display: true,
      details: { ...resultDetails(record), status },
    }, { deliverAs: "steer", triggerTurn: true });
  }

  async function proveRecoveredTabOwnership(record: JobRecord): Promise<string | undefined> {
    if (!record.tabId || !record.paneId || !record.workspaceId || !record.childSessionPath) return undefined;
    try {
      const agent = (await execHerdr<{ agent: AgentInfo }>(["agent", "get", record.session])).agent;
      if (
        agent.name !== record.session ||
        agent.agent !== "pi" ||
        agent.tab_id !== record.tabId ||
        agent.pane_id !== record.paneId ||
        agent.workspace_id !== record.workspaceId ||
        agent.agent_session?.kind !== "path" ||
        agent.agent_session.value !== record.childSessionPath ||
        await sessionHeaderId(agent.agent_session.value) !== record.childSessionId
      ) return undefined;
      return agent.tab_id;
    } catch {
      return undefined;
    }
  }

  async function completeOperation(record: JobRecord, operation: CompletionOperation): Promise<void> {
    if (operation.kind === "live") {
      try {
        deliverLiveCompletion(record);
      } finally {
        await closeTab(operation.placement.tabId);
      }
      return;
    }
    const provedTabId = await proveRecoveredTabOwnership(record);
    if (provedTabId) await closeTab(provedTabId);
  }

  async function transitionTerminal(
    source: JobRecord,
    outcome: {
      result: string;
      revision: number;
      sessionNameObserved: boolean;
      sessionName?: string;
    } | { error: unknown; revision?: number },
    operation: CompletionOperation,
    epoch: number,
  ): Promise<JobRecord | undefined> {
    return withSessionLock(source.session, async () => {
      if (!active || epoch !== branchEpoch || !isCurrentActive(source)) return undefined;
      const terminal: JobRecord = "result" in outcome
        ? {
            ...source,
            childRevision: outcome.revision,
            sessionName: outcome.sessionNameObserved ? outcome.sessionName : source.sessionName,
            phase: "succeeded",
            result: outcome.result,
            error: undefined,
          }
        : {
            ...source,
            childRevision: outcome.revision,
            phase: "failed",
            result: undefined,
            error: formatError(outcome.error, source.childSessionPath, outputLimits, truncateOutput),
          };
      persist(terminal, epoch);
      try {
        await completeOperation(terminal, operation);
      } finally {
        if (operation.kind === "live") livePlacements.delete(terminal.runId);
      }
      return terminal;
    });
  }

  async function settleFromTranscript(
    record: JobRecord,
    operation: CompletionOperation,
    epoch: number,
  ): Promise<void> {
    try {
      const settled = await readResultWithRetry(record);
      await transitionTerminal(
        settled.record,
        {
          result: settled.result,
          revision: settled.revision,
          sessionNameObserved: settled.sessionNameObserved,
          sessionName: settled.sessionName,
        },
        operation,
        epoch,
      );
    } catch (error) {
      if (error instanceof SettledTranscriptError) {
        await transitionTerminal(
          error.record,
          { error: error.original, revision: error.revision },
          operation,
          epoch,
        );
        return;
      }
      await transitionTerminal(record, { error }, operation, epoch);
    }
  }

  async function requireSuccessfulSettlement(
    record: JobRecord,
    initialAgent: AgentInfo | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let agent = initialAgent;
    let stabilizationAvailable = true;
    let stabilizationPerformed = false;
    let initialWaitAvailable = true;
    let postStabilizationWaitAvailable = true;
    while (true) {
      const status = agent?.agent_status;
      if (status === "idle" || status === "done") return;
      if (status === "blocked") throw new Error("Background agent is blocked and is not safely resumable");
      if (status === "unknown") {
        if (!stabilizationAvailable) {
          throw new Error("Background agent remained unknown after stabilization");
        }
        stabilizationAvailable = false;
        stabilizationPerformed = true;
        await sleep(unknownStabilizationDelayMs);
        agent = (await execHerdr<{ agent: AgentInfo }>([
          "agent", "get", record.session,
        ], signal)).agent;
        continue;
      }
      if (status === "working") {
        const waitAvailable = stabilizationPerformed
          ? postStabilizationWaitAvailable
          : initialWaitAvailable;
        if (!waitAvailable) {
          throw new Error("Background agent did not settle after its bounded lifecycle wait");
        }
        if (stabilizationPerformed) postStabilizationWaitAvailable = false;
        else initialWaitAvailable = false;
        agent = (await execHerdr<{ agent?: AgentInfo }>([
          "agent", "wait", record.session, ...SETTLED_WAIT_ARGS,
        ], signal)).agent;
        continue;
      }
      throw new Error(`Background agent wait ended in unexpected state: ${status ?? "missing"}`);
    }
  }

  function forgetMonitor(runId: string, controller: AbortController): void {
    if (monitors.get(runId) === controller) monitors.delete(runId);
  }

  interface PendingPrompt {
    controller: AbortController;
    settled: Promise<{ agent?: AgentInfo; error?: unknown }>;
    epoch: number;
  }

  function beginPrompt(record: JobRecord, epoch: number): PendingPrompt {
    const controller = new AbortController();
    monitors.set(record.runId, controller);
    const settled = execHerdr<{ agent?: AgentInfo }>([
      "agent", "prompt", record.session, record.prompt, "--wait", ...SETTLED_WAIT_ARGS,
    ], controller.signal).then(
      ({ agent }) => ({ agent }),
      (error) => ({ error }),
    );
    return { controller, settled, epoch };
  }

  function attachPromptMonitor(
    record: JobRecord,
    pending: PendingPrompt,
    placement: OwnedPlacement,
  ): void {
    void (async () => {
      const operation: CompletionOperation = { kind: "live", placement };
      try {
        const { agent, error } = await pending.settled;
        if (pending.controller.signal.aborted || !active || pending.epoch !== branchEpoch) return;
        if (error) {
          await transitionTerminal(record, { error }, operation, pending.epoch);
          return;
        }
        try {
          await requireSuccessfulSettlement(record, agent, pending.controller.signal);
        } catch (lifecycleError) {
          await transitionTerminal(record, { error: lifecycleError }, operation, pending.epoch);
          return;
        }
        await settleFromTranscript(record, operation, pending.epoch);
      } finally {
        forgetMonitor(record.runId, pending.controller);
      }
    })();
  }

  async function launchRun(
    record: JobRecord,
    resume: boolean,
    epoch: number,
    signal?: AbortSignal,
  ): Promise<JobRecord> {
    let current = record;
    let pendingPrompt: PendingPrompt | undefined;
    let placement: OwnedPlacement | undefined;
    try {
      const workspaceId = env.HERDR_WORKSPACE_ID;
      if (!workspaceId) throw new Error("The parent Herdr workspace is unavailable");
      const created = await execHerdr<{
        tab: { tab_id: string; workspace_id?: string };
        root_pane: { pane_id: string };
      }>([
        "tab", "create", "--workspace", workspaceId, "--cwd", record.cwd,
        "--env", `PI_BACKGROUND_AGENT_DEPTH=${childDepth}`, "--no-focus",
      ], signal);
      placement = {
        workspaceId: created.tab.workspace_id ?? workspaceId,
        tabId: created.tab.tab_id,
        paneId: created.root_pane.pane_id,
      };
      livePlacements.set(current.runId, placement);
      current = {
        ...current,
        workspaceId: placement.workspaceId,
        tabId: placement.tabId,
        paneId: placement.paneId,
      };
      persist(current, epoch);

      await startAgentWhenShellReady([
        "agent", "start", current.session, "--kind", "pi", "--pane", current.paneId!, "--",
        ...buildPiArgs(current, resume),
      ], signal);

      pendingPrompt = beginPrompt(current, epoch);
      current = { ...current, phase: "running" };
      persist(current, epoch);
      attachPromptMonitor(current, pendingPrompt, placement);
      return current;
    } catch (error) {
      pendingPrompt?.controller.abort();
      if (pendingPrompt) forgetMonitor(current.runId, pendingPrompt.controller);
      const message = formatError(error, current.childSessionPath, outputLimits, truncateOutput);
      const failed = { ...current, phase: "failed" as const, error: message };
      if (active && epoch === branchEpoch) persist(failed, epoch);
      livePlacements.delete(current.runId);
      if (placement) await closeTab(placement.tabId);
      throw new Error(message);
    }
  }

  async function recover(
    record: JobRecord,
    epoch: number,
    operation: CompletionOperation = { kind: "recovery" },
  ): Promise<void> {
    if (monitors.has(record.runId)) return;
    const controller = new AbortController();
    monitors.set(record.runId, controller);
    void (async () => {
      try {
        const agent = (await execHerdr<{ agent: AgentInfo }>([
          "agent", "get", record.session,
        ], controller.signal)).agent;
        if (controller.signal.aborted || !active || epoch !== branchEpoch) return;

        await requireSuccessfulSettlement(record, agent, controller.signal);
        if (!controller.signal.aborted && active && epoch === branchEpoch) {
          await settleFromTranscript(record, operation, epoch);
        }
      } catch (error) {
        if (!controller.signal.aborted && active && epoch === branchEpoch) {
          await transitionTerminal(record, { error }, operation, epoch);
        }
      } finally {
        forgetMonitor(record.runId, controller);
      }
    })();
  }

  const agentTool: Record<string, any> = {
    name: BACKGROUND_AGENT_TOOL_NAME,
    label: "Background Agent",
    description: AGENT_DESCRIPTION,
    promptSnippet: "Delegate work to a reusable background agent",
    promptGuidelines: [
      "Use background_agent when a task benefits from an independent context.",
      WAIT_GUIDANCE,
      "Continue useful work after launch; completion is announced automatically while this runtime stays open.",
      "Reuse a session handle only after its active run settles.",
    ],
    parameters: agentParameters,
    async execute(
      _toolCallId: string,
      input: { prompt: string; session?: string; model?: string; thinking?: string },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      if (signal?.aborted) throw new Error("Cancelled before background-agent launch");
      const prompt = input.prompt?.trim();
      if (!prompt) throw new Error("'prompt' must not be empty");

      if (input.session !== undefined) {
        if (input.model !== undefined) throw new Error("'model' may only be specified when creating a new background-agent session");
        if (input.thinking !== undefined) throw new Error("'thinking' may only be specified when creating a new background-agent session");
        const session = input.session;
        if (!SESSION_PATTERN.test(session)) throw new Error("Unknown background-agent session");
        return withSessionLock(session, async () => {
          const base = sessions.get(session);
          if (!base) throw new Error("Unknown background-agent session");
          if (ACTIVE_PHASES.has(base.phase)) {
            throw new Error("The background-agent session is already running; wait for it to settle before sending a follow-up");
          }
          if (base.trusted !== (ctx.isProjectTrusted?.() === true)) {
            throw new Error("The parent project trust decision changed; start a new background-agent session");
          }
          if (!base.childSessionPath || base.childRevision === undefined) {
            throw new Error("The previous run did not establish a safely resumable child transcript; start a new background-agent session");
          }
          let resumable = base;
          const currentRevision = await fileSize(base.childSessionPath);
          if (currentRevision !== base.childRevision) {
            const metadata = await readSessionMetadataTail(
              base.childSessionPath,
              base.childRevision,
              base.childSessionId,
            );
            if (!metadata || metadata.revision !== currentRevision) {
              throw new Error("The child transcript revision changed outside this parent branch; start a new background-agent session");
            }
            resumable = {
              ...base,
              childRevision: metadata.revision,
              sessionName: metadata.sessionNameObserved ? metadata.sessionName : base.sessionName,
            };
          }
          const workspaceId = env.HERDR_WORKSPACE_ID;
          if (!workspaceId) throw new Error("The parent Herdr workspace is unavailable");

          const record: JobRecord = {
            ...resumable,
            runId: requireGenerated(createRunId(), "run ID", RUN_PATTERN),
            workspaceId,
            tabId: undefined,
            paneId: undefined,
            prompt,
            baselineBytes: currentRevision,
            childRevision: undefined,
            phase: "starting",
            result: undefined,
            error: undefined,
            createdAt: Date.now(),
          };
          const epoch = branchEpoch;
          persist(record, epoch);
          const launched = await launchRun(record, true, epoch, signal);
          return {
            content: [{
              type: "text",
              text: `Sent a follow-up to background agent ${launched.session}.\n\nsession: "${launched.session}"\nrun_id: "${launched.runId}"\n\n${ASYNC_GUIDANCE}`,
            }],
            details: resultDetails(launched),
          };
        });
      }

      const model = selectModel(input.model, ctx);
      const thinkingLevel = selectThinking(input.thinking, ctx, pi);
      const parentSessionPath = ctx?.sessionManager?.getSessionFile?.();
      if (typeof parentSessionPath !== "string" || !parentSessionPath) {
        throw new Error("A persisted parent Pi session is required to start a background agent");
      }
      const session = requireGenerated(createHandle(), "session handle", SESSION_PATTERN);
      const record: JobRecord = {
        version: 1,
        runId: requireGenerated(createRunId(), "run ID", RUN_PATTERN),
        session,
        childSessionId: requireGenerated(createChildSessionId(), "Pi session ID", CHILD_SESSION_PATTERN),
        sessionDir: path.dirname(parentSessionPath),
        workspaceId: env.HERDR_WORKSPACE_ID!,
        cwd: ctx.cwd,
        model,
        thinkingLevel,
        tools: (pi.getActiveTools?.() ?? []).filter(
          (name) => childDepth < MAX_DELEGATION_DEPTH ||
            (name !== BACKGROUND_AGENT_TOOL_NAME && name !== BACKGROUND_AGENT_RESULT_TOOL_NAME),
        ),
        trusted: ctx.isProjectTrusted?.() === true,
        prompt,
        baselineBytes: 0,
        phase: "starting",
        createdAt: Date.now(),
      };
      const epoch = branchEpoch;
      persist(record, epoch);
      const launched = await withSessionLock(session, () => launchRun(record, false, epoch, signal));
      return {
        content: [{
          type: "text",
          text: `Started background agent ${launched.session} asynchronously.\n\nsession: "${launched.session}"\nrun_id: "${launched.runId}"\n\n${ASYNC_GUIDANCE} Reuse the session handle for follow-ups after this run settles.`,
        }],
        details: resultDetails(launched),
      };
    },
    renderCall(args: any, theme: any, context: any) {
      const state = bindRenderState(context.state as ToolRenderState);
      if (typeof args?.session === "string" && SESSION_PATTERN.test(args.session)) {
        state.session = args.session;
      }
      return renderLaunch(args, state, theme, context.expanded);
    },
    renderResult(result: any, _renderOptions: any, theme: any, context: any) {
      updateRenderState(context.state as ToolRenderState, result.details);
      if (!context.isError) return renderComponent(() => []);
      return renderBody(textContent(result), theme, true, "error");
    },
  };

  const resultTool: Record<string, any> = {
    name: BACKGROUND_AGENT_RESULT_TOOL_NAME,
    label: "Background Agent Result",
    description: RESULT_DESCRIPTION,
    promptSnippet: "Collect a completed background-agent result by run_id",
    parameters: resultParameters,
    async execute(
      _toolCallId: string,
      input: { run_id: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: any,
    ) {
      if (typeof input.run_id !== "string" || !RUN_PATTERN.test(input.run_id)) {
        throw new Error("Unknown background-agent run");
      }
      const record = runs.get(input.run_id);
      if (!record) throw new Error("Unknown background-agent run");
      const details = resultDetails(record);
      if (ACTIVE_PHASES.has(record.phase)) {
        return { content: [{ type: "text", text: RUNNING_MESSAGE }], details };
      }
      if (record.phase === "failed") {
        throw new Error(formatError(
          record.error ?? "The background agent failed without an error message.",
          record.childSessionPath,
          outputLimits,
          truncateOutput,
        ));
      }
      return {
        content: [{
          type: "text",
          text: formatResult(record.result ?? "", record.childSessionPath, outputLimits, truncateOutput),
        }],
        details,
      };
    },
    renderCall(args: any, theme: any, context: any) {
      const state = bindRenderState(context.state as ToolRenderState);
      if (typeof args?.run_id === "string" && RUN_PATTERN.test(args.run_id)) {
        state.runId = args.run_id;
      }
      return renderToolHeader(BACKGROUND_AGENT_RESULT_TOOL_NAME, args, state, theme);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      updateRenderState(context.state as ToolRenderState, result.details);
      if (context.isError) {
        return renderBody(textContent(result), theme, true, "error");
      }
      const phase = result.details?.phase;
      const previewLimit = ACTIVE_PHASES.has(phase) ? Number.MAX_SAFE_INTEGER : RESULT_PREVIEW_LINES;
      return renderBody(textContent(result), theme, renderOptions.expanded, "toolOutput", previewLimit);
    },
  };

  pi.registerTool(agentTool);
  pi.registerTool(resultTool);
  pi.registerMessageRenderer?.(COMPLETION_MESSAGE_TYPE, (message: any, _options: any, theme: any) => {
    const sessionName = normalizeSessionName(message?.details?.sessionName);
    const session = typeof message?.details?.session === "string"
      && SESSION_PATTERN.test(message.details.session)
      ? message.details.session
      : undefined;
    const status = message?.details?.status === "failed" ? "failed" : "completed";
    const identity = sessionName ?? session;
    const label = identity ? `${identity} ${status}` : status;
    return renderComponent(() => [theme.fg("customMessageText", label)]);
  });

  function bindCurrentBranch(ctx: any): void {
    active = true;
    branchEpoch += 1;
    for (const controller of monitors.values()) controller.abort();
    monitors.clear();
    runs.clear();
    sessions.clear();

    const models = availableModels(ctx);
    agentTool.description = AGENT_DESCRIPTION +
      (models.length > 0 ? ` Available models: ${boundedModelChoices(models)}.` : "");

    const entries = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const entry of entries) {
      if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
      const record = normalizeRecord(entry.data);
      if (record) remember(record);
    }
    const epoch = branchEpoch;
    for (const record of sessions.values()) {
      if (!ACTIVE_PHASES.has(record.phase)) continue;
      const placement = livePlacements.get(record.runId);
      const operation: CompletionOperation = placement
        ? { kind: "live", placement }
        : { kind: "recovery" };
      void recover(record, epoch, operation);
    }
  }

  pi.on?.("session_start", (_event: unknown, ctx: any) => bindCurrentBranch(ctx));
  pi.on?.("session_tree", (_event: unknown, ctx: any) => bindCurrentBranch(ctx));

  pi.on?.("session_shutdown", () => {
    active = false;
    branchEpoch += 1;
    for (const controller of monitors.values()) controller.abort();
    monitors.clear();
    livePlacements.clear();
    lockTails.clear();
  });
}
