import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKGROUND_AGENT_RESULT_TOOL_NAME,
  BACKGROUND_AGENT_TOOL_NAME,
  COMPLETION_MESSAGE_TYPE,
  installBackgroundAgent,
} from "../core.ts";
import { truncateOutput } from "./harness.mjs";

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

function renderContext(overrides = {}) {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

function register() {
  const tools = new Map();
  const messageRenderers = new Map();
  installBackgroundAgent({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMessageRenderer(type, renderer) { messageRenderers.set(type, renderer); },
  }, { agent: {}, result: {} }, {
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_WORKSPACE_ID: "w1",
      PI_BACKGROUND_AGENT_DEPTH: "0",
    },
    outputLimits: { maxBytes: 50 * 1024, maxLines: 2000 },
    truncateOutput,
  });
  return { tools, messageRenderers };
}

test("renders a launch as a three-line prompt preview", () => {
  const { tools } = register();
  const tool = tools.get(BACKGROUND_AGENT_TOOL_NAME);
  const prompt = [
    "Analyze completion notification and result retrieval semantics for the background agent.",
    "Inspect all relevant APIs and identify the smallest robust implementation.",
    "Explain concrete findings and preserve this final sentence only in the expanded rendering.",
  ].join(" ");
  const context = renderContext({
    args: { prompt, model: "openai/gpt-5.6-luna", thinking: "max" },
  });
  const call = tool.renderCall(context.args, theme, context);
  const acknowledgement = {
    content: [{ type: "text", text: "model-only launch acknowledgement with run_0000000000000001" }],
    details: {
      session: "sub_a1b2c3d4",
      runId: "run_0000000000000001",
      sessionName: "sidebar-layout",
      model: "openai/gpt-5.6-luna",
      thinking: "max",
      phase: "running",
    },
  };
  const renderedAcknowledgement = tool.renderResult(
    acknowledgement,
    { expanded: false, isPartial: false },
    theme,
    context,
  );

  const collapsed = call.render(64);
  assert.equal(collapsed.length, 5, "the header and spacer should be followed by three prompt lines");
  assert.equal(collapsed[0], "background_agent sidebar-layout (openai/gpt-5.6-luna:max)");
  assert.match(collapsed.at(-1), /…$/);
  assert.deepEqual(renderedAcknowledgement.render(64), []);
  assert.doesNotMatch(
    collapsed.join("\n"),
    /sub_a1b2c3d4|run_0000000000000001|acknowledgement/,
  );
  assert.equal(acknowledgement.content[0].text, "model-only launch acknowledgement with run_0000000000000001");

  const expandedContext = renderContext({ ...context, state: context.state, expanded: true });
  const expanded = tool.renderCall(expandedContext.args, theme, expandedContext).render(64).join("\n");
  assert.match(expanded, /final sentence only in the expanded rendering/);
});

test("renders result collection as an eight-line preview", () => {
  const { tools } = register();
  const tool = tools.get(BACKGROUND_AGENT_RESULT_TOOL_NAME);
  const context = renderContext({ args: { run_id: "run_0000000000000001" } });
  const call = tool.renderCall(context.args, theme, context);
  const body = Array.from({ length: 10 }, (_, index) => `Finding ${index + 1}`).join("\n");
  const result = {
    content: [{ type: "text", text: body }],
    details: {
      session: "sub_a1b2c3d4",
      runId: "run_0000000000000001",
      sessionName: "result-audit",
      model: "openai/gpt-5.6-luna",
      thinking: "max",
      phase: "succeeded",
    },
  };
  const collapsedResult = tool.renderResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    context,
  );

  assert.deepEqual(call.render(80), [
    "background_agent_result result-audit (openai/gpt-5.6-luna:max)",
  ]);
  const collapsed = collapsedResult.render(80);
  assert.equal(collapsed.length, 9, "the spacer should be followed by eight result lines");
  assert.match(collapsed.at(-1), /^Finding 8…$/);
  assert.doesNotMatch(
    [...call.render(80), ...collapsed].join("\n"),
    /sub_a1b2c3d4|run_0000000000000001/,
  );

  const expanded = tool.renderResult(
    result,
    { expanded: true, isPartial: false },
    theme,
    context,
  ).render(80).join("\n");
  assert.match(expanded, /Finding 10$/);
  assert.equal(result.content[0].text, body);
});

test("renders completion notices without hiding model-visible collection instructions", () => {
  const { messageRenderers } = register();
  const renderer = messageRenderers.get(COMPLETION_MESSAGE_TYPE);
  const message = {
    customType: COMPLETION_MESSAGE_TYPE,
    content: "Background agent sub_a1b2c3d4 completed. Call background_agent_result with {\"run_id\":\"run_0000000000000001\"} to retrieve the result.",
    display: true,
    details: {
      session: "sub_a1b2c3d4",
      runId: "run_0000000000000001",
      sessionName: "sidebar-layout",
      status: "completed",
    },
  };

  const component = renderer(message, { expanded: false, outputPad: 0 }, theme);
  assert.deepEqual(component.render(80), ["sidebar-layout completed"]);
  assert.match(message.content, /background_agent_result.*run_0000000000000001/);
});

test("falls back to the session handle when no semantic name is available", () => {
  const { tools, messageRenderers } = register();

  const launchContext = renderContext({
    args: {
      prompt: "Continue",
      session: "sub_a1b2c3d4",
      model: "openai/gpt-5.6-luna",
      thinking: "max",
    },
  });
  const launch = tools.get(BACKGROUND_AGENT_TOOL_NAME).renderCall(
    launchContext.args,
    theme,
    launchContext,
  );
  assert.equal(
    launch.render(80)[0],
    "background_agent sub_a1b2c3d4 (openai/gpt-5.6-luna:max)",
  );

  const resultContext = renderContext({ args: { run_id: "run_0000000000000001" } });
  const resultTool = tools.get(BACKGROUND_AGENT_RESULT_TOOL_NAME);
  const result = resultTool.renderCall(resultContext.args, theme, resultContext);
  resultTool.renderResult({
    content: [{ type: "text", text: "Done" }],
    details: {
      session: "sub_a1b2c3d4",
      runId: "run_0000000000000001",
      model: "openai/gpt-5.6-luna",
      thinking: "max",
      phase: "succeeded",
    },
  }, { expanded: false }, theme, resultContext);
  assert.deepEqual(result.render(80), [
    "background_agent_result sub_a1b2c3d4 (openai/gpt-5.6-luna:max)",
  ]);

  const completion = messageRenderers.get(COMPLETION_MESSAGE_TYPE)({
    customType: COMPLETION_MESSAGE_TYPE,
    content: "model-visible sub_a1b2c3d4 run_0000000000000001",
    details: { session: "sub_a1b2c3d4", runId: "run_0000000000000001", status: "completed" },
  }, {}, theme);
  assert.deepEqual(completion.render(80), ["sub_a1b2c3d4 completed"]);
});

test("shows tool errors in full even while tool output is collapsed", () => {
  const { tools } = register();
  const tool = tools.get(BACKGROUND_AGENT_TOOL_NAME);
  const context = renderContext({ args: { prompt: "Work" }, isError: true });
  const error = "Launch failed for sub_a1b2c3d4\nActionable run_0000000000000001 detail";
  const rendered = tool.renderResult(
    { content: [{ type: "text", text: error }] },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  assert.equal(rendered.render(80).join("\n"), `\n${error}`);
});
