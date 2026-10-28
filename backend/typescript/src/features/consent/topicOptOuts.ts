/**
 * ADR 0905 D7 — subscription-topic opt-outs (the ASM-group port), owned by CONSENT.
 *
 * A row says "this subject does not want marketing about this org's topic". It can only
 * NARROW: `isAllowed(…, {topic})` applies it after the ordinary decision, so a topic can
 * exclude a recipient but never re-include one the `marketing.email` decision refused —
 * one evaluator, no second consent meaning. Topics are opt-out only (no opt-in topics,
 * architect E5). Topic DEFINITIONS are the email feature's; here a `topicId` is opaque
 * and consent never imports email.
 *
 * Narrowing is honoured whatever the `consent` toggle says (a recipient's stated refusal
 * holds like a suppression does). Rows are kept until erasure (a refusal must persist);
 * an erasure deletes them, which is safe because the erasure tombstone already denies all
 * marketing. A CRM merge UNIONS the source's opt-outs onto the survivor; an unmerge leaves
 * the survivor's copies (narrowing-safe residual: it can only exclude).
 */
import { assertNotErased, isErasureTombstoned } from './consentService.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { onCrmRecordMerged } from '../../host/crmRecordLifecycle.js';

export interface TopicOptOut {
  tenantId: string; orgId: string; subjectKey: string; topicId: string;
  source: string; at: string;
}

const key = (tenantId: string, orgId: string, subjectKey: string, topicId: string): string =>
  JSON.stringify([tenantId, orgId, subjectKey, topicId]);
const optOuts = new DurableCollection<TopicOptOut>('consent:topic-optout', (r) => key(r.tenantId, r.orgId, r.subjectKey, r.topicId), undefined, (r) => r.tenantId);
declarePiiFields('consent.topic-optout', ['subjectKey'], { maskGloballyByFieldName: false });

/** Is the subject opted out of this topic? A point read. */
export async function isTopicOptedOut(tenantId: string, orgId: string, subjectKey: string, topicId: string): Promise<boolean> {
  if (!tenantId || !orgId || !subjectKey || !topicId) return false;
  const row = await optOuts.get(key(tenantId, orgId, subjectKey, topicId));
  return !!row && row.tenantId === tenantId && row.orgId === orgId && row.subjectKey === subjectKey;
}

/** Opt a subject out of (or back into) a topic. Removing an opt-out only re-allows the
 *  TOPIC dimension; it never grants consent (`isAllowed` still decides the rest). */
export async function setTopicOptOut(tenantId: string, orgId: string, subjectKey: string, topicId: string, optedOut: boolean, source: string): Promise<void> {
  await assertNotErased(tenantId, subjectKey);
  const id = key(tenantId, orgId, subjectKey, topicId);
  if (optedOut) await optOuts.put({ tenantId, orgId, subjectKey, topicId, source, at: new Date().toISOString() });
  else await optOuts.delete(id);
  // DSAR may have completed after the first barrier but before this write.
  // Its PII-free tombstone remains authoritative even after its delete sweep.
  if (await isErasureTombstoned(tenantId, subjectKey)) {
    await optOuts.delete(id);
    await assertNotErased(tenantId, subjectKey);
  }
}

/** The subject's opted-out topic ids in one org (for the preference centre prefill). */
export async function listTopicOptOuts(tenantId: string, orgId: string, subjectKey: string, topicIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const t of topicIds) if (await isTopicOptedOut(tenantId, orgId, subjectKey, t)) out.add(t);
  return out;
}

async function rowsForSubject(tenantId: string, subjectKey: string): Promise<TopicOptOut[]> {
  return (await optOuts.listForTenantIndexed(tenantId)).filter((r) => r.tenantId === tenantId && r.subjectKey === subjectKey);
}

/** Subject erasure — throws after doing all it can, so `eraseSubject` counts a failure. */
export async function eraseTopicOptOuts(tenantId: string, subjectKey: string): Promise<void> {
  let failed = 0;
  for (const r of await rowsForSubject(tenantId, subjectKey)) {
    try { await optOuts.delete(key(r.tenantId, r.orgId, r.subjectKey, r.topicId)); } catch { failed += 1; }
  }
  if (failed > 0) throw new Error(`topic opt-out erasure incomplete: ${failed} row(s) could not be deleted`);
}

/** Registered at consent boot, toggle-independently (like the consent eraser). */
export function registerTopicOptOutLifecycle(): void {
  registerSubjectEraser(eraseTopicOptOuts);
  onCrmRecordMerged('consent-topic-optout-merge', async ({ tenantId, entity, sourceId, survivorId }) => {
    if (entity !== 'contact' || !sourceId || !survivorId || sourceId === survivorId) return;
    for (const r of await rowsForSubject(tenantId, sourceId)) {
      if (!(await isTopicOptedOut(tenantId, r.orgId, survivorId, r.topicId))) {
        try { await setTopicOptOut(tenantId, r.orgId, survivorId, r.topicId, true, 'crm-merge'); }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'subject_erased') throw error;
        }
      }
    }
  });
}

/** Test-only. */
export async function __resetTopicOptOuts(): Promise<void> { await optOuts.__clear(); }
