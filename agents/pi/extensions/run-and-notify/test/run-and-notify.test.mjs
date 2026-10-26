import assert from "node:assert/strict";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { done, fifo, holders, startSession } from "./harness.mjs";

const run = (id, command) => fauxToolCall("run_and_notify", { command }, { id });
const batch = (...calls) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const MiB = 1024 * 1024;

test("concurrent launches: results precede notices; outcomes, environment, and private output files", { timeout: 10000 }, async (t) => {
  let h;
  const quick = 5;
  h = await startSession(t, {
    settings: { shellCommandPrefix: "greet() { echo hi-from-prefix; }" },
    // Holds the tool batch open until every command has exited and been submitted.
    gate: () => h.submittedCount(quick),
    responses: [
      batch(
        run("mixed", "printf out; printf err >&2; printf out2"),
        run("nonzero", "exit 7"),
        run("signal", "kill -TERM $$"),
        run("large", `yes "$(printf MAR%sER K)" | head -c ${32 * MiB}`),
        run("env", 'pwd; echo "sid=$PI_SESSION_ID"; read -r line; echo "stdin=$?"; greet; echo "path=$PATH"'),
        fauxToolCall("gate", {}, { id: "gate" }),
      ),
      ...Array.from({ length: quick }, () => done()),
    ],
  });
  await h.session.prompt("go");
  await h.session.waitForIdle();

  const expected = {
    mixed: { kind: "exit", code: 0 },
    nonzero: { kind: "exit", code: 7 },
    signal: { kind: "signal", signal: "SIGTERM" },
    large: { kind: "exit", code: 0 },
    env: { kind: "exit", code: 0 },
  };
  assert.equal(h.submissions.length, quick, "exactly one submission per command");
  const entries = h.entries();
  const lastResult = entries.findLastIndex((e) => e.type === "message" && e.message.role === "toolResult");
  for (const [id, outcome] of Object.entries(expected)) {
    const output = h.outputOf(id);
    assert.ok(output.startsWith(h.tmp), "output lives under the OS temporary directory");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(output))).mode & 0o777, 0o700);
    const notices = h.notices().filter((n) => n.details.output === output);
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0].details.outcome, outcome);
    assert.ok(entries.indexOf(notices[0]) > lastResult, "notice follows every launch result of the batch");
  }
  // Steering, not follow-up: the first notice enters before the next assistant response.
  const assistants = entries.filter((e) => e.type === "message" && e.message.role === "assistant");
  assert.ok(entries.indexOf(h.notices()[0]) < entries.indexOf(assistants[1]));
  // Every notice reached a later model request (Pi's steering mode decides how many per request).
  const seen = JSON.stringify(h.contexts.at(-1).messages);
  for (const id of Object.keys(expected)) assert.ok(seen.includes(h.outputOf(id)));

  assert.equal(await readFile(h.outputOf("mixed"), "utf8"), "outerrout2");
  assert.equal((await stat(h.outputOf("large"))).size, 32 * MiB);
  assert.ok(!JSON.stringify(entries).includes("MARKER"), "output is never injected into the session");
  const env = await readFile(h.outputOf("env"), "utf8");
  assert.equal(await realpath(env.split("\n")[0]), await realpath(h.cwd));
  assert.match(env, new RegExp(`sid=${h.session.sessionManager.getSessionId()}\n`));
  assert.match(env, /stdin=1\nhi-from-prefix\n/);
  assert.ok(env.includes(join(h.agentDir, "bin")));
});

test("launch failures report an error, run nothing, notify nothing, and leave no output directory", { timeout: 10000 }, async (t) => {
  const cases = {
    "output directory cannot be created": async (h) => {
      const notADirectory = join(h.root, "file");
      await writeFile(notADirectory, "");
      process.env.TMPDIR = notADirectory;
    },
    "shell cannot be executed": async (h) => {
      const shell = join(h.root, "not-executable");
      await writeFile(shell, "#!/bin/sh\n", { mode: 0o644 });
      h.settingsManager.applyOverrides({ shellPath: shell });
    },
  };
  for (const [name, breakLaunch] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      let marker;
      const h = await startSession(t, {
        responses: [(context) => batch(run("cmd", `touch ${marker}`)), done()],
      });
      marker = join(h.root, "ran");
      await breakLaunch(h);
      await h.session.prompt("go");
      await h.session.waitForIdle();
      const [result] = h.toolResults;
      assert.equal(result.isError, true);
      await assert.rejects(stat(marker), { code: "ENOENT" });
      assert.equal(h.submissions.length, 0);
      assert.deepEqual((await readdir(h.tmp)).filter((f) => f.startsWith("pi-run-")), []);
    });
  }
});

