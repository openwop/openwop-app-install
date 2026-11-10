/**
 * ADR 1042 (review round 3) — "is this chat session a channel-ingress thread?"
 *
 * A channel conversation holds outsiders' words. Core routes that would copy that
 * history into, or re-bind it to, an ordinary conversation (re-binding the session
 * to a fresh run, branching it) and core tools that would surface it to a
 * full-tools turn (conversation search, run diagnosis) refuse when this says yes.
 * Dependency inversion: the channel-ingress feature registers the check; core never
 * imports it. With the feature absent, nothing is a channel conversation.
 */
type Check = (tenantId: string, conversationId: string) => Promise<boolean>;
let check: Check | null = null;

export function registerChannelConversationCheck(fn: Check | null): void {
  check = fn;
}

/** False when no check is registered (the channel-ingress feature is absent, so no
 *  channel conversation exists). Fails closed only when the registered check throws:
 *  an unreadable marker then counts as a channel conversation. */
export async function isChannelIngressConversation(tenantId: string, conversationId: string): Promise<boolean> {
  if (!check) return false;
  try { return await check(tenantId, conversationId); } catch { return true; }
}

/** A run that a channel conversation rode (stamped at creation by channel-ingress). */
export function isChannelIngressRun(run: { metadata?: Record<string, unknown> | null | undefined }): boolean {
  return run.metadata?.['channelIngress'] !== undefined;
}
