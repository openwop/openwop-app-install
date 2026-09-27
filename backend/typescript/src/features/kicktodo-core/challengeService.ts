/**
 * Challenge definitions (ADR 0414 P1; PRD §6.1) — draft → published-immutable,
 * content-addressed. `kicktodo-core` is the ONE owner of executable challenge
 * structure; draft prose/research live in Documents/KB (PRD rule). Published
 * versions never mutate — an author change creates a new version.
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import {
  challengeContentHash,
  type ChallengeActivity,
  type ChallengeDefinition,
  negotiateLocale,
  type MissedWindowPolicy,
} from './types.js';
import { syncChallengeToKickbotKb, removeChallengeFromKickbotKb } from './kicktodoKnowledgeService.js';

/** Keyed `${tenant}::${challengeId}::v${version}` — point lookups + bounded
 *  tenant/challenge prefix scans only. */
const challenges = new DurableCollection<ChallengeDefinition>(
  'kicktodo-challenges',
  (c) => `${c.tenantId}::${c.id}::v${c.version}`,
);

const nowIso = (): string => new Date().toISOString();

export class ChallengeValidationError extends Error {}
export class ChallengeImmutableError extends Error {
  constructor() {
    super('A published challenge version is immutable — publish a new version instead.');
  }
}

export interface CreateChallengeInput {
  tenantId: string;
  authorSubject?: string;
  /** KT-EXP-8 / ADR 0441 §4 — an OPTIONAL caller-supplied draft id. Absent ⇒ a fresh
   *  random `chal:<uuid>` (the manual-authoring path). The decompose path passes a
   *  DETERMINISTIC `chal:ktc-<hash(tenant|candidate)>` so a re-decompose is idempotent
   *  (one draft per candidate) instead of orphaning a new random draft each time.
   *  `createDraft` never overwrites a NON-draft row at this id (published-immutability). */
  id?: string;
  title: string;
  summary: string;
  outcome: string;
  durationDays: number;
  activities: ChallengeActivity[];
  missedWindowPolicy?: MissedWindowPolicy;
  /** ADR 0443 R4 — optional content-depth facet (absent ⇒ unlabeled). */
  depthLevel?: 'beginner' | 'intermediate' | 'advanced';
  /** ADR 0430 — BCP-47 content locale (absent ⇒ `en`). */
  contentLocale?: string;
  /** ADR 0430 — set when authoring a TRANSLATION of a published source. */
  translationOf?: { challengeId: string; version: number };
}

function validate(input: CreateChallengeInput): void {
  if (!input.title.trim()) throw new ChallengeValidationError('Field `title` is required.');
  if (!Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 366) {
    throw new ChallengeValidationError('Field `durationDays` must be an integer in [1, 366].');
  }
  if (!Array.isArray(input.activities) || input.activities.length === 0) {
    throw new ChallengeValidationError('At least one activity is required.');
  }
  if (input.activities.length > 500) {
    // KT-3 (grade-gate fix): bounded input — a challenge is a curriculum, not
    // a bulk import; an unbounded array is a memory/DoS vector on authoring.
    throw new ChallengeValidationError('A challenge may declare at most 500 activities.');
  }
  const ids = new Set<string>();
  for (const a of input.activities) {
    if (!a.stableActivityId?.trim()) throw new ChallengeValidationError('Every activity needs a `stableActivityId`.');
    if (ids.has(a.stableActivityId)) throw new ChallengeValidationError(`Duplicate stableActivityId \`${a.stableActivityId}\`.`);
    ids.add(a.stableActivityId);
    if (!Number.isInteger(a.day) || a.day < 1 || a.day > input.durationDays) {
      throw new ChallengeValidationError(`Activity \`${a.stableActivityId}\` day ${a.day} is outside [1, ${input.durationDays}].`);
    }
    validateAlternatives(a);
  }
}

/** ADR 0429 P1 — the substitution gate. Bounded, uniquely identified, and —
 *  the load-bearing rule — EVIDENCE-POLICY-EQUAL to the parent: the occurrence
 *  copies `evidencePolicy` at materialization, so a divergent alternative
 *  would leave a completed occurrence asserting a bar the participant never
 *  met, and would let a participant silently lower their own evidence bar. */
