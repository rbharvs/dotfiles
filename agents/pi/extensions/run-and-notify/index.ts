import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  getShellConfig,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NOTICE_TYPE = "run-and-notify";
const SHUTDOWN_GRACE_MS = 300;

type Outcome = { kind: "exit"; code: number } | { kind: "signal"; signal: NodeJS.Signals };
interface Notice {
  outputPath: string;
  outcome: Outcome;
}

const Parameters = Type.Object(
  { command: Type.String({ minLength: 1, description: "Shell command to run without detaching or leaving background processes" }) },
  { additionalProperties: false },
);

export default function runAndNotify(pi: ExtensionAPI): void {
  // Commands this runtime owns. Undefined after session_shutdown: no launches, no notices.
  let running: Set<ChildProcess> | undefined = new Set();
  let cleanup = Promise.resolve();

  function notify(outputPath: string, outcome: Outcome): void {
    const status = outcome.kind === "exit" ? `exited with code ${outcome.code}` : `terminated by signal ${outcome.signal}`;
    try {
      pi.sendMessage<Notice>(
        {
          customType: NOTICE_TYPE,
          content: `Command ${status}. Output file: ${outputPath}`,
          display: true,
          details: { outputPath, outcome },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } catch {
      // The runtime can be invalidated without session_shutdown, e.g. AgentSession.dispose().
    }
  }

  pi.registerTool({
    name: "run_and_notify",
    label: "Run and notify",
    description:
      "Run a shell command asynchronously in the current directory. Returns its PID and the path to a " +
      "private temporary file containing combined stdout/stderr. Completion sends a notice with the exit " +
      "code or signal and the same path—not command output. Commands must finish without leaving background " +
      "processes. They belong to this running Pi process; exit, reload, or session replacement may stop them. " +
      "Notices are best-effort.",
    promptSnippet: "Run a command asynchronously and get notified when it finishes",
    promptGuidelines: ["Do not poll for completion. Continue other work or end your turn to await the notice."],
    parameters: Parameters,
    outputSchema: Type.Object({
      outputPath: Type.String({ description: "Path to the file containing combined stdout and stderr" }),
      pid: Type.Integer({ description: "PID assigned to the launched shell; it may exit or be reused. Not a process-tree cancellation handle." }),
    }),
    async execute(_toolCallId, { command }, signal, _onUpdate, ctx) {
      const settings = pi.getSettings();
      const shell = getShellConfig(settings.shellPath ? shellPath(settings.shellPath) : undefined);
      if (shell.commandTransport === "stdin") throw new Error(`Unsupported shell: ${shell.shell}`);
      const prefix = settings.shellCommandPrefix;

      const dir = await mkdtemp(join(tmpdir(), "pi-run-"));
      const outputPath = join(dir, "output.log");
      let pid: number;
      try {
        const file = await open(outputPath, "wx", 0o600);
        try {
          const owner = running;
          if (signal?.aborted) throw new Error("Cancelled before launch");
          if (!owner) throw new Error("Session is shutting down");
          const child = spawn(shell.shell, [...shell.args, prefix ? `${prefix}\n${command}` : command], {
            cwd: ctx.cwd,
            detached: true,
            env: shellEnv(ctx),
            stdio: ["ignore", file.fd, file.fd],
          });
          owner.add(child);
          try {
            pid = await new Promise<number>((resolve, reject) => {
              child.on("error", reject);
              child.once("spawn", () => {
                // Attached synchronously so a fast exit cannot be missed.
                child.once("close", (code, exitSignal) => {
                  if (running?.delete(child)) {
                    // Node reports exactly one of code and signal.
                    notify(outputPath, exitSignal ? { kind: "signal", signal: exitSignal } : { kind: "exit", code: code ?? 1 });
                  }
                });
                resolve(child.pid!); // Node assigns the PID before emitting spawn.
              });
            });
          } catch (error) {
            owner.delete(child);
            throw error;
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
      return {
        content: [
          {
            type: "text",
            text: `Started. PID: ${pid}. Output file: ${outputPath}`,
          },
        ],
        details: { outputPath, pid },
        structuredContent: { outputPath, pid },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    if (running) {
      const children = [...running];
      running = undefined;
      cleanup = terminate(children);
    }
    await cleanup;
  });
}

// Keep group identities even if their shell exits on TERM: foreground children may still be alive.
// One grace period for all commands, not one per command. No wait for exit after best-effort KILL.
async function terminate(children: ChildProcess[]): Promise<void> {
  if (children.length === 0) return;
  for (const child of children) signalGroup(child, "SIGTERM");
  await delay(SHUTDOWN_GRACE_MS);
  for (const child of children) signalGroup(child, "SIGKILL");
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group already exited.
  }
}

// Match Pi's shellPath normalization on Unix without reloading its settings from disk.
function shellPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path.startsWith("file://") ? fileURLToPath(path) : path;
}

// Mirrors Pi's bash tool: Pi's bin directory on PATH and the current session's PI_* variables.
function shellEnv(ctx: ExtensionContext): NodeJS.ProcessEnv {
  const bin = join(getAgentDir(), "bin");
  const path = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: path.split(delimiter).includes(bin) ? path : [bin, path].filter(Boolean).join(delimiter),
    PI_SESSION_ID: ctx.sessionManager.getSessionId(),
    PI_SESSION_FILE: ctx.sessionManager.getSessionFile(),
    PI_PROVIDER: ctx.model?.provider,
    PI_MODEL: ctx.model?.id,
    PI_REASONING_LEVEL: ctx.thinkingLevel,
  };
}
