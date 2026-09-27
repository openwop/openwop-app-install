/**
 * ADR 0545 D1/P1 — the answer bank.
 *
 * A per-SUBJECT store of answers to application questions, so a question is
 * asked at most once, ever. The second employer asking for salary expectation
 * gets the stored answer silently.
 *
 * ## Authorization is the KEY, not a check
 *
 * Row 8 requires reads and writes to be restricted to the acting user being the
 * subject — explicitly NOT org-admin, because an admin must never read an
 * employee's salary expectation. That is enforced STRUCTURALLY: every row is
 * keyed `${tenantId}:${subjectId}:${questionKey}` and the subject always comes
 * from the session at the route, never from a request body. There is no code
 * path that takes a subject as a parameter from a caller who did not
 * authenticate as them, so there is no check to forget — the `prefsStore` /
 * `uiStateStore` pattern ("IDOR-safe by construction"). Note this feature's own
 * `GET /grants` does the opposite (org-scoped, returns every subject's id); the
 * bank must never sit behind `authorizeOrgScope`.
 *
 * ## What this store REFUSES to hold, and why that is a correction
 *
 * ADR 0545 D2 puts "EEO/voluntary disclosures" in the standard question bank.
 * This phase declines to store them. The reasoning:
 *
 *  - `DurableCollection` is plaintext JSON in Postgres. There is no field-level
 *    encryption seam for user data — the AES/KMS machinery in `byok/` is a
 *    separate keyspace for credentials and a collection cannot opt in. Masking
 *    is not a control either: `maskPiiValue` is a plain SHA-256 prefix, which is
 *    dictionary-reversible for exactly the low-cardinality values a disability
 *    or veteran answer takes.
 *  - "Decline to self-identify" is a valid, penalty-free answer on every one of
 *    these forms — that is what they are FOR. So refusing to store the value
 *    costs the applicant nothing and removes the most sensitive category in the
 *    product from the database entirely.
 *
 * A store that cannot hold a disability disclosure cannot leak one. That is a
 * stronger guarantee than any access rule over a store that can, and it is
 * available here for free. Recorded as a correction note on ADR 0545.
 *
 * ## An unconfirmed inference never reaches an employer
 *
 * OQ-2 resolves to confirm-before-FIRST-use, which is stricter than the phase
 * table's "cannot be used twice" — the resolved decision wins. `answerFor`
 * returns nothing for an unconfirmed inference, so the structural guarantee is
 * that the agent's guess about someone's years of experience cannot be sent to
 * an employer under their name without them having seen it.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../../host/dataClassification.js';
import { registerSubjectEraser } from '../../../host/subjectErasure.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../../host/retentionPurger.js';
import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';
import { resolveQuestionKey, specialCategoryKeyFor, type KeyMatch } from './questionKey.js';

/** Where an answer came from. The distinction gates whether it can be used. */
export type AnswerSource = 'profile' | 'user' | 'inferred';

export interface Answer {
  tenantId: string;
  /** RFC 0048 opaque subject. ALWAYS the authenticated caller (see the header). */
  subjectId: string;
  questionKey: string;
  /** The question as the FORM asked it, kept for display and for audit. */
  questionText: string;
  value: string;
  source: AnswerSource;
  /** When a human last affirmed it. Absent ⇒ an unconfirmed inference. */
  confirmedAt?: string;
  usageCount: number;
  updatedAt: string;
}

const rowKey = (tenantId: string, subjectId: string, questionKey: string): string =>
  `${tenantId}:${subjectId}:${questionKey}`;

const answers = new DurableCollection<Answer>(
  'job-search:answer',
  (a) => rowKey(a.tenantId, a.subjectId, a.questionKey),
  undefined,
  (a) => a.tenantId,
);

/**
 * JS-DATA-1 — the ONE direct-row write path. The collection itself is
 * module-private now: an exported collection let any in-process caller
 * `answers.put(...)` past the special-category refusal, so the guarantee was
 * enforced by `recordAnswer` the FUNCTION, not by the store. Every write —
 * including test seeding of exact-key rows — now re-checks the question text,
 * making "no caller can" structural rather than "no caller does yet".
 */
