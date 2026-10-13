import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { installSessionNaming } from "./core.ts";

export default function sessionNamingExtension(pi: ExtensionAPI): void {
  installSessionNaming(pi, {
    serializeContext(messages) {
      return serializeConversation(convertToLlm(messages));
    },
  });
}
