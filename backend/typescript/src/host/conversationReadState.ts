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
 * ADR 0192 D6 — the marker now ALSO carries the two-tier unread signal:
 *   - `readMessageCount`: the session's `messageCount` at the moment of
 *     `markRead`. Unread = `messageCount − readMessageCount`, derived at the
 *     existing projection join — EXACT and race-free with ZERO append-time
 *     writes (`message_count` is bumped atomically inside the append
 *     transaction already).
 *   - `mentionCount`: bumped at append time ONLY for actually-mentioned
 *     participants (`@channel` today), via compare-and-swap with bounded
 *     retry. Race posture, stated exactly: a bump that loses its CAS to a
 *     concurrent write RETRIES (bumps aren't lost to each other); a bump that
 *     lands between a markRead's get and put IS zeroed by that markRead's
 *     unconditional write — an accepted, self-healing window (the counter is
 *     a signal, not an audit record). `readMessageCount` is written
 *     monotonically (max), so a stale concurrent markRead can never regress
 *     the unread differencing.
 *
 * The wire shape is additive: the route's projection joins the marker back
 * into `participants[].lastReadAt` (+ the new counter fields), so the
 * frontend's `isUnread` keeps reading the same field.
 *
 * Backed by the host-ext `DurableCollection`. NON-NORMATIVE (`/v1/host/openwop-app/*`).
 *
 * @see docs/adr/0043-persistent-conversations.md
 * @see docs/adr/0192-channels-ux-identity-parity.md
 */

import { DurableCollection } from './hostExtPersistence.js';
import type { SubjectRef } from './conversationStore.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';

export interface ReadMarker {
  tenantId: string;
  conversationId: string;
  subjectRef: SubjectRef;
  /** ISO-8601 of the last message this subject has seen in the conversation.
   *  OPTIONAL since ADR 0192: a mention bump may create a marker for a subject
   *  who has never read (counter-only marker) — projections must not join an
   *  absent value over the meta's transition fallback. */
  lastReadAt?: string;
  /** ADR 0192 D6 — the session `messageCount` at the last `markRead`. */
  readMessageCount?: number;
  /** ADR 0192 D6 — unseen mentions addressed to this subject; zeroed on read. */
  mentionCount?: number;
}

/** The per-subject view the projections join (everything but the key). */
export interface ReadMarkerView {
  lastReadAt?: string;
  readMessageCount?: number;
  mentionCount?: number;
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

/** Mention counters cap here (the rail renders "99+"); keeps a hot channel from
 *  growing an unbounded int and bounds CAS-retry churn on pathological floods. */
const MENTION_CAP = 99;

export async function setReadMarker(
  tenantId: string,
  conversationId: string,
  subjectRef: SubjectRef,
  at: string,
  /** The session's messageCount at read time (ADR 0192 D6) — omitted by legacy
   *  callers, in which case only `lastReadAt` advances. */
  readMessageCount?: number,
): Promise<void> {
  const key = `${tenantId}:${conversationId}:${subjectRef}`;
  const existing = await markers.get(key);
  // MONOTONIC: two tabs marking read concurrently must not let the one holding
  // a staler messageCount regress the stamp (phantom unread until next read).
  const nextCount = readMessageCount !== undefined
    ? Math.max(existing?.readMessageCount ?? 0, readMessageCount)
    : existing?.readMessageCount;
  await markers.put({
    tenantId, conversationId, subjectRef, lastReadAt: at,
    ...(nextCount !== undefined ? { readMessageCount: nextCount } : {}),
    // markRead clears the mention tier — the subject has seen the room.
    mentionCount: 0,
  });
}

export async function getReadMarker(tenantId: string, conversationId: string, subjectRef: SubjectRef): Promise<ReadMarker | null> {
  return markers.get(`${tenantId}:${conversationId}:${subjectRef}`);
}

/** ADR 0192 D6 — bump the unseen-mention counter for each subject, CAS with
 *  bounded retry so concurrent bumps (and a racing `markRead`) don't lose
 *  writes. Best-effort: after the retries the bump is dropped (the counter is
 *  a signal, not an audit record). */
export async function bumpMentionCounts(tenantId: string, conversationId: string, subjectRefs: readonly SubjectRef[]): Promise<void> {
  await Promise.all(subjectRefs.map(async (subjectRef) => {
    const key = `${tenantId}:${conversationId}:${subjectRef}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await markers.get(key);
      const next: ReadMarker = existing
        ? { ...existing, mentionCount: Math.min(MENTION_CAP, (existing.mentionCount ?? 0) + 1) }
        : { tenantId, conversationId, subjectRef, mentionCount: 1 };
      if (await markers.compareAndSwap(existing, next)) return;
    }
  }));
}

function viewOf(m: ReadMarker): ReadMarkerView {
  return {
    ...(m.lastReadAt !== undefined ? { lastReadAt: m.lastReadAt } : {}),
    ...(m.readMessageCount !== undefined ? { readMessageCount: m.readMessageCount } : {}),
    ...(m.mentionCount !== undefined ? { mentionCount: m.mentionCount } : {}),
  };
}

/** Every read marker for one conversation, indexed by subjectRef (for the
 *  single-conversation get/participants projection). */
export async function readMarkersOf(tenantId: string, conversationId: string): Promise<Map<SubjectRef, ReadMarkerView>> {
  const rows = await markers.listByPrefix(`${tenantId}:${conversationId}:`);
  return new Map(rows.map((m) => [m.subjectRef, viewOf(m)]));
}

/** All read markers for a tenant, indexed `conversationId → (subjectRef →
 *  view)` — a single scan the list route joins onto every conversation
 *  header (mirrors how it batch-loads conversation metas), avoiding an N+1. */
export async function readMarkersByConversation(tenantId: string): Promise<Map<string, Map<SubjectRef, ReadMarkerView>>> {
  const rows = await markers.listByPrefix(`${tenantId}:`);
  const out = new Map<string, Map<SubjectRef, ReadMarkerView>>();
  for (const m of rows) {
    let bySubject = out.get(m.conversationId);
    if (!bySubject) { bySubject = new Map(); out.set(m.conversationId, bySubject); }
    bySubject.set(m.subjectRef, viewOf(m));
  }
  return out;
}

/** Cascade-delete a conversation's read markers (called when the conversation
 *  is removed). */
export async function deleteReadMarkersOf(tenantId: string, conversationId: string): Promise<void> {
  const rows = await markers.listByPrefix(`${tenantId}:${conversationId}:`);
  await Promise.all(rows.map((m) => markers.delete(`${m.tenantId}:${m.conversationId}:${m.subjectRef}`)));
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// A read marker records where a PARTICULAR subject has read to — it is that
// subject's OWN state, keyed by their `user:<id>` subjectRef. A DSAR DELETES the
// subject's markers across every conversation (the taxonomy's "read-state
// authored by them → delete"), leaving other participants' markers — and the
// conversations themselves — untouched. Tenant-scoped prefix scan; idempotent.

/** DSAR eraser — drop every read marker authored by the subject, tenant-wide. */
export async function eraseSubjectReadState(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const m of await markers.listByPrefix(`${tenantId}:`)) {
    if (forms.has(m.subjectRef)) await markers.delete(`${m.tenantId}:${m.conversationId}:${m.subjectRef}`);
  }
}

/** Register the read-state DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerReadStateErasure(): void {
  registerSubjectEraser(eraseSubjectReadState);
}

/** ADR 0288 P2 — drop every read marker for a DELETED conversation (direct call
 *  from the chat delete route). Bounded prefix scan; idempotent. */
export async function deleteReadStateForConversation(tenantId: string, conversationId: string): Promise<number> {
  let n = 0;
  for (const m of await markers.listByPrefix(`${tenantId}:${conversationId}:`)) {
    await markers.delete(`${m.tenantId}:${m.conversationId}:${m.subjectRef}`);
    n += 1;
  }
  return n;
}
