/**
 * ADR 0954 D7 (P4) — what a website visitor SAID about themselves to the chat
 * widget's `crm.lead.qualify` tool, kept per contact as evidence.
 *
 * These answers are never a grade and never a signal. The widget lane has no
 * client org (a held tool runs with the tenant and run only,
 * `host/anonymousActor.ts`), and a model-supplied org would let a visitor pick
 * the client, so nothing here is checked against a client's model. The shape is
 * bounded instead, and the in-run assessor may CITE an answer as evidence
 * (`form-field`, ref `stated:<criterionId>`) for a criterion it validates
 * against the pinned model. That is what makes "the widget cannot write a
 * grade" structural.
 */
import { hostExtStorage } from '../../../host/hostExtPersistence.js';
import { tombstoneId } from '../../consent/consentService.js';
import { commitLeadStatedSubmission, deleteLeadStatedSubmissions, readLeadStatedSubmissions } from './leadStore.js';
import { OpenwopError } from '../../../types.js';

export interface StatedAnswer { criterionId: string; value: string; at: string; submissionId: string }
export interface StatedSubmission { submissionId: string; at: string; answers: Array<{ criterionId: string; value: string }> }

export const MAX_STATED_ANSWERS = 10;
const CRITERION_ID = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const MAX_VALUE = 200;

export async function getStatedAnswers(tenantId: string, contactId: string): Promise<StatedAnswer[]> {
  return (await readLeadStatedSubmissions(tenantId, contactId)).flatMap((s) => s.answers.map((a) => ({ ...a, at: s.at, submissionId: s.submissionId })));
}

/** Bounded shape check (400 naming the field): 1–10 answers, a criterion-shaped
 *  id, a value of up to 200 characters. Numbers are kept as their text. */
export function parseStatedAnswers(input: unknown): Array<{ criterionId: string; value: string }> {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_STATED_ANSWERS) {
    throw new OpenwopError('validation_error', `Give 1 to ${MAX_STATED_ANSWERS} answers.`, 400, { field: 'answers' });
  }
  const seen = new Set<string>();
  return input.map((a, i) => {
    const r = (a ?? {}) as Record<string, unknown>;
    const criterionId = typeof r.criterionId === 'string' ? r.criterionId.trim() : '';
    const raw = typeof r.value === 'number' && Number.isFinite(r.value) ? String(r.value) : typeof r.value === 'string' ? r.value.trim() : '';
    if (!CRITERION_ID.test(criterionId) || seen.has(criterionId)) throw new OpenwopError('validation_error', 'Each answer needs a distinct criterionId.', 400, { field: `answers[${i}].criterionId` });
    if (!raw || raw.length > MAX_VALUE) throw new OpenwopError('validation_error', `Each answer needs a value of up to ${MAX_VALUE} characters.`, 400, { field: `answers[${i}].value` });
    seen.add(criterionId);
    return { criterionId, value: raw };
  });
}

/** One immutable, separately attributable claim per actual anonymous surface run.
 * The visitor identifies an email, not proof of subject ownership. Nothing here
 * silently replaces another visitor's statements or records a grade. */
export async function recordStatedAnswers(tenantId: string, contactId: string, answers: ReadonlyArray<{ criterionId: string; value: string }>, sourceRunId: string): Promise<void> {
  const run = await hostExtStorage().getRun(sourceRunId);
  if (!run || run.tenantId !== tenantId || run.workflowId !== 'openwop-app.public-anon-surface'
    || run.metadata.principalKind !== 'anonymous' || typeof run.metadata.anonPrincipal !== 'string') {
    throw new OpenwopError('forbidden_scope', 'Visitor statements require an actual anonymous surface run.', 403, {});
  }
  const parsed = parseStatedAnswers(answers).sort((a, b) => a.criterionId.localeCompare(b.criterionId));
  await commitLeadStatedSubmission(tenantId, contactId, { submissionId: tombstoneId(tenantId, sourceRunId), answers: parsed, at: new Date().toISOString() });
}

export async function deleteStatedAnswers(tenantId: string, contactId: string): Promise<number> {
  return deleteLeadStatedSubmissions(tenantId, contactId);
}
