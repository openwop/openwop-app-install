/**
 * ADR 0120 Phase 2b, rebuilt by ADR 0982 D1/D6 — bind the extraction op to the real host.
 *
 * WHERE it may run (D1). Before anything is read or dispatched, the run must be:
 *   1. in a personal `user:` tenant (one human by construction; `anon:` sandboxes never extract);
 *   2. carrying no ADR 0944 client binding (the run stamp, then the conversation's own `client`);
 *   3. a persisted chat: a `chatSessionId` with a server-side conversation record (excludes Arena,
 *      ephemeral embedded panels and API-made conversation runs);
 *   4. acting as the tenant's canonical person, resolved READ-ONLY;
 *   5. the person's alone: owned by them, with no other human participant (members exist even in
 *      a personal workspace, and a user turn carries no author).
 * Checks 1–2 are pure and run first, so a non-personal close pays no reads.
 *
 * WHO it is about. Everything keys on the canonical `User.userId` in the home tenant: the grant,
 * the note scope, the dedupe and the tombstones. That is exactly where the Personal Memory route
 * lists notes and where the DSAR eraser looks. Before ADR 0982 it keyed on `run.tenantId` plus
 * the raw `actingUserId`, so a shared-workspace chat or an unbound `oidc:` session wrote notes
 * no list ever showed.
 *
 * TRUST (ADR 0587): every fact is written `source:'auto-extract'`, from which `addSubjectNote`
 * derives `contentTrust:'untrusted'` and the recall fence tag.
 *
 * @see docs/adr/0982-memory-extraction-closed-world-personal-lane.md
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 */
import { createHash } from 'node:crypto';
import type { RunRecord } from '../../types.js';
import { OpenwopError } from '../../types.js';
import { isPersonalTenantId } from '../../host/requestSubject.js';
import { runClientStamp } from '../../host/runClientOrg.js';
import { getConversationMeta, userRef } from '../../host/conversationStore.js';
import { resolveCanonicalUserReadOnly, getUser } from '../users/usersService.js';
import {
  addSubjectNote, listSubjectNotes, forgottenFactMatcher, normalizeFactText, subjectMemoryScope,
  type MemorySubject,
} from '../../host/subjectMemory.js';
import { isExtractionGranted } from './grantService.js';
import { runMemoryExtraction, type ExtractionOutcome, type SkipReason } from './extractionOp.js';
import type { ExtractorResult } from './memoryExtractor.js';

export type ExtractionLane = { ok: true; tenantId: string; userId: string } | { ok: false; reason: SkipReason };

/** ADR 0982 D1 — may this close extract, and for whom? Never creates a user. */
export async function resolveExtractionLane(run: Pick<RunRecord, 'tenantId' | 'metadata'>): Promise<ExtractionLane> {
  const tenantId = run.tenantId;
  if (!isPersonalTenantId(tenantId) || !tenantId.startsWith('user:')) return { ok: false, reason: 'not-personal' };
  if (runClientStamp(run.metadata) !== undefined) return { ok: false, reason: 'client-bound' };
  const acting = run.metadata?.['actingUserId'];
  if (typeof acting !== 'string' || acting.length === 0) return { ok: false, reason: 'no-person' };
  const chatSessionId = run.metadata?.['chatSessionId'];
  if (typeof chatSessionId !== 'string' || chatSessionId.length === 0) return { ok: false, reason: 'not-a-chat' };
  const meta = await getConversationMeta(tenantId, chatSessionId).catch(() => null);
  if (!meta) return { ok: false, reason: 'not-a-chat' };
  // The conversation's own ADR 0944 D2 client binding, beside the run stamp checked above.
  if (meta.client) return { ok: false, reason: 'client-bound' };
  const canonical = await resolveCanonicalUserReadOnly(tenantId, acting);
  if (!canonical || !('user' in canonical)) return { ok: false, reason: 'no-person' };
  const person = canonical.user;
  if (person.tenantId !== tenantId) return { ok: false, reason: 'no-person' };
  if (acting !== person.userId && acting !== person.principalId) {
    // ADR 0982 A7 — a person with legacy split rows can act as a non-canonical row of the same
    // identity. A wildcard operator bearer has no row here, so it stays refused.
    const row = await getUser(acting).catch(() => null);
    if (!row || row.tenantId !== tenantId || row.principalId !== person.principalId) return { ok: false, reason: 'no-person' };
  }
  // ADR 0982 D1.5 (MAE2CD-8) — the conversation must be the person's alone. Personal workspaces
  // can have members (AWG2CD-1) and a user turn carries no author, so a conversation that names
  // anyone else as owner, has no owner, or has another human participant could put that member's
  // words into this person's memory. Agents are the only other participants allowed.
  const spellings = new Set([acting, person.userId, person.principalId]);
  if (!meta.ownerUserId || !spellings.has(meta.ownerUserId)) return { ok: false, reason: 'not-a-chat' };
  const ownerRef = userRef(meta.ownerUserId);
  if (meta.participants.some((pp) => pp.subjectRef !== ownerRef && !pp.subjectRef.startsWith('agent:'))) return { ok: false, reason: 'not-a-chat' };
  return { ok: true, tenantId, userId: person.userId };
}

/** Run consent-gated extraction for a close. `extract` is the LLM extractor (injected; tests stub it). */
export async function extractConversationMemory(
  run: Pick<RunRecord, 'tenantId' | 'metadata'>,
  userTurns: readonly string[],
  extract: (userTurns: readonly string[]) => Promise<ExtractorResult>,
  signal?: AbortSignal,
): Promise<ExtractionOutcome> {
  const lane = await resolveExtractionLane(run);
  if (!lane.ok) return { status: 'skipped', reason: lane.reason };
  const { tenantId, userId } = lane;
  // The grant subject is the canonical id, exactly as the consent route files it (ADR 0982 D2).
  // The note subject is `{kind:'user', id: userId}`, exactly as the Personal Memory route lists
  // it (`features/profile-memory/routes.ts` `selfSubject(user.userId)`).
  const subject: MemorySubject = { kind: 'user', id: userId };
  const scope = subjectMemoryScope(subject);
  return runMemoryExtraction(userTurns.some((t) => t.trim().length > 0), {
    isGranted: () => isExtractionGranted(tenantId, userId),
    extract: () => extract(userTurns),
    existing: () => listSubjectNotes(tenantId, subject),
    forgotten: () => forgottenFactMatcher(tenantId, subject),
    write: async (fact) => {
      const idempotencyKey = `memextract:${createHash('sha256').update(`${tenantId}\u0000${scope}\u0000${normalizeFactText(fact)}`).digest('hex')}`;
      try {
        await addSubjectNote(tenantId, subject, fact, { source: 'auto-extract', idempotencyKey });
        return 'written';
      } catch (err) {
        // ADR 0982 A4 — a concurrent close (or a differently-cased twin) already holds this key.
        if (err instanceof OpenwopError && err.code === 'conflict') return 'duplicate';
        throw err;
      }
    },
    ...(signal ? { signal } : {}),
  });
}
