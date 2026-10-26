---
name: pi-delegation
description: Launch Pi subagents with the native CLI, resume child sessions, and choose between print, JSON, and RPC modes. Use when asked to run or coordinate a subagent with Pi, or when choosing a Pi subprocess mode. Does not decide when to delegate.
---

# Pi delegation

A Pi subagent is an ordinary Pi process with its own conversation. Use the native
CLI; no delegation extension or terminal multiplexer is required. Check `pi --help`
and the installed Pi docs when you need details beyond this recipe.

## One-shot tasks and follow-ups

Choose a unique child session ID before launch and retain it. Replace `$child_id`
below with that ID, or set it in the same shell command:

```sh
pi --print --session-id "$child_id" --name reviewer 'Review the changes'
```

Run this command through `run_and_notify` when the parent should continue working
or await an asynchronous completion notice. After the notice, read `outputPath`;
it contains the child's final response and any diagnostics, not its full transcript.
A zero exit code is not proof that the requested work was completed correctly.
Use ordinary session files to inspect the full conversation.

To follow up, invoke `pi --print --session-id "$child_id" 'Follow-up task'` after
the previous process exits. Never run two processes against the same session at
once. Avoid `--continue`: it may select an unrelated recent session. Use
`--no-session` instead when neither persistence nor follow-ups are wanted.

Children do not inherit the parent's conversation, model overrides, tool selection,
or trust decision. Supply the task, relevant paths, scope, and constraints in the
prompt. They load their own configuration and context for their working directory.
Choose model and reasoning explicitly when they matter; to match a Pi caller's
shell environment, add:

```sh
--model "$PI_PROVIDER/$PI_MODEL" --thinking "$PI_REASONING_LEVEL"
```

Use CLI tool/resource and trust flags when the task needs them. A fresh session
is not a filesystem or security sandbox; parallel edits still need isolation.

## Choose the process mode

- **Print:** one-shot final text. Usually enough for a child task, including a
  follow-up through a new invocation of a persisted session.
- **JSON:** one-shot structured progress events. Like print, it exits afterward.
- **RPC:** ongoing programmatic control over JSONL stdin/stdout. Use when the
  caller needs to send work, steer, abort, or inspect state while the process lives.
  Read the installed RPC docs before implementing a client.
- **Interactive:** a person or an explicitly requested terminal workflow needs a UI.

Keep the **parent** alive when it owns asynchronous commands. An interactive or
RPC parent can end a turn and later wake on a completion notice. A print/JSON
parent exits after its run; ending its turn to wait may stop unfinished commands.

`run_and_notify` closes stdin, so it cannot itself provide a live RPC input channel.
If RPC is needed, run a foreground client that owns the child and its pipes.
Otherwise prefer the direct CLI invocation above. Use the Herdr skill only when
Herdr was explicitly requested.
