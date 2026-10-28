/**
 * ADR 0955 Q7 (team-lead decision 2026-10-20) — per-CLIENT channel consent, owned by CONSENT.
 *
 * In an agency workspace each client is a separate sender and brand, and TCPA/CTIA practice
 * ties consent to the brand that collected it. A workspace-level `marketing.sms: true` names no
 * brand, so it never reaches a client: a client may text a person only when THAT client holds a
 * grant (`granted: true`). This is an opt-IN record, which is why it is not an ADR 0905 topic
 * (topics are opt-out only, `topicOptOuts.ts`, architect E5).
 *
 * The decision stays in the ONE evaluator: `isAllowed(…, 'marketing.sms', {client: {orgId}})`
 * denies on an erasure tombstone, then a workspace-level `false` (STOPALL / an explicit no),
 * then a missing or `false` grant; topic narrowing applies after.
 *
 * Lifecycle mirrors the topic store: PII-declared, erased with the subject, and a CRM merge
 * carries rows onto the survivor where a `false` always wins and a `true` lands only where the
 * survivor has no row (the same person — no widening past what they gave). An erased subject's
 * grant cannot be written (ADR 0657 D10).
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { onCrmRecordMerged } from '../../host/crmRecordLifecycle.js';
import { OpenwopError } from '../../types.js';

export type ClientConsentChannel = 'sms';

export interface ClientChannelGrant {
  tenantId: string; orgId: string; subjectKey: string; channel: ClientConsentChannel;
  granted: boolean; source: string; at: string;
}

const key = (tenantId: string, orgId: string, subjectKey: string, channel: ClientConsentChannel): string =>
  JSON.stringify([tenantId, orgId, subjectKey, channel]);
const grants = new DurableCollection<ClientChannelGrant>('consent:client-channel', (r) => key(r.tenantId, r.orgId, r.subjectKey, r.channel), undefined, (r) => r.tenantId);
declarePiiFields('consent.client-channel', ['subjectKey'], { maskGloballyByFieldName: false });

/** The client's grant for this subject and channel, or null. A point read. */
export async function getClientChannelGrant(tenantId: string, orgId: string, subjectKey: string, channel: ClientConsentChannel): Promise<ClientChannelGrant | null> {
  if (!tenantId || !orgId || !subjectKey) return null;
  const row = await grants.get(key(tenantId, orgId, subjectKey, channel));
  return row && row.tenantId === tenantId && row.orgId === orgId && row.subjectKey === subjectKey ? row : null;
}

/**
 * Record a client's grant (or its withdrawal). The erasure write barrier (ADR 0657 D10) is
 * passed in by `consentService`, which owns the tombstone, so this module imports nothing back.
 */
export async function setClientChannelGrant(
  input: { tenantId: string; orgId: string; subjectKey: string; channel: ClientConsentChannel; granted: boolean; source: string },
  assertNotErased: (tenantId: string, subjectKey: string) => Promise<void>,
): Promise<ClientChannelGrant> {
  if (!input.orgId || !input.subjectKey) throw new OpenwopError('validation_error', 'A client grant needs an org and a subject.', 400, {});
  await assertNotErased(input.tenantId, input.subjectKey);
  const row: ClientChannelGrant = { ...input, at: new Date().toISOString() };
  await grants.put(row);
  return row;
}

async function rowsForSubject(tenantId: string, subjectKey: string): Promise<ClientChannelGrant[]> {
  return (await grants.listForTenantIndexed(tenantId)).filter((r) => r.tenantId === tenantId && r.subjectKey === subjectKey);
}

/** Subject erasure — throws after doing all it can, so `eraseSubject` counts a failure. */
export async function eraseClientChannelGrants(tenantId: string, subjectKey: string): Promise<void> {
  let failed = 0;
  for (const r of await rowsForSubject(tenantId, subjectKey)) {
    try { await grants.delete(key(r.tenantId, r.orgId, r.subjectKey, r.channel)); } catch { failed += 1; }
  }
  if (failed > 0) throw new Error(`client channel grant erasure incomplete: ${failed} row(s) could not be deleted`);
}

/** Registered at consent boot, toggle-independently (like the consent eraser). */
export function registerClientChannelConsentLifecycle(): void {
  registerSubjectEraser(eraseClientChannelGrants);
  onCrmRecordMerged('consent-client-channel-merge', async ({ tenantId, entity, sourceId, survivorId }) => {
    if (entity !== 'contact' || !sourceId || !survivorId || sourceId === survivorId) return;
    for (const r of await rowsForSubject(tenantId, sourceId)) {
      const mine = await getClientChannelGrant(tenantId, r.orgId, survivorId, r.channel);
      // A `false` always wins; a `true` lands only where the survivor has no row.
      if ((mine === null || (!r.granted && mine.granted))) {
        await grants.put({ ...r, subjectKey: survivorId, source: `merge:${sourceId}`, at: new Date().toISOString() });
      }
    }
  });
}
