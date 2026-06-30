/**
 * Per-(conversation, subject) read state (ADR 0043 — resolves the Phase-3
 * read-state open question).
 *
 * Read markers are SEPARATE from the conversation meta on purpose. Originally
 * `markRead` rewrote the whole `ConversationMeta` (the participants array) to
 * stamp one participant's `lastReadAt` — which (a) races a concurrent
 * `addParticipant`/`removeParticipant` on the same record (last-write-wins could
 * silently drop a membership change or a read marker), and (b) is per-subject
 * high-cardinality state riding a per-conversation record. Splitting it out
 * removes the race and gives read state its own scaling axis (a future
 * per-message read position slots into the same record).
 *
 * The wire shape is unchanged: the route's `toConversation` projection joins a
 * subject's marker back into `participants[].lastReadAt`, so the frontend's
 * `isUnread` keeps reading the same field.
 *
 * Backed by the host-ext `DurableCollection`. NON-NORMATIVE (`/v1/host/openwop-app/*`).
 *
 * @see docs/adr/0043-persistent-conversations.md
 */

import { DurableCollection } from './hostExtPersistence.js';
import type { SubjectRef } from './conversationStore.js';

export interface ReadMarker {
  tenantId: string;
  conversationId: string;
  subjectRef: SubjectRef;
  /** ISO-8601 of the last message this subject has seen in the conversation. */
  lastReadAt: string;
}

// Key is `${tenant}:${conversationId}:${subjectRef}`. The conversationId matches
// `[A-Za-z0-9_-]` (no `:`), so the trailing `:` after it cleanly delimits the
// per-conversation prefix even when tenant/subjectRef contain colons (e.g.
// `anon:sid`, `user:<id>`). Keys are never parsed — the record carries its own
// ids — so internal colons are harmless to `listByPrefix`.
const markers = new DurableCollection<ReadMarker>(
  'chat:read-state',
  (m) => `${m.tenantId}:${m.conversationId}:${m.subjectRef}`,
);

export async function setReadMarker(tenantId: string, conversationId: string, subjectRef: SubjectRef, at: string): Promise<void> {
  await markers.put({ tenantId, conversationId, subjectRef, lastReadAt: at });
}

export async function getReadMarker(tenantId: string, conversationId: string, subjectRef: SubjectRef): Promise<ReadMarker | null> {
  return markers.get(`${tenantId}:${conversationId}:${subjectRef}`);
}

/** Every read marker for one conversation, indexed by subjectRef (for the
 *  single-conversation get/participants projection). */
export async function readMarkersOf(tenantId: string, conversationId: string): Promise<Map<SubjectRef, string>> {
  const rows = await markers.listByPrefix(`${tenantId}:${conversationId}:`);
  return new Map(rows.map((m) => [m.subjectRef, m.lastReadAt]));
}

/** All read markers for a tenant, indexed `conversationId → (subjectRef →
 *  lastReadAt)` — a single scan the list route joins onto every conversation
 *  header (mirrors how it batch-loads conversation metas), avoiding an N+1. */
export async function readMarkersByConversation(tenantId: string): Promise<Map<string, Map<SubjectRef, string>>> {
  const rows = await markers.listByPrefix(`${tenantId}:`);
  const out = new Map<string, Map<SubjectRef, string>>();
  for (const m of rows) {
    let bySubject = out.get(m.conversationId);
    if (!bySubject) { bySubject = new Map(); out.set(m.conversationId, bySubject); }
    bySubject.set(m.subjectRef, m.lastReadAt);
  }
  return out;
}

/** Cascade-delete a conversation's read markers (called when the conversation
 *  is removed). */
export async function deleteReadMarkersOf(tenantId: string, conversationId: string): Promise<void> {
  const rows = await markers.listByPrefix(`${tenantId}:${conversationId}:`);
  await Promise.all(rows.map((m) => markers.delete(`${m.tenantId}:${m.conversationId}:${m.subjectRef}`)));
}
