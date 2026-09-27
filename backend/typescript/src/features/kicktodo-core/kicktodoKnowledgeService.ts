/**
 * KickBot knowledge (ADR 0442 P3; PRD §6.8) — a managed KB collection that
 * grounds KickBot's chat in the tenant's PUBLISHED challenge content + a static
 * product-guidance doc, so "what's this challenge about / how does KickTodo
 * work" answers over RAG instead of being invented. Thin composition over
 * `kbService` (ADR 0011) — the `profilesKnowledgeService` / `docsKnowledgeService`
 * precedent: no new store, no vector surface, no parallel KB.
 *
 * Design (mirrors the profiles-KB correction to ADR 0172):
 *  - Challenges are TENANT-scoped with no org (challengeService), and KickBot
 *    provisioning is tenant-scoped too — so the collection is TENANT-level
 *    (`mgd-kickbot-<tenant>`) under a reserved sentinel org (`_kickbot`;
 *    `createCollection` does not validate org existence). Retrieval is
 *    tenant-vector-namespaced by collectionId (`tenantRetrieve`), so the org the
 *    collection lives in never affects what KickBot's chat can search.
 *  - `managed:'kickbot'` marks it system-owned: the KB routes reject hand-edits
 *    and reindex, so the UI's read-only treatment is enforced server-side.
 *
 * Invariants (the managed-KB pattern):
 *  - BEST-EFFORT / FAIL-OPEN: swallows + logs; a KB failure never breaks
 *    challenge publish or KickBot provisioning; self-heals on the next sync.
 *  - IDEMPOTENT: the stable doc id is `challenge:<id>:v<version>` (published
 *    versions are immutable, so this is a deterministic no-op re-index) + the KB
 *    content-hash guard. The static guidance doc has a fixed id.
 *  - CONTENT = the AUTHORED, PUBLISHED challenge structure (title/summary/outcome
 *    + per-day activity instructions) — trusted (it passed the publish gate) and
 *    tenant-visible. Enrollment context is per-user + dynamic and stays
 *    TOOL-mediated (`KICKBOT_READ_TOOLS`), never forced into this tenant KB.
 *
 * Retirement removes a challenge's doc so KickBot never cites a retired plan.
 * Teardown (`teardownKickbotKnowledge`) drops the whole collection — wired into
 * the ADR 0442 P6 teardown so a deleted KickBot's KB does not orphan (the roster
 * cascade reaches the profile binding but not the collection).
 *
 * @see docs/adr/0442-kickbot-named-agent-composition.md §P3
 * @see src/features/profiles/profilesKnowledgeService.ts — the pattern this mirrors
 */

import { createLogger } from '../../observability/logger.js';
import { createCollection, getCollection, upsertDocument, deleteDocument, deleteCollection } from '../kb/kbService.js';
import { kbMutated, type KbEmitOptions } from '../kb/emit.js'; // ADR 0643 D3 — silent provisioning backfill + ONE batch event
import { contentLocaleOf, type ChallengeDefinition } from './types.js';

const log = createLogger('kicktodo.kickbot-kb');

const MANAGED = 'kickbot' as const;
const COLLECTION_NAME = 'KickBot Guidance';
/** Reserved sentinel org for the tenant-level collection — no real principal
 *  holds it, and `createCollection` never validates org existence. */
const KICKBOT_KB_ORG = '_kickbot';
const SYNC_ACTOR = 'system:kickbot-kb';

/** Deterministic tenant-level collection id (challenges are tenant-scoped). */
export function kickbotKbCollectionId(tenantId: string): string {
  return `mgd-kickbot-${tenantId}`;
}

/** Stable per-challenge doc id — id+version, so an immutable published version is
 *  a deterministic no-op re-index (never a duplicate). */
const challengeDocId = (id: string, version: number): string => `challenge:${id}:v${version}`;

/** The fixed product-guidance doc id (one static doc, always present). */
const GUIDANCE_DOC_ID = 'guidance:kicktodo';

