/**
 * ADR 0954 D2 — grading one lead under its client's model.
 *
 * `computeGrade` is the live, explainable computation (inputs, weights, parts,
 * band) and never writes. `gradeLeadForRun` is what the `grade-lead` node does:
 * the same computation under the model version the dispatch pinned, recorded
 * only if this run is the one the grade row's `pendingRunId` names.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../../types.js';
import { getContact } from '../contactsService.js';
import { contentHashOf, evaluateLeadScore, V0_CONTENT, V0_MODEL_ID, type LeadScoreEvaluation, type LeadScoringModelContent } from './model.js';
import { getModelVersion, resolveActiveModel } from './modelStore.js';
import { getLeadGrade, getLeadProfile, recordLeadGrade, type LeadGrade } from './leadStore.js';
import { isQualifierSignal, readSignals, type SignalId } from './signals.js';
import { getAssessmentForRun, latestAssessment, qualifierRaw, type LeadAssessment } from './assessment.js';

export interface ComputedGrade extends LeadScoreEvaluation {
  modelId: string;
  modelVersion: number;
  modelHash: string;
  inputsDigest: string;
  truncated: boolean;
  /** The assessment whose answers fed the `qualifier.*` signals (ADR 0954 P4). */
  assessmentRunId?: string;
}

/** The model a pinned (modelId, version) names; v0 is version 0 of `v0`. */
export async function modelAt(tenantId: string, orgId: string, modelId: string, version: number): Promise<{ content: LeadScoringModelContent; contentHash: string }> {
  if (modelId === V0_MODEL_ID && version === 0) return { content: V0_CONTENT, contentHash: contentHashOf(V0_CONTENT) };
  const m = await getModelVersion(tenantId, orgId, modelId, version);
  if (!m) throw new OpenwopError('not_found', 'Scoring model version not found.', 404, { modelId, version });
  return { content: m, contentHash: m.contentHash };
}

/**
 * Live computation for a bound lead (404 when the contact is not this client's lead).
 *
 * `assessmentRunId` names the assessment whose answers feed the model's
 * `qualifier.*` signals: a grading run passes its own run (the qualify chain
 * assesses, then grades, in one run) and the explain read passes the one the
 * stored grade used. Without it, the newest assessment under the same model
 * version is used. The id used is returned, so a grade says which it was.
 */
export async function computeGrade(
  tenantId: string, orgId: string, contactId: string,
  pinned?: { modelId: string; version: number; contentHash?: string },
  assessmentRunId?: string,
): Promise<ComputedGrade> {
  if (!(await getLeadProfile(tenantId, orgId, contactId))) {
    throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
  }
  const contact = await getContact(contactId);
  if (!contact || contact.tenantId !== tenantId || contact.mergedInto) {
    throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
  }
  const model = pinned
    ? { modelId: pinned.modelId, version: pinned.version, ...await modelAt(tenantId, orgId, pinned.modelId, pinned.version) }
    : await resolveActiveModel(tenantId, orgId);
  if (pinned?.contentHash !== undefined && pinned.contentHash !== model.contentHash) {
    throw new OpenwopError('forbidden_scope', 'The scoring model does not match the frozen dispatch.', 403, { reason: 'model_pin_mismatch' });
  }
  const signals = new Set<SignalId>(model.content.signals.map((s) => s.signalId));
  const inputs = await readSignals(tenantId, contact, signals, orgId);
  let assessment: LeadAssessment | null = null;
  if (model.content.signals.some((s) => isQualifierSignal(s.signalId))) {
    // This run's own assessment; else the one the stored grade used; else the
    // newest under the same model version.
    const sameModel = (a: LeadAssessment | null): a is LeadAssessment => !!a && a.modelId === model.modelId && a.modelVersion === model.version && a.modelHash === model.contentHash;
    const own = assessmentRunId ? await getAssessmentForRun(tenantId, orgId, contactId, assessmentRunId) : null;
    const storedRun = sameModel(own) ? undefined : (await getLeadGrade(tenantId, orgId, contactId))?.assessmentRunId;
    const stored = storedRun ? await getAssessmentForRun(tenantId, orgId, contactId, storedRun) : null;
    assessment = sameModel(own) ? own : sameModel(stored) ? stored : await latestAssessment(tenantId, orgId, contactId, model.modelId, model.version);
    for (const s of model.content.signals) {
      if (isQualifierSignal(s.signalId)) inputs.raw[s.signalId] = qualifierRaw(assessment, s.signalId.slice('qualifier.'.length), s.values);
    }
  }
  const evaluation = evaluateLeadScore(model.content, inputs.raw);
  const inputsDigest = createHash('sha256')
    .update(JSON.stringify(Object.keys(inputs.raw).sort().map((k) => [k, inputs.raw[k as SignalId]])))
    .digest('hex');
  return { ...evaluation, modelId: model.modelId, modelVersion: model.version, modelHash: model.contentHash, inputsDigest, truncated: inputs.truncated, ...(assessment ? { assessmentRunId: assessment.runId } : {}) };
}

/** The `grade-lead` node's write. */
export async function gradeLeadForRun(input: {
  tenantId: string; orgId: string; contactId: string; runId: string; pinned: { bindingId: string; modelId: string; version: number; contentHash: string };
}): Promise<{ outcome: 'recorded' | 'superseded'; grade: ComputedGrade }> {
  const grade = await computeGrade(input.tenantId, input.orgId, input.contactId, input.pinned, input.runId);
  const outcome = await recordLeadGrade(input.tenantId, input.orgId, input.contactId, input.runId, {
    modelId: grade.modelId, modelVersion: grade.modelVersion, modelHash: grade.modelHash, score: grade.score, band: grade.band,
    parts: grade.parts, inputsDigest: grade.inputsDigest, truncated: grade.truncated,
    ...(grade.assessmentRunId ? { assessmentRunId: grade.assessmentRunId } : {}),
  }, input.pinned.bindingId);
  return { outcome, grade };
}

/** `?explain=1` — the stored projection beside a live recompute under the SAME
 *  model version, and whether they differ ("stale since …"). */
export async function explainGrade(tenantId: string, orgId: string, contactId: string): Promise<{
  projection: LeadGrade | null; live: ComputedGrade; stale: boolean;
}> {
  const projection = await getLeadGrade(tenantId, orgId, contactId);
  const pinned = projection?.modelId !== undefined && projection.modelVersion !== undefined
    ? { modelId: projection.modelId, version: projection.modelVersion } : undefined;
  const live = await computeGrade(tenantId, orgId, contactId, pinned, projection?.assessmentRunId);
  const stale = !projection?.inputsDigest || projection.inputsDigest !== live.inputsDigest || projection.score !== live.score
    || (projection.modelHash !== undefined && projection.modelHash !== live.modelHash);
  return { projection, live, stale };
}
