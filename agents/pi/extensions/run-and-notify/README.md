# Run and notify

`run_and_notify({ command })` starts a finite foreground shell command and returns
`{ output }`: the path of its combined stdout/stderr file. The path also identifies
the command. The command uses the current working directory, effective Pi
`shellPath` and `shellCommandPrefix` settings, and Pi's shell environment.
Stdin is closed.

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
  for exit. Successful launches' output files are retained.

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
notice wake Pi. Do not sleep or poll for completion. The parent Pi runtime must
remain alive to own the command: print-mode parents exit after their turn and
cannot host work indefinitely.

For delegation, use native CLI/session functionality, for example:

```sh
pi --print --session-id <unique-id> --name reviewer 'Review the changes'
```

Use native transcript files for inspection and resume only after the previous
process exits. The caller owns session IDs, model selection, trust, retries,
follow-ups, output retention, and any explicit cancellation with ordinary tools.
Native `/name` and `--name` replace the removed automatic naming extension.

## Tests

From the extension package directory, run its normal `npm test` and
`npm run typecheck`, or the repository's Nix checks. The four integration tests use
real Pi sessions with an in-process fake provider and real subprocess/file I/O:

1. Concurrent outcomes, fast-completion context ordering, effective settings,
   closed stdin, private mixed/large output, and no output injection.
2. Table-driven launch failures with no execution, notice, or leftover directory.
3. Escape clearing a queued notice, and a surviving command later waking Pi.
4. Reload cleanup, including a foreground child surviving its shell's TERM exit,
   a shared grace period, retained files, and a usable replacement runtime.

Process barriers use FIFOs and events. Fixture safety deadlines and test timeouts
bound failures; they do not synchronize successful execution. Types distinguish
exit codes from signals; launch errors are not modeled as completion outcomes.