/** Static, trusted product-guidance text — how KickTodo works, in KickBot's own
 *  frame. Deliberately generic (no tenant data), so it is identical across
 *  tenants and safe to index once per collection. */
const GUIDANCE_TEXT = [
  'KickTodo helps a participant finish a multi-day challenge one day at a time.',
  'A challenge has a title, an outcome, and a set of daily activities; enrolling a',
  'participant creates a personal plan and a daily loop that surfaces "today" and',
  'tracks progress. Each activity has an evidence policy (a simple attestation, or',
  'stronger proof) that a participant satisfies to complete it. When a day is',
  'missed, the plan follows its missed-window policy (skip, or shift). Progress is',
  'the single source of truth: KickBot reads it and never invents completion.',
  'Material actions — enrolling, revising a plan, checking in — go through the',
  'governed KickTodo surfaces, not a direct write. KickBot coaches: it explains the',
  'next step, notices when a plan is not working, and helps a participant recover',
  'without shame.',
].join(' ');

/** Flatten a published challenge into deterministic, trusted plain text for
 *  embedding — title/summary/outcome then per-day activity instructions, in day
 *  order. Order-stable ⇒ the KB content-hash guard makes republish free. */
export function flattenChallenge(c: ChallengeDefinition): string {
  const parts: string[] = [
    `Challenge: ${c.title}`,
    c.summary ? `Summary: ${c.summary}` : '',
    c.outcome ? `Outcome: ${c.outcome}` : '',
    `Duration: ${c.durationDays} day(s).`,
  ];
  const activities = [...c.activities].sort((a, b) => a.day - b.day || a.stableActivityId.localeCompare(b.stableActivityId));
  for (const a of activities) {
    parts.push(`Day ${a.day} — ${a.title}: ${a.instructions}`.trim());
  }
  return parts.filter((s) => s.trim().length > 0).join('\n');
}

async function getOrCreateCollection(tenantId: string): Promise<{ collectionId: string; created: boolean }> {
  const id = kickbotKbCollectionId(tenantId);
  const existing = await getCollection(tenantId, KICKBOT_KB_ORG, id);
  if (existing) return { collectionId: id, created: false };
  await createCollection(tenantId, KICKBOT_KB_ORG, SYNC_ACTOR, { name: COLLECTION_NAME }, { collectionId: id, managed: MANAGED });
  return { collectionId: id, created: true };
}

/** Upsert one PUBLISHED challenge's doc (best-effort). Retired/draft rows are
 *  removed rather than indexed (so KickBot never cites a non-live plan).
 *
 *  Syncs ONLY into an EXISTING collection — it never CREATES one. So a tenant
 *  that publishes challenges but never provisions KickBot gets no orphan
 *  collection; a challenge published BEFORE provisioning is instead picked up by
 *  `ensureKickbotKnowledge`'s backfill-on-create. (Symmetric with `remove`.) */
export async function syncChallengeToKickbotKb(tenantId: string, challenge: ChallengeDefinition, emit: KbEmitOptions = {}): Promise<void> {
  try {
    if (challenge.status !== 'published') {
      await removeChallengeFromKickbotKb(tenantId, challenge.id, challenge.version);
      return;
    }
    const collectionId = kickbotKbCollectionId(tenantId);
    if (!(await getCollection(tenantId, KICKBOT_KB_ORG, collectionId))) return;
    await upsertDocument(tenantId, KICKBOT_KB_ORG, collectionId, challengeDocId(challenge.id, challenge.version), SYNC_ACTOR, {
      title: `${challenge.title}${contentLocaleOf(challenge) !== 'en' ? ` (${contentLocaleOf(challenge)})` : ''}`,
      text: flattenChallenge(challenge),
      contentTrust: 'trusted', // authored + passed the publish gate
      ...emit, // ADR 0643 D3 — the provisioning backfill passes `{ silent: true }`
    });
  } catch (err) {
    log.warn('kickbot_kb_sync_failed', { tenantId, challengeId: challenge.id, version: challenge.version, err: String(err) });
  }
}