export async function putAnswerRow(row: Answer): Promise<{ refused: 'special-category' } | Answer> {
  if (specialCategoryKeyFor(row.questionText)) return { refused: 'special-category' };
  await answers.put(row);
  return row;
}

// The value IS the sensitive part — a salary figure, a notice period, a
// location. Declaring it lifts the entity to `confidential-pii`, which is what
// the retention sweep and log masking dispatch on.
declarePiiFields('job-search.answer', ['value', 'questionText']);

/** Why a write was refused. A reason, never a silent no-op. */
export type AnswerRefusal =
  /** A special-category disclosure this system will not keep (see the header). */
  | 'special-category'
  /** Empty question or value. */
  | 'incomplete';

export interface RecordAnswerInput {
  tenantId: string;
  subjectId: string;
  questionText: string;
  value: string;
  source: AnswerSource;
  /** True when a human affirmed this value in this act. */
  confirmed: boolean;
  now: number;
}

/**
 * Record (or update) an answer.
 *
 * `confirmed` is the caller's assertion that a HUMAN affirmed the value here and
 * now. A `user`-sourced answer is confirmed by definition — it was typed. A
 * `profile` answer is derived from data the user already maintains. Only an
 * `inferred` answer can arrive unconfirmed, and that is the case the read path
 * refuses to serve.
 */
export async function recordAnswer(input: RecordAnswerInput): Promise<Answer | { refused: AnswerRefusal }> {
  const questionText = input.questionText.trim();
  const value = input.value.trim();
  if (!questionText || !value || !input.tenantId || !input.subjectId) return { refused: 'incomplete' };

  // Checked BEFORE the key resolution writes anything, and checked on the
  // QUESTION rather than a caller-supplied key, so a caller cannot smuggle a
  // disclosure in under an innocuous key.
  if (specialCategoryKeyFor(questionText)) return { refused: 'special-category' };

  const known = await keysFor(input.tenantId, input.subjectId);
  const { key } = resolveQuestionKey(questionText, known);
  if (!key) return { refused: 'incomplete' };

  const existing = await answers.get(rowKey(input.tenantId, input.subjectId, key));
  const confirmed = input.confirmed || input.source === 'user' || input.source === 'profile';
  const row: Answer = {
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    questionKey: key,
    // Keep the ORIGINAL phrasing the first time; a later form's wording does not
    // overwrite what the user actually answered.
    questionText: existing?.questionText ?? questionText,
    value,
    // A confirmed inference becomes a `user` answer — D1's rule, applied at the
    // write rather than left to each reader to remember.
    source: input.source === 'inferred' && confirmed ? 'user' : input.source,
    ...(confirmed ? { confirmedAt: new Date(input.now).toISOString() } : {}),
    usageCount: existing?.usageCount ?? 0,
    updatedAt: new Date(input.now).toISOString(),
  };
  await answers.put(row);
  return row;
}

/** Every question key this subject has an answer for. */
export async function keysFor(tenantId: string, subjectId: string): Promise<string[]> {
  const rows = await answers.listByPrefix(`${tenantId}:${subjectId}:`);
  return rows.map((r) => r.questionKey);
}

/** The subject's own list, for the setup wizard and the exceptions card. */
export async function listAnswers(tenantId: string, subjectId: string): Promise<Answer[]> {
  return answers.listByPrefix(`${tenantId}:${subjectId}:`);
}

/** Why no answer was available. The caller needs this to decide park vs skip. */
export type AnswerMiss =
  /** Nothing stored for this question. */
  | 'unknown'
  /** Stored, but it is an unconfirmed inference — it must not be sent. */
  | 'unconfirmed'
  /** A category this system does not keep; answer "decline to self-identify". */
  | 'special-category'
  /** Matched only fuzzily. Usable for a SUGGESTION, never for an auto-answer. */
  | 'low-confidence';

export interface AnswerHit {
  value: string;
  questionKey: string;
  source: AnswerSource;
  match: KeyMatch;
}

/**
 * Look up an answer for a question as an employer's form phrased it.
 *
 * Returns a MISS REASON rather than null, because the four reasons lead to four
 * different behaviours in ADR 0545 D3 and collapsing them would make the
 * campaign either over-park or over-submit.
 *
 * A fuzzy match never auto-answers. Answering an employer's question with a
 * different question's answer is a wrong statement made under the applicant's
 * name; a parked field is an inconvenience the design already absorbs.
 */
