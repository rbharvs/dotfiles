import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildSessionNamePrompt,
  fallbackSessionName,
  normalizeSessionName,
} from "./session-naming.ts";

const TITLE_MODEL = { provider: "openai", id: "gpt-5.6-luna" } as const;
const HERDR_METADATA_SOURCE = "user:pi-session-name";
const FRESH_NAME_ENV = "PI_SESSION_NAMING_FRESH";
const TITLE_TIMEOUT_MS = 15_000;

interface InstallOptions {
  env?: Record<string, string | undefined>;
  serializeContext(messages: any[]): string;
}

interface NamingContext {
  serialized: string;
  fallbackText: string;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
      ? String((part as { text?: unknown }).text ?? "")
      : "")
    .filter(Boolean)
    .join("\n");
}

function messageText(message: any): string {
  if (
    (message?.role === "compactionSummary" || message?.role === "branchSummary")
    && typeof message.summary === "string"
  ) return message.summary;
  return contentText(message?.content);
}

function branchMessages(ctx: ExtensionContext): any[] {
  return ctx.sessionManager.buildSessionProjection().messages
    .filter((message) => message.role !== "system");
}

function hasNameAfterSessionCreation(ctx: ExtensionContext): boolean {
  const manager = ctx.sessionManager as any;
  const createdAt = Date.parse(manager.getHeader?.()?.timestamp ?? "");
  if (!Number.isFinite(createdAt)) return false;
  return (manager.getEntries?.() ?? []).some((entry: any) =>
    entry?.type === "session_info"
    && typeof entry.name === "string"
    && Number.isFinite(Date.parse(entry.timestamp ?? ""))
    && Date.parse(entry.timestamp) >= createdAt
  );
}

function snapshotNamingContext(
  ctx: ExtensionContext,
  serializeContext: (messages: any[]) => string,
  pendingPrompt?: string,
): NamingContext | undefined {
  const messages = [...branchMessages(ctx)];
  const prompt = pendingPrompt?.trim();
  if (prompt) {
    const latestUser = [...messages].reverse().find((message) => message?.role === "user");
    if (messageText(latestUser).trim() !== prompt) {
      messages.push({ role: "user", content: [{ type: "text", text: prompt }] });
    }
  }
  if (messages.length === 0) return undefined;

  const fallbackText = messages
    .map(messageText)
    .filter(Boolean)
    .join("\n");
  let serialized = fallbackText;
  try {
    serialized = serializeContext(messages);
  } catch {
    // Naming must never block the main session on presentation-only serialization.
  }
  return { serialized, fallbackText };
}

async function generateName(
  namingContext: NamingContext,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string> {
  const fallback = fallbackSessionName(namingContext.fallbackText);
  const model = ctx.modelRegistry.find(TITLE_MODEL.provider, TITLE_MODEL.id);
  if (!model) return fallback;

  const response = await ctx.modelRegistry.streamSimple(
    model,
    {
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: buildSessionNamePrompt(namingContext.serialized, path.basename(ctx.cwd)),
        }],
        timestamp: Date.now(),
      }],
    },
    {
      maxTokens: 32,
      cacheRetention: "none",
      signal,
    },
  ).result();

  const raw = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join(" ");
  return normalizeSessionName(raw) || fallback;
}

