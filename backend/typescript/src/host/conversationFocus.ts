/**
 * ADR 0777 — the ONE way a tool reads an embedded conversation's focus.
 *
 * Mirrors `resolveNotebookId` (features/notebooks/agentTools.ts): an explicit id
 * from the model wins; otherwise the conversation's server-set focus of the
 * requested kind. It returns an ID, never a grant — the calling tool MUST still
 * apply its own access predicate to it (e.g. `getCanvasForCaller`), so a stale
 * focus (the caller lost access since) reads nothing.
 */
import type { BundleScope } from './inMemorySurfaces.js';
import { getConversationMeta, type ConversationFocus } from './conversationStore.js';
import { getCanvasForCaller } from './canvasSurface.js';

/** May `callerUserId` READ the canvas a focus would name? THE shared canvas
 *  predicate (ADR 0768 Phase 0) — the same one every canvas tool re-applies. */
export async function focusReadable(tenantId: string, focus: ConversationFocus, callerUserId: string): Promise<boolean> {
  return (await getCanvasForCaller(tenantId, focus.id, { subject: callerUserId })) !== null;
}

export async function resolveFocusedId(
  scope: Pick<BundleScope, 'tenantId' | 'conversationId'>,
  kind: ConversationFocus['kind'],
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) return explicit;
  if (!scope.conversationId) return undefined;
  const focus = (await getConversationMeta(scope.tenantId, scope.conversationId))?.focus;
  return focus?.kind === kind ? focus.id : undefined;
}