export async function answerFor(
  tenantId: string,
  subjectId: string,
  questionText: string,
  /**
   * The subject's known keys, when the caller already has them.
   *
   * Without this every question re-reads the whole answer set, so a six-question
   * form did six prefix scans (`JS-AUTO-1` from the grading pass). Optional so
   * single-question callers stay simple; `prepareAnswers` reads once and passes
   * it down.
   */
  knownKeys?: readonly string[],
): Promise<AnswerHit | { miss: AnswerMiss }> {
  if (specialCategoryKeyFor(questionText)) return { miss: 'special-category' };
  const known = knownKeys ?? (await keysFor(tenantId, subjectId));
  const resolved = resolveQuestionKey(questionText, known);
  if (!resolved.key) return { miss: 'unknown' };

  const row = await answers.get(rowKey(tenantId, subjectId, resolved.key));
  if (!row) return { miss: 'unknown' };
  if (row.source === 'inferred' && !row.confirmedAt) return { miss: 'unconfirmed' };
  if (resolved.match === 'fuzzy') return { miss: 'low-confidence' };
  return { value: row.value, questionKey: row.questionKey, source: row.source, match: resolved.match };
}

/**
 * Record that an answer was actually used on an application.
 *
 * Separate from `answerFor` on purpose: a lookup that incremented a counter
 * would make the count mean "times considered", and the setup wizard uses it to
 * show which answers are earning their keep.
 */
export async function noteAnswerUsed(tenantId: string, subjectId: string, questionKey: string, now: number): Promise<void> {
  const row = await answers.get(rowKey(tenantId, subjectId, questionKey));
  if (!row) return;
  await answers.put({ ...row, usageCount: row.usageCount + 1, updatedAt: new Date(now).toISOString() });
}

/**
 * ADR 0464 — subject erasure. DELETE, not redact.
 *
 * The taxonomy is unambiguous here, unlike the attestation record: these rows
 * are the subject's OWN content and nothing structural depends on them. There is
 * no counterparty whose evidence would be destroyed and no immutability
 * convention to weigh — the same reasoning that makes `job-search:apply-grant` a
 * delete.
 *
 * SCANNER NOTE (updated 2026-08-16; the 2026-08-11 paragraph here described
 * the old `userId`-only gate and went stale when the R3 widening landed):
 * `test/subject-erasure-feature-stores.test.ts` now binds `subjectId` too, so
 * this store IS visible to it. The gate's remaining known blind spot is the
 * module-level `hasEraser` short-circuit — any `registerSubjectEraser` in a
 * feature dir marks every store under it covered — so this store's own
 * erasure test remains the load-bearing evidence.
 */
export async function eraseSubjectAnswers(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const row of await answers.listByPrefix(`${tenantId}:`)) {
    if (!forms.has(row.subjectId)) continue;
    await answers.delete(rowKey(row.tenantId, row.subjectId, row.questionKey));
  }
}

registerSubjectEraser(eraseSubjectAnswers);

// Retention: an answer nobody has used or re-affirmed in a long time is stale
// personal data being kept for no reason. The shared helper ages rows out by
// `updatedAt`, so a re-affirmed answer keeps itself alive.
registerRetentionPurger({
  feature: 'job-search:answer',
  // The seam calls purge(tenantId, CLASSIFICATION, cutoffIso). The previous
  // binding named the second slot `cutoffIso`, so every sweep compared
  // timestamps against the classification STRING — and every ISO date sorts
  // before 'confidential-pii'/'internal'/'public', so ONE sweep of ANY
  // classification would have deleted this store's every row for the tenant.
  // Gate on the store's own classification (declared PII) + the true cutoff.
  purge: async (tenantId, classification, cutoffIso) =>
    classification !== 'confidential-pii' ? 0 : purgeRowsByAge(
      'job-search:answer',
      await answers.listForTenantIndexed(tenantId),
      tenantId,
      cutoffIso,
      (a) => ({ tenantId: a.tenantId, updatedAt: a.updatedAt, id: rowKey(a.tenantId, a.subjectId, a.questionKey) }),
      (id) => answers.delete(id),
    ),
});
