/**
 * ADR 0768 B4 — what a turn inside a shell may ask of that shell's Workbench,
 * without drilling a callback through ConversationView → MessageFeed →
 * MessageBubble. Only the two shells that HAVE a Workbench provide it; an embed
 * provides nothing, so a receipt there never offers a pane that does not exist.
 */
import { createContext, useContext } from 'react';

export interface WorkbenchActions { openSources: () => void }
export const WorkbenchActionsContext = createContext<WorkbenchActions | null>(null);
export const useWorkbenchActions = (): WorkbenchActions | null => useContext(WorkbenchActionsContext);