test("Escape leaves commands running: a cleared queued notice is not replayed; a later exit wakes the idle session", { timeout: 10000 }, async (t) => {
  let h, escape;
  const pressedEscape = new Promise((resolve) => { escape = resolve; });
  const releaseA = () => writeFile(join(h.root, "a"), "go\n");
  h = await startSession(t, {
    responses: [
      (context) => batch(run("A", `read -r _ < ${join(h.root, "a")}; echo A-done`), run("B", `read -r _ < ${join(h.root, "b")}; echo B-done`)),
      // A busy turn: A exits and is submitted as steering, then the user presses Escape.
      async (context, options) => {
        await releaseA();
        await h.submittedCount(1);
        escape();
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        return fauxAssistantMessage("stopped", { stopReason: "aborted" });
      },
      done("handled B"),
    ],
  });
  fifo(join(h.root, "a"));
  fifo(join(h.root, "b"));
  const prompt = h.session.prompt("go");
  await pressedEscape;
  h.session.clearQueue(); // Interactive Escape: restoreQueuedMessagesToEditor({ abort: true })
  await h.session.abort();
  await prompt;

  assert.equal(h.submissions.length, 1, "A was submitted once");
  assert.equal(h.notices().length, 0, "Escape discarded A's queued notice (accepted limitation)");
  assert.equal(await readFile(h.outputOf("A"), "utf8"), "A-done\n");

  await writeFile(join(h.root, "b"), "go\n");
  await h.submittedCount(2);
  await h.session.waitForIdle();
  assert.equal(h.submissions.length, 2, "no replay of A");
  assert.deepEqual(h.notices().map((n) => n.details.output), [h.outputOf("B")]);
  assert.equal(h.faux.state.callCount, 3, "B's notice started a new turn after the aborted one");
  assert.ok(JSON.stringify(h.contexts[2].messages).includes(h.outputOf("B")));
  assert.equal(await readFile(h.outputOf("B"), "utf8"), "B-done\n");
});

test("reload terminates process groups in parallel even after shell exit; logs survive and the new runtime works", { timeout: 10000 }, async (t) => {
  let h;
  const alive = (name) => join(h.root, name);
  const fixture = (name, cooperative, exec) => {
    // A safety deadline prevents a broken cleanup implementation from leaking fixtures indefinitely.
    const script = `const fs = require("node:fs");
      process.on("SIGTERM", () => { ${cooperative ? 'fs.writeSync(3, "term\\n"); process.exit(0);' : ""} });
      setTimeout(() => process.exit(99), 5000);
      fs.writeSync(3, "up\\n");`;
    return `exec 3>${alive(name)}; ${exec ? "exec " : ""}${shellQuote(process.execPath)} -e ${shellQuote(script)}${exec ? "" : " & wait $!"}`;
  };
  h = await startSession(t, {
    responses: [
      (context) => batch(
        run("polite", fixture("polite", true, true)),
        run("stubborn", fixture("stubborn", false, true)),
        // The shell exits on TERM while its foreground-owned child ignores it.
        run("descendant", fixture("descendant", false, false)),
      ),
      done("launched"),
      batch(run("after", "echo after")),
      done("after"),
    ],
  });
  const polite = holders(fifo(alive("polite")));
  const stubborn = holders(fifo(alive("stubborn")));
  const descendant = holders(fifo(alive("descendant")));
  await h.session.prompt("go");
  await Promise.all([polite.saw("up"), stubborn.saw("up"), descendant.saw("up")]);

  const started = performance.now();
  await h.session.reload();
  const [politeOutput, stubbornOutput, descendantOutput] = await Promise.all([polite.ended, stubborn.ended, descendant.ended]);
  const elapsed = performance.now() - started;
  assert.equal(politeOutput, "up\nterm\n", "TERM reached the polite command first");
  assert.equal(stubbornOutput, "up\n", "the stubborn group was killed");
  assert.equal(descendantOutput, "up\n", "the child was killed even though its shell already exited");
  // The grace is 300 ms; allow scheduler/loader overhead rather than asserting an exact duration.
  // This still catches the old two-second grace and survivors reaching the fixture safety deadline.
  assert.ok(elapsed < 1500, `cleanup and reload were bounded (${Math.round(elapsed)} ms)`);
  assert.equal(h.submissions.length, 0);
  await stat(h.outputOf("polite"));

  await h.session.prompt("again");
  await h.submittedCount(1);
  await h.session.waitForIdle();
  assert.equal(h.submissions[0].runtime, 2);
  assert.deepEqual(h.notices().map((n) => n.details.output), [h.outputOf("after")]);
});
