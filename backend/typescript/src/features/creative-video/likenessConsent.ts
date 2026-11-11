/**
 * Likeness and voice consent for avatar video (ADR 1051 D5).
 *
 * An avatar id can name a custom avatar cloned from a real person, so an avatar
 * render needs a PERSON who affirmed they have that person's consent. The
 * affirmation is made by a signed-in user on the page (the route), and recorded
 * here per (tenant, org, user, avatar, voice, text version). The workflow lane
 * takes no attestation input at all: a literal in a saved definition would
 * attest for every later runner. It requires the run person's OWN record.
 *
 * A job keeps a snapshot of the attestation it ran under (`VideoJob.likenessConsent`);
 * the asset keeps only non-personal fields. On DSAR the records are DELETED (their
 * key names the person) and the job snapshots are re-attributed (D8).
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';

/** The version of the sentence below. Bump it when the sentence changes: every
 *  earlier record then stops counting, and people attest again. */
export const LIKENESS_CONSENT_TEXT_VERSION = 'cv-likeness-2026-11';
/** The sentence the person affirms (the page shows its translation). */
export const LIKENESS_CONSENT_TEXT = "I have the depicted person's consent to use their likeness and voice.";

/** What a job records about the attestation it ran under. */
export interface LikenessConsentSnapshot {
  attestedBy: string;
  attestedAt: string;
  textVersion: string;
  avatarId: string;
  voiceId?: string;
  /** `route` — attested on the page for this generation; `record` — a workflow
   *  run used the run person's own earlier attestation. */
  channel: 'route' | 'record';
}

interface ConsentRecord {
  key: string;
  tenantId: string;
  orgId: string;
  userId: string;
  avatarId: string;
  voiceId?: string;
  textVersion: string;
  attestedAt: string;
}

const isConsentRecord = (v: unknown): ConsentRecord | null => {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  return typeof r.key === 'string' && typeof r.tenantId === 'string' && typeof r.userId === 'string' && typeof r.avatarId === 'string' ? (v as ConsentRecord) : null;
};

const records = new DurableCollection<ConsentRecord>('creative-video:likeness-consent', (r) => r.key, isConsentRecord, (r) => r.tenantId);

function keyFor(tenantId: string, orgId: string, userId: string, avatarId: string, voiceId: string | undefined, textVersion: string): string {
  return JSON.stringify([tenantId, orgId, userId, avatarId, voiceId ?? '', textVersion]);
}

/** Record that `userId` affirmed the current sentence for this avatar/voice, and
 *  return the snapshot a route-lane job stores. Idempotent per key (the latest
 *  affirmation's time wins). */
export async function recordLikenessConsent(input: { tenantId: string; orgId: string; userId: string; avatarId: string; voiceId?: string; now?: Date }): Promise<LikenessConsentSnapshot> {
  const attestedAt = (input.now ?? new Date()).toISOString();
  const key = keyFor(input.tenantId, input.orgId, input.userId, input.avatarId, input.voiceId, LIKENESS_CONSENT_TEXT_VERSION);
  await records.put({ key, tenantId: input.tenantId, orgId: input.orgId, userId: input.userId, avatarId: input.avatarId, ...(input.voiceId ? { voiceId: input.voiceId } : {}), textVersion: LIKENESS_CONSENT_TEXT_VERSION, attestedAt });
  return { attestedBy: input.userId, attestedAt, textVersion: LIKENESS_CONSENT_TEXT_VERSION, avatarId: input.avatarId, ...(input.voiceId ? { voiceId: input.voiceId } : {}), channel: 'route' };
}

/** The run person's own CURRENT-version attestation for this avatar/voice, as the
 *  snapshot a workflow-lane job stores — or null (refuse). */
export async function findLikenessConsent(input: { tenantId: string; orgId: string; userId: string; avatarId: string; voiceId?: string }): Promise<LikenessConsentSnapshot | null> {
  const r = await records.get(keyFor(input.tenantId, input.orgId, input.userId, input.avatarId, input.voiceId, LIKENESS_CONSENT_TEXT_VERSION));
  if (!r || r.tenantId !== input.tenantId || r.userId !== input.userId) return null;
  return { attestedBy: r.userId, attestedAt: r.attestedAt, textVersion: r.textVersion, avatarId: r.avatarId, ...(r.voiceId ? { voiceId: r.voiceId } : {}), channel: 'record' };
}

/** Does `snapshot` cover a render of exactly this avatar and voice, under the
 *  current sentence? Checked by the service before anything is claimed. */
export function consentCovers(snapshot: LikenessConsentSnapshot | undefined, avatarId: string, voiceId: string | undefined): boolean {
  return !!snapshot && snapshot.textVersion === LIKENESS_CONSENT_TEXT_VERSION && snapshot.avatarId === avatarId
    && (snapshot.voiceId ?? '') === (voiceId ?? '') && typeof snapshot.attestedBy === 'string' && snapshot.attestedBy.length > 0;
}

/** D8 — delete the subject's consent records in `tenantId` (the key names them). */
export async function eraseLikenessConsents(tenantId: string, subjectKey: string): Promise<number> {
  const { forms } = subjectKeyForms(subjectKey);
  const mine = (await records.listForTenantIndexed(tenantId)).filter((r) => forms.has(r.userId));
  for (const r of mine) await records.delete(r.key);
  return mine.length;
}