function validateAlternatives(a: ChallengeActivity): void {
  const alts = a.alternatives;
  if (alts === undefined) return;
  if (!Array.isArray(alts)) throw new ChallengeValidationError('`alternatives` must be an array.');
  if (alts.length > 5) {
    throw new ChallengeValidationError(`Activity \`${a.stableActivityId}\` declares more than 5 alternatives.`);
  }
  const seen = new Set<string>();
  for (const alt of alts) {
    if (!alt.stableActivityId?.trim()) {
      throw new ChallengeValidationError(`An alternative of \`${a.stableActivityId}\` is missing \`stableActivityId\`.`);
    }
    if (alt.stableActivityId === a.stableActivityId) {
      throw new ChallengeValidationError(`An alternative may not reuse its parent's id \`${a.stableActivityId}\`.`);
    }
    if (seen.has(alt.stableActivityId)) {
      throw new ChallengeValidationError(`Duplicate alternative \`${alt.stableActivityId}\` on \`${a.stableActivityId}\`.`);
    }
    seen.add(alt.stableActivityId);
    if (!alt.title?.trim() || !alt.instructions?.trim()) {
      throw new ChallengeValidationError(`Alternative \`${alt.stableActivityId}\` needs a title and instructions.`);
    }
    if (alt.evidencePolicy !== a.evidencePolicy) {
      throw new ChallengeValidationError(
        `Alternative \`${alt.stableActivityId}\` must carry the same evidencePolicy as \`${a.stableActivityId}\` (\`${a.evidencePolicy}\`).`,
      );
    }
  }
}

/** ADR 0430 — BCP-47-ish shape check (language[-REGION]); deliberately lenient
 *  on the tag registry, strict on the shape. */
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** ADR 0430 — the LINEAGE INTEGRITY gate. Lives with the CATALOG owner because
 *  it is an invariant of the definition itself: a translation MUST point at a
 *  PUBLISHED source IN THE SAME TENANT (a cross-tenant pointer would leak
 *  existence) and MUST declare a locale different from its source. */
async function validateLineage(input: CreateChallengeInput): Promise<void> {
  if (input.contentLocale !== undefined && !LOCALE_RE.test(input.contentLocale)) {
    throw new ChallengeValidationError('`contentLocale` must be a BCP-47 tag like `pt-BR`.');
  }
  const link = input.translationOf;
  if (!link) return;
  if (!input.contentLocale) {
    throw new ChallengeValidationError('A translation must declare its `contentLocale`.');
  }
  const source = await getChallenge(input.tenantId, link.challengeId, link.version);
  if (!source || source.status !== 'published') {
    // Uniform message — a foreign-tenant source and a missing one look identical.
    throw new ChallengeValidationError('`translationOf` must reference a published challenge version.');
  }
  if (source.translationOf) {
    throw new ChallengeValidationError('A translation may not point at another translation — link the source.');
  }
  if ((source.contentLocale ?? 'en').toLowerCase() === input.contentLocale.toLowerCase()) {
    throw new ChallengeValidationError('A translation must declare a locale different from its source.');
  }
}

function buildDraft(input: CreateChallengeInput, id: string, version: number): ChallengeDefinition {
  return {
    id,
    version,
    status: 'draft',
    tenantId: input.tenantId,
    ...(input.authorSubject ? { authorSubject: input.authorSubject } : {}),
    title: input.title,
    summary: input.summary,
    outcome: input.outcome,
    durationDays: input.durationDays,
    activities: input.activities.map((a) => ({ ...a })),
    ...(input.missedWindowPolicy ? { missedWindowPolicy: input.missedWindowPolicy } : {}),
    ...(input.depthLevel ? { depthLevel: input.depthLevel } : {}),
    ...(input.contentLocale ? { contentLocale: input.contentLocale } : {}),
    ...(input.translationOf ? { translationOf: input.translationOf } : {}),
    createdAt: nowIso(),
  };
}

