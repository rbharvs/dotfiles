import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { installBackgroundAgent } from "./core.ts";

const ThinkingLevel = StringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
  { description: "Thinking level for a new background-agent session. Omit to inherit the parent level." },
);

const AgentParameters = Type.Object(
  {
    prompt: Type.String({ minLength: 1, description: "Task or settled follow-up prompt" }),
    session: Type.Optional(Type.String({
      pattern: "^sub_[a-f0-9]{8}$",
      description: "Reusable session handle returned by an earlier background_agent call",
    })),
    model: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 256,
      description: "Exact provider/model-id for a new session. Omit to inherit the parent model.",
    })),
    thinking: Type.Optional(ThinkingLevel),
  },
  { additionalProperties: false },
);

const ResultParameters = Type.Object(
  {
    run_id: Type.String({
      pattern: "^run_[a-f0-9]{16}$",
      description: "Run ID from a completion notice",
    }),
  },
  { additionalProperties: false },
);

export default function backgroundAgentExtension(pi: ExtensionAPI): void {
  installBackgroundAgent(pi, { agent: AgentParameters, result: ResultParameters }, {
    outputLimits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
    truncateOutput: (content, limits) => truncateHead(content, limits),
  });
}
