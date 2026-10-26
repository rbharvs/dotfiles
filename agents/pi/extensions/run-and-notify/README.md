# Run and notify

`run_and_notify({ command })` starts a finite foreground shell command and returns
`{ outputPath, pid }`: the path of its combined stdout/stderr file and the PID
assigned to the launched shell. The path also correlates the completion notice.
Direct calls show a short launch acknowledgment; codemode returns these two fields,
not launch-message text or command output. The command uses the current working
directory, effective Pi `shellPath` and `shellCommandPrefix` settings, and Pi's
shell environment. Stdin is closed.

The PID is a transient OS identifier for inspection with ordinary tools. The shell
may exec another program, exit before inspection, or have its PID reused. Verify
identity before signaling. It is not a durable job ID or a process-tree cancellation
handle; for a command waiting on external work, it identifies only the local waiter.

The output file is private (`0600`, inside a unique `0700` OS temporary directory).
Both streams write directly to the same file descriptor; output is not buffered
in the extension or injected into the conversation. Use ordinary file tools to
inspect progress or retrieve results. Save important output elsewhere: these
files are ephemeral, not a durable result store. There is no automatic retention
or cleanup service.

## Completion and cancellation

A successful launch gets at most one completion-message submission, containing
its path and exit code or terminating signal. Launch failures are tool errors,
not completion notices; their temporary files are removed.

Completion uses Pi's native message handling:

```ts
pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
```

- A busy parent receives steering; an idle parent starts a turn, including after
  a foreground abort.
- Escape does not cancel launched commands or future completion notifications.
  It can discard a notice already queued in Pi. There is no acknowledgment,
  retry, or replay. The output path remains in the launch result.
- Fast completions can submit notices before the launch response is published,
  but Pi puts steering into model context after the tool batch's results.
- Same-session `/tree` navigation leaves commands running. Notices reach the
  currently active branch, not necessarily the launching branch.
- Exit, reload, and session replacement invalidate this extension runtime's
  delivery authority. Cleanup sends TERM to all owned process groups, waits one
  shared **300 ms** grace period, then attempts KILL, without waiting indefinitely
  for exit. Overlapping shutdowns await the same cleanup. Successful launches'
  output files are retained.

Cleanup and invalidation begin when Pi invokes this extension's shutdown handler.
Earlier shutdown handlers may delay that invocation. An abrupt process crash or
kill does not guarantee cleanup or notification delivery.

## Command contract

Commands must remain in the foreground and wait for their children. Do not
background or daemonize work, or launch ongoing servers/watchers. Detached or
escaped descendants may outlive cleanup or keep writing after a notice. Cleanup
is best effort; it does not undo filesystem changes or guarantee a clean worktree.
There is no timeout, disk quota, crash durability, or retained-results registry.
The implementation targets Unix process groups (the macOS baseline).

Continue other useful work after launching; otherwise end the turn and let the
notice wake Pi. Do not poll for completion.

## Pi process lifetime

The parent Pi process must remain alive to own commands and receive notices.
Interactive and RPC parents can end a turn without exiting; a print-mode parent
exits after its turn and shuts down commands still running. Returning a waiting
message does not keep a print-mode parent alive.

A child `pi --print` is appropriate for a one-shot task: its exit can be observed
by this tool. Use a long-lived RPC child only when ongoing programmatic control
is needed, not merely to receive a completion notice. Native persisted sessions
allow later invocations to resume a child after its previous process exits.
See the [Pi delegation skill](../../../skills/pi-delegation/SKILL.md) for the small
CLI recipe, mode selection, and model/context boundaries. Native `/name` and
`--name` replace the removed automatic naming extension.

## Tests

From the extension package directory, run its normal `npm test` and
`npm run typecheck`, or the repository's Nix checks. The six integration tests use
real Pi sessions with an in-process fake provider and real subprocess/file I/O:

1. Concurrent outcomes, fast-completion context ordering, effective settings,
   closed stdin, private mixed/large output, and no output injection.
2. Direct and real codemode launches returning the output path and a live shell PID.
3. Table-driven launch failures with no execution, notice, or leftover directory.
4. Escape clearing a queued notice, and a surviving command later waking Pi.
5. Overlapping shutdowns both awaiting cleanup of a TERM-resistant process.
6. Reload cleanup, including a foreground child surviving its shell's TERM exit,
   a shared grace period, retained files, and a usable replacement runtime.

Process barriers use FIFOs and events. Fixture safety deadlines and test timeouts
bound failures; they do not synchronize successful execution. Types distinguish
exit codes from signals; launch errors are not modeled as completion outcomes.