export async function createDraft(input: CreateChallengeInput): Promise<ChallengeDefinition> {
  validate(input);
  await validateLineage(input);
  const id = input.id ?? `chal:${randomUUID()}`;
  const draft = buildDraft(input, id, 1);
  // KT-EXP-8 / ADR 0441 §4 — a caller-supplied deterministic id (the decompose path)
  // shares one `v1` key across re-runs, so the write must NEVER clobber a frozen row.
  // KT-EXP-8b — make it ATOMIC: CAS against the observed row (draft-or-null), so a
  // concurrent `publishChallenge` flipping v1 to `published` between our read and
  // write can't be overwritten by a blind put. On a lost race we return the current
  // row (frozen if they published, their draft otherwise) — never clobber it.
  if (input.id !== undefined) {
    const existing = await challenges.get(`${input.tenantId}::${id}::v1`);
    if (existing && existing.status !== 'draft') return existing; // frozen — never touch
    if (await challenges.compareAndSwap(existing ?? null, draft)) return draft;
    const current = await challenges.get(`${input.tenantId}::${id}::v1`);
    if (current) return current; // a racer won the key; return theirs, never overwrite
    // the key vanished (retired + reaped) between attempts — a plain create is safe now
  }
  await challenges.put(draft);
  return draft;
}

/**
 * A NEW VERSION of an existing lineage. The module header has said since P1 that
 * "an author change creates a new version" and `ChallengeImmutableError` tells
 * every caller to "publish a new version instead" — and until now nothing could:
 * `createDraft` only ever writes `v1`, and returns the frozen row untouched when
 * `v1` exists. So a retired lineage at a deterministic id was BURNED: the
 * `demo-kicktodo` seeder's `clear()` retired `v1`, and its next `seed()` got the
 * retired row back from `createDraft`, handed it to `publishChallenge`, and threw
 * (MEASURED 2026-09-07 — the round trip §2 calls "symmetric" could not complete).
 *
 * Reads the LATEST row at `id` and writes `v${latest+1}` as a fresh draft with
 * the supplied content. Refuses while the latest row is still a draft — edit or
 * publish that one; two open drafts of one lineage is the ambiguity the version
 * key exists to prevent. CAS on the new key so two concurrent revisions cannot
 * both claim the same number: the loser gets `null` and re-reads. Enrollments
 * pin `(id, version)`, so an active enrollment on the old version is untouched
 * (PRD §13) — this is the mechanism retire-then-republish always assumed.
 */
export async function createDraftVersion(
  input: CreateChallengeInput & { id: string },
): Promise<ChallengeDefinition | null> {
  validate(input);
  await validateLineage(input);
  const latest = await getLatest(input.tenantId, input.id);
  if (!latest) return null; // no lineage to version — that is createDraft's job
  if (latest.status === 'draft') {
    throw new ChallengeValidationError(
      `${input.id} v${latest.version} is still a draft — edit or publish it before creating another version.`,
    );
  }
  const draft = buildDraft(input, input.id, latest.version + 1);
  if (await challenges.compareAndSwap(null, draft)) return draft;
  return null; // a concurrent revision claimed this version number; re-read and retry
}

export async function getChallenge(tenantId: string, id: string, version: number): Promise<ChallengeDefinition | null> {
  const c = await challenges.get(`${tenantId}::${id}::v${version}`);
  return c && c.tenantId === tenantId ? c : null;
}

/** Latest version row for a challenge id (bounded prefix scan over versions). */
export async function getLatest(tenantId: string, id: string): Promise<ChallengeDefinition | null> {
  const rows = await challenges.listByPrefix(`${tenantId}::${id}::`);
  if (rows.length === 0) return null;
  return rows.sort((a, b) => b.version - a.version)[0];
}

/** Published challenges for Discover — the PUBLIC immutable projection only
 *  (drafts and retired rows never leak; PRD §10.1). */
export async function listPublished(tenantId: string): Promise<ChallengeDefinition[]> {
  const rows = await challenges.listByPrefix(`${tenantId}::`);
  return rows.filter((c) => c.status === 'published').sort((a, b) => a.title.localeCompare(b.title));
}

