/**
 * ADR 1125 D3 — what the inbox card shows and which rows it may silence or
 * collapse. Pure, so the rules are tested without rendering the page.
 */
import type { Notification } from './types.js';
import { isActionNeeded } from './types.js';

/** A request is anything that asks a person (an interrupt, an action-needed
 *  type) or did ask and is now finished (ADR 1114 resolution). Requests never
 *  collapse: each is its own decision. */
export function isRequest(n: Notification, featureTypes?: ReadonlySet<string>): boolean {
  return Boolean(n.interruptId) || Boolean(n.metadata?.resolution) || isActionNeeded(n, featureTypes);
}

/** An open request still waits on someone. It cannot be archived or deleted from
 *  the inbox (menu, `e`, bulk archive-read) until it is decided or ended. */
export function isOpenRequest(n: Notification, featureTypes?: ReadonlySet<string>): boolean {
  return isActionNeeded(n, featureTypes);
}

/** The asker the host stamped (ADR 1125 D2, `metadata.asker`): a workflow's
 *  name, never a person or an id. Older rows have none. */
export function askerOf(n: Notification): string | undefined {
  const a = n.metadata?.asker;
  if (typeof a !== 'string') return undefined;
  const s = a.trim();
  return s ? s.slice(0, 80) : undefined;
}

export type RequestReason = { kind: 'named' } | { kind: 'role'; role: string };

/** Why it came to this person (ADR 1125 D5, `metadata.reason`): a closed,
 *  host-written shape. Anything else reads as no reason. */
export function reasonOf(n: Notification): RequestReason | undefined {
  const r = n.metadata?.reason as { kind?: unknown; role?: unknown } | undefined;
  if (r?.kind === 'named') return { kind: 'named' };
  if (r?.kind === 'role' && typeof r.role === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(r.role)) return { kind: 'role', role: r.role };
  return undefined;
}

export interface CardGroup {
  /** Stable for expand state: the head row's id. */
  key: string;
  head: Notification;
  /** Identical news after the head, newest first. Always empty for a request. */
  rest: Notification[];
}

/** News with the same type, title and asker collapse into one card, in the
 *  order the list already has (the head is the first, i.e. newest, row).
 *  Requests stay one card each. */
export function groupCards(list: readonly Notification[], featureTypes?: ReadonlySet<string>): CardGroup[] {
  const groups: CardGroup[] = [];
  const byKey = new Map<string, CardGroup>();
  for (const n of list) {
    if (isRequest(n, featureTypes)) {
      groups.push({ key: n.notificationId, head: n, rest: [] });
      continue;
    }
    const k = `${n.type}\u0000${n.title}\u0000${askerOf(n) ?? ''}`;
    const g = byKey.get(k);
    if (g) { g.rest.push(n); continue; }
    const created: CardGroup = { key: n.notificationId, head: n, rest: [] };
    byKey.set(k, created);
    groups.push(created);
  }
  return groups;
}
