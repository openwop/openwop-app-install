/**
 * ADR 1040 D3 — display names for tool rows in the turn receipt, supplied by an
 * embed (`EmbeddedChatPanel` `toolLabels`). DISPLAY ONLY: the receipt's join key
 * (`agent.toolCalled.toolName`, `GET /chat/tool-effects`) never changes, and a
 * tool without a label shows its id, as before. A context, not a prop, so the
 * map does not have to be drilled through ConversationView → MessageFeed →
 * MessageBubble → TurnReceipt.
 */
import { createContext, useContext } from 'react';

export type ToolLabels = Readonly<Record<string, string>>;

export const ToolLabelsContext = createContext<ToolLabels | null>(null);

/** The label for `toolName`, or the name itself when none is set. */
export function useToolLabel(toolName: string): string {
  const labels = useContext(ToolLabelsContext);
  const label = labels && Object.prototype.hasOwnProperty.call(labels, toolName) ? labels[toolName] : undefined;
  return typeof label === 'string' && label.trim().length > 0 ? label : toolName;
}
