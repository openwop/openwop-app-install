/**
 * Shared agents-tab UI bits (GAP-ANALYSIS E9). `slugify` keeps the persona-slug
 * rule in one home. (The former `EmptyBlock` — a one-off inline-styled empty
 * block — was retired in favour of the shared `ui/StateCard` / `ui/Notice`
 * primitives; its last consumer, AgentDetailPage, now uses those directly.)
 */

/** Slug helper — keeps the list view's row chip aligned with the chat picker's
 *  `@persona-slug` rendering. Kept out of `chat/lib/agentMentions.ts` so the
 *  agents tab graph doesn't pull in the chat module. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  );
}