/** Remove a challenge's doc (on retire). Best-effort; a missing collection/doc is a no-op. */
export async function removeChallengeFromKickbotKb(tenantId: string, challengeId: string, version: number): Promise<void> {
  try {
    if (!(await getCollection(tenantId, KICKBOT_KB_ORG, kickbotKbCollectionId(tenantId)))) return;
    await deleteDocument(tenantId, KICKBOT_KB_ORG, kickbotKbCollectionId(tenantId), challengeDocId(challengeId, version));
  } catch (err) {
    log.warn('kickbot_kb_remove_failed', { tenantId, challengeId, version, err: String(err) });
  }
}

/**
 * Ensure KickBot's guidance collection exists + is populated, and return its
 * collectionId for binding (`setAgentKnowledge`). Best-effort: on any failure it
 * logs and returns null so provisioning proceeds (the binding is skipped; memory
 * recall still works — the two are independent). On a FRESH create it backfills
 * the static guidance doc + every currently-published challenge (a challenge
 * published later rides the `publishChallenge` sync hook).
 *
 * `loadPublished` is a LAZY provider (invoked only on a fresh create) so this
 * module never imports `challengeService` — that keeps the dependency
 * one-directional (`challengeService → this` for the publish/retire hooks) with
 * no import cycle.
 */
export async function ensureKickbotKnowledge(
  tenantId: string,
  loadPublished: () => Promise<ChallengeDefinition[]>,
): Promise<string | null> {
  try {
    const { collectionId, created } = await getOrCreateCollection(tenantId);
    // The static guidance doc is IDEMPOTENT (content-hash no-op after the first
    // write), so ensure it EVERY time — the collection may have been created
    // first by a `publishChallenge` sync hook, in which case `created` is false
    // here and a create-only guard would leave the guidance doc missing.
    await upsertDocument(tenantId, KICKBOT_KB_ORG, collectionId, GUIDANCE_DOC_ID, SYNC_ACTOR, {
      title: 'How KickTodo works',
      text: GUIDANCE_TEXT,
      contentTrust: 'trusted',
      silent: true, // ADR 0643 D3 — a host-authored provisioning doc, not a user ingest
    });
    // Backfill published challenges only when WE created the collection (else the
    // per-challenge publish hooks already ingested them). Defensive for a system
    // that published challenges before the sync hook existed.
    // ADR 0643 D3 — a BULK lane: silent per row, ONE `document.ingested { count }`.
    if (created) {
      const published = await loadPublished();
      for (const c of published) await syncChallengeToKickbotKb(tenantId, c, { silent: true });
      const count = published.filter((c) => c.status === 'published').length;
      if (count > 0) await kbMutated({ entity: 'document', verb: 'ingested', tenantId, orgId: KICKBOT_KB_ORG, collectionId, count });
    }
    return collectionId;
  } catch (err) {
    log.warn('kickbot_kb_ensure_failed', { tenantId, err: String(err) });
    return null;
  }
}

/**
 * ADR 0442 P6 — drop KickBot's whole KB collection (its docs go with it). Called
 * from KickBot teardown, because the roster cascade reaches the profile's
 * knowledge BINDING but not the KB COLLECTION, which would otherwise orphan
 * (storage bloat + a retention gap). Best-effort; a missing collection is a no-op.
 */
export async function teardownKickbotKnowledge(tenantId: string): Promise<void> {
  try {
    if (!(await getCollection(tenantId, KICKBOT_KB_ORG, kickbotKbCollectionId(tenantId)))) return;
    await deleteCollection(tenantId, KICKBOT_KB_ORG, kickbotKbCollectionId(tenantId));
  } catch (err) {
    log.warn('kickbot_kb_teardown_failed', { tenantId, err: String(err) });
  }
}
