/**
 * DSAR erasure for creative video (ADR 1051 D8).
 *
 * - `creative-video:job` — RE-ATTRIBUTED, not deleted. A job is the org's record
 *   that money was spent and, for an avatar, that someone attested consent; the
 *   evidence that matters (`attestedAt`, `textVersion`, `avatarId`) names nobody,
 *   so it stays. Every field that names the subject becomes `ERASED_USER_REF`
 *   (`createdBy`, `submitterUserId`, `likenessConsent.attestedBy`), and the prompt
 *   snippet, which may quote a person, becomes `ERASED`. `promptHash` stays: it
 *   identifies nothing. The house tombstone, not a hashed pseudonym: hashing each
 *   member id would reverse a hash.
 * - `creative-video:likeness-consent` — DELETED (the record's key names the
 *   person). An erased person can no longer run avatar workflows on it, which is
 *   right; the job snapshots keep the evidence.
 *
 * The asset carries only a pointer (`lineage.likenessConsent.jobId`), so the media
 * eraser needs no change for this feature.
 */
import type { SubjectEraseReport } from '../../host/subjectErasure.js';
import { ERASED, ERASED_USER_REF, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { listJobsForTenant, getJobByHash, casJob, type VideoJob } from './entities/videoJob.js';
import { eraseLikenessConsents } from './likenessConsent.js';

/** The row with every field naming the subject tombstoned, or null when none does. */
function scrub(job: VideoJob, forms: ReadonlySet<string>): VideoJob | null {
  const createdBy = forms.has(job.createdBy);
  const submitter = !!job.submitterUserId && forms.has(job.submitterUserId);
  const attester = !!job.likenessConsent && forms.has(job.likenessConsent.attestedBy);
  if (!createdBy && !submitter && !attester) return null;
  return {
    ...job,
    ...(createdBy ? { createdBy: ERASED_USER_REF } : {}),
    ...(submitter ? { submitterUserId: ERASED_USER_REF } : {}),
    ...(attester && job.likenessConsent ? { likenessConsent: { ...job.likenessConsent, attestedBy: ERASED_USER_REF } } : {}),
    // The snippet is the requester's own words; redact it on THEIR erasure only.
    ...(createdBy && job.promptSnippet ? { promptSnippet: ERASED } : {}),
  };
}

export async function eraseCreativeVideoSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  const { forms } = subjectKeyForms(subjectKey);
  let rowsTouched = 0;
  for (const listed of await listJobsForTenant(tenantId)) {
    // CAS, re-reading on a lost race (grade-code CV83CD-8): an in-flight job writes
    // its row while it runs, and a plain put here could be overwritten by its
    // stale copy, restoring the erased fields.
    let job: VideoJob | null = listed;
    for (let attempt = 0; job && attempt < 5; attempt += 1) {
      const next = scrub(job, forms);
      if (!next) break;
      if (await casJob(job, next)) { rowsTouched += 1; break; }
      job = await getJobByHash(tenantId, job.requestHash);
    }
  }
  rowsTouched += await eraseLikenessConsents(tenantId, subjectKey);
  return { rowsTouched };
}