export function installSessionNaming(pi: ExtensionAPI, options: InstallOptions): void {
  const env = options.env ?? process.env;
  const serializeContext = options.serializeContext;
  const paneId = env.HERDR_PANE_ID;
  const tabId = env.HERDR_TAB_ID;
  const herdrEnabled = env.HERDR_ENV === "1" && Boolean(paneId);
  const freshLaunchRequested = env[FRESH_NAME_ENV] === "1";
  if (freshLaunchRequested) delete env[FRESH_NAME_ENV];

  let namingStarted = false;
  let forceFreshPending = false;
  let namingController: AbortController | undefined;
  let metadataSeq = Date.now() * 1000;
  let herdrSyncTail = Promise.resolve();

  async function syncHerdr(name: string): Promise<void> {
    if (!herdrEnabled || !paneId) return;

    const commands: Promise<unknown>[] = [
      pi.exec("herdr", [
        "pane", "report-metadata", paneId,
        "--source", HERDR_METADATA_SOURCE,
        "--agent", "pi",
        "--applies-to-source", "herdr:pi",
        "--title", name,
        "--clear-display-agent",
        "--token", `session=${name}`,
        "--seq", String(++metadataSeq),
      ]),
      pi.exec("herdr", ["pane", "rename", paneId, name]),
    ];
    if (tabId) commands.push(pi.exec("herdr", ["tab", "rename", tabId, name]));
    await Promise.allSettled(commands);
  }

  async function clearHerdr(): Promise<void> {
    if (!herdrEnabled || !paneId) return;
    await Promise.allSettled([
      pi.exec("herdr", [
        "pane", "report-metadata", paneId,
        "--source", HERDR_METADATA_SOURCE,
        "--agent", "pi",
        "--applies-to-source", "herdr:pi",
        "--clear-title",
        "--clear-display-agent",
        "--clear-token", "session",
        "--seq", String(++metadataSeq),
      ]),
      pi.exec("herdr", ["pane", "rename", paneId, "--clear"]),
    ]);
  }

  function queueHerdr(operation: () => Promise<void>): void {
    herdrSyncTail = herdrSyncTail.then(operation, operation);
  }

  function queueHerdrSync(name: string): void {
    queueHerdr(() => syncHerdr(name));
  }

  function queueHerdrClear(): void {
    queueHerdr(clearHerdr);
  }

  function startNaming(
    namingContext: NamingContext,
    ctx: ExtensionContext,
    forceFresh = false,
  ): void {
    if (namingStarted || (!forceFresh && pi.getSessionName())) return;
    namingStarted = true;
    forceFreshPending = false;
    const expectedName = pi.getSessionName();
    const controller = new AbortController();
    namingController = controller;
    const mayApply = () => forceFresh
      ? pi.getSessionName() === expectedName
      : !pi.getSessionName();
    const applyFallback = () => {
      const fallback = fallbackSessionName(namingContext.fallbackText);
      if (fallback && mayApply()) pi.setSessionName(fallback);
    };
    const timer = setTimeout(() => {
      applyFallback();
      controller.abort();
    }, TITLE_TIMEOUT_MS);
    timer.unref?.();

    void generateName(namingContext, ctx, controller.signal)
      .then((name) => {
        if (name && !controller.signal.aborted && mayApply()) {
          pi.setSessionName(name);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) applyFallback();
      })
      .finally(() => clearTimeout(timer));
  }

  pi.on("session_start", (event, ctx) => {
    namingController?.abort();
    namingStarted = false;
    namingController = undefined;

    const forceFresh = event.reason === "fork" || (
      freshLaunchRequested && !hasNameAfterSessionCreation(ctx)
    );
    if (forceFresh) {
      queueHerdrClear();
      const namingContext = snapshotNamingContext(ctx, serializeContext);
      if (namingContext) startNaming(namingContext, ctx, true);
      else forceFreshPending = true;
      return;
    }

    const existingName = pi.getSessionName();
    if (existingName) {
      namingStarted = true;
      queueHerdrSync(existingName);
      return;
    }

    queueHerdrClear();
    const namingContext = snapshotNamingContext(ctx, serializeContext);
    if (namingContext) startNaming(namingContext, ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const namingContext = snapshotNamingContext(
      ctx, serializeContext, event.messageType === "user" ? event.prompt : undefined,
    );
    if (namingContext) startNaming(namingContext, ctx, forceFreshPending);
  });

  pi.on("session_info_changed", (event) => {
    if (event.name) queueHerdrSync(event.name);
    else queueHerdrClear();
  });

  pi.on("session_shutdown", async () => {
    namingController?.abort();
    await herdrSyncTail;
  });
}
