import assert from "node:assert/strict";
import test from "node:test";
import installStatusline from "../statusline.ts";

function usage(cost, input = 100, cacheRead = 0, cacheWrite = 0) {
  return {
    input, output: 10, cacheRead, cacheWrite,
    totalTokens: input + 10 + cacheRead + cacheWrite,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function footer(t, { entries = [], context = { tokens: 200_000, contextWindow: 1_050_000, percent: 200 / 1050 * 100 } } = {}) {
  const handlers = new Map();
  const colors = [];
  let factory;
  let unsubscribed = false;
  installStatusline({
    on: (event, handler) => handlers.set(event, handler),
    getThinkingLevel: () => "high",
    exec: async (command, args) => {
      assert.equal(command, "gh");
      assert.deepEqual(args, ["pr", "view", "--json", "number,state,reviewDecision,isDraft"]);
      return { code: 1, stdout: "", stderr: "no pull request" };
    },
  });
  handlers.get("session_start")({}, {
    mode: "tui", cwd: "/repo/example-project",
    model: { name: "Test model", contextWindow: 1_050_000 },
    getContextUsage: () => context,
    sessionManager: { getEntries: () => entries },
    ui: { setFooter: (value) => { factory = value; } },
  });
  const component = factory(
    { requestRender() {} },
    { fg: (color, text) => { colors.push({ color, text }); return text; } },
    {
      getGitBranch: () => "main",
      onBranchChange: () => () => { unsubscribed = true; },
    },
  );
  t.after(() => {
    component.dispose();
    assert.equal(unsubscribed, true);
  });
  return { render: () => component.render(200).join("\n"), colors };
}

test("counts all session usage once without replacing the assistant cache-hit rate", (t) => {
  const entries = [
    { type: "message", message: { role: "assistant", usage: usage(1, 25, 75) } },
    { type: "message", message: { role: "toolResult", usage: usage(2) } },
    { type: "compaction", usage: usage(4) },
    { type: "branch_summary", usage: usage(8) },
    { type: "usage", kind: "cache_warm", usage: usage(16, 0, 100) },
    { type: "usage", kind: "future_kind", usage: usage(32) },
    { type: "message", message: { role: "user", content: "ignored" } },
    { type: "message", message: { role: "toolResult" } },
  ];
  const result = footer(t, { entries }).render();
  assert.match(result, /\$63\.000/);
  assert.match(result, /CH75\.0%/);
});

for (const [tokens, contextWindow, percent, color, text] of [
  [99_999, 1_000_000, 9.9999, "muted", "100k/1M"],
  [100_000, 1_000_000, 10, "warning", "100k/1M"],
  [199_999, 1_000_000, 19.9999, "warning", "200k/1M"],
  [200_000, 1_000_000, 20, "error", "200k/1M"],
  [200_000, 1_050_000, 200 / 1050 * 100, "error", "200k/1.1M"],
  [95_000, 100_000, 95, "muted", "95k/100k"],
  [100_000, 1_000_000, null, "warning", "100k/1M"],
  [null, 1_000_000, null, "muted", "-/1M"],
]) {
  test(`context ${tokens ?? "unknown"}/${contextWindow} tokens (${percent ?? "unknown"}%) uses ${color}`, (t) => {
    const view = footer(t, { context: { tokens, contextWindow, percent } });
    assert.ok(view.render().includes(text));
    assert.deepEqual(view.colors.find((item) => item.text === text), { color, text });
  });
}
