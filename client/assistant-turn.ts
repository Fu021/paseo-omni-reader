import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { markdownKind } from "../shared/contracts";
import { findFormulas } from "../shared/markdown-math";

export type AssistantReply = { text: string; messageId?: string };

export function assistantReplyKey({ messageId, text }: AssistantReply): string {
  return messageId ? `id:${messageId}` : `text:${text}`;
}

type AssistantTransformInput = Parameters<PluginTimelineTransformerContribution<"assistant_message">["transform"]>[0];

export function assistantReplacement({ item, phase }: AssistantTransformInput, plain: boolean) {
  return {
    items: [{
      type: "plugin" as const, kind: markdownKind, version: 1,
      data: {
        text: item.text,
        phase,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(plain ? { plain: true as const } : {}),
      },
    }],
  };
}

function canReplaceAssistant(text: string): boolean {
  return text.length <= 160_000 && Boolean(text.trim()) &&
    !/^ {0,3}(?:`{3,}|~{3,})\s*(?:ui|app)\b/m.test(text);
}

export function shouldReplaceAssistant(text: string): boolean {
  return canReplaceAssistant(text) &&
    (/(?:^|\n) {0,3}(?:`{3,}|~{3,})|\|[ \t]*:?-{2,}/.test(text) || findFormulas(text).length > 0);
}