export interface NegotiatedChallenge {
  challenge: ChallengeDefinition;
  /** The locale actually served — the UI discloses it when it is not exact. */
  servedLocale: string;
  /** False when the caller's requested locale was unavailable (fell back). */
  exactLocale: boolean;
}

/**
 * ADR 0430 P2 — Discover with CONTENT-locale negotiation, independent of the
 * UI locale. ONE catalog scan; lineages are grouped IN MEMORY and negotiated
 * by the pure helper — never a per-challenge follow-up read (the PRD §14
 * no-N+1 rule for the catalog path).
 */
export async function listPublishedForLocale(tenantId: string, requestedLocale: string): Promise<NegotiatedChallenge[]> {
  const published = await listPublished(tenantId);
  const byLineage = new Map<string, ChallengeDefinition[]>();
  for (const c of published) {
    const root = c.translationOf?.challengeId ?? c.id;
    const bucket = byLineage.get(root);
    if (bucket) bucket.push(c);
    else byLineage.set(root, [c]);
  }
  const out: NegotiatedChallenge[] = [];
  for (const lineage of byLineage.values()) {
    const picked = negotiateLocale(lineage, requestedLocale);
    if (picked) out.push({ challenge: picked.row, servedLocale: picked.servedLocale, exactLocale: picked.exact });
  }
  return out.sort((a, b) => a.challenge.title.localeCompare(b.challenge.title));
}

/** ADR 0430 P3 — retirement cascades DOWN a lineage only: retiring a SOURCE
 *  retires its translations (a safety signal must propagate), while retiring
 *  one translation leaves the source and its siblings untouched. */
export async function retireLineage(tenantId: string, id: string, version: number): Promise<number> {
  const root = await retireChallenge(tenantId, id, version);
  if (!root || root.translationOf) return root ? 1 : 0;
  let retired = 1;
  for (const c of await challenges.listByPrefix(`${tenantId}::`)) {
    if (c.translationOf?.challengeId === id && c.translationOf.version === version && c.status !== 'retired') {
      await retireChallenge(tenantId, c.id, c.version);
      retired += 1;
    }
  }
  return retired;
}

/**
 * Publish a draft — computes the content hash and freezes the row. CAS: a
 * concurrent publish/edit loses. Publishing an already-published version is
 * idempotent (returns the frozen row).
 */
export async function publishChallenge(tenantId: string, id: string, version: number): Promise<ChallengeDefinition | null> {
  const row = await getChallenge(tenantId, id, version);
  if (!row) return null;
  if (row.status === 'published') return row;
  if (row.status === 'retired') throw new ChallengeImmutableError();
  const published: ChallengeDefinition = {
    ...row,
    status: 'published',
    contentHash: challengeContentHash(row),
    publishedAt: nowIso(),
  };
  const ok = await challenges.compareAndSwap(row, published);
  if (!ok) return await getChallenge(tenantId, id, version);
  // ADR 0442 P3 — keep KickBot's guidance KB in lockstep (best-effort, same
  // feature; the KB service swallows + logs its own failures, so this never
  // breaks publish). A challenge published before KickBot is provisioned is
  // backfilled by `ensureKickbotKnowledge` on first provision.
  await syncChallengeToKickbotKb(tenantId, published);
  return published;
}

/** Retire — blocks NEW enrollments; active/historical enrollments keep their
 *  pinned version (PRD §13). Idempotent. */
export async function retireChallenge(tenantId: string, id: string, version: number): Promise<ChallengeDefinition | null> {
  const row = await getChallenge(tenantId, id, version);
  if (!row) return null;
  if (row.status === 'retired') return row;
  const retired: ChallengeDefinition = { ...row, status: 'retired' };
  const ok = await challenges.compareAndSwap(row, retired);
  if (!ok) return await getChallenge(tenantId, id, version);
  // ADR 0442 P3 — drop the retired plan from KickBot's KB so it is never cited
  // as live (best-effort; the KB service swallows its own failures).
  await removeChallengeFromKickbotKb(tenantId, id, version);
  return retired;
}
