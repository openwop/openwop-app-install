/**
 * UX_UPGRADE-media ROUND 3 — MED2-M3, the erasure/classification half.
 *
 * `media` stored `uploadedBy`/`createdBy` (opaque principal ids) and free-text
 * `lineage.prompt` (a person's own words — may name people) with NO subject
 * eraser and NO PII declaration, so a DSAR fan-out skipped the whole store and
 * reported success. The documents/environments posture applies verbatim:
 * anonymize-not-delete (an asset is ORG content; the attribution is the
 * personal data), erase by the opaque id, declare only the free text.
 *
 * DELIBERATELY NOT HERE: a retention purger for the asset BYTES. Blob lifecycle
 * (the ~century TTL the R2 note flagged) spans the media store and the blob
 * backend, and deleting bytes out from under live embeds is a storage-lifecycle
 * design — recorded open in the tracker, not smuggled into an eraser pass.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerRetentionPurger } from '../../host/retentionPurger.js';
import * as mediaStorage from './mediaStorage.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { createLogger } from '../../observability/logger.js';
import type { MediaAsset, MediaCollection } from './mediaService.js';

const log = createLogger('features.media.erasure');

/** Same token as documents/environments — "erased on request", not "nobody". */
export const ERASED_SUBJECT = 'erased:subject';

const assets = new DurableCollection<MediaAsset>('media:asset', (a) => a.assetId, undefined, (a) => a.tenantId);
const collections = new DurableCollection<MediaCollection>('media:collection', (c) => c.collectionId, undefined, (c) => c.tenantId);

export async function eraseMediaSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!subjectKey) return;
  let touched = 0;
  for (const a of await assets.list()) {
    if (a.tenantId !== tenantId) continue;
    let next: MediaAsset | null = null;
    if (a.uploadedBy === subjectKey) next = { ...(next ?? a), uploadedBy: ERASED_SUBJECT };
    // The erased subject's own PROMPT is their words — scrub it with the
    // attribution (leaving the prose while anonymizing the byline is half an
    // erasure; the projects charter precedent treats authored text as the PII).
    if (a.uploadedBy === subjectKey && a.lineage?.prompt) {
      next = { ...(next ?? a), lineage: { ...a.lineage, prompt: '[erased on subject request]' } };
    }
    if (next) { await assets.put(next); touched += 1; }
  }
  for (const c of await collections.list()) {
    if (c.tenantId !== tenantId || c.createdBy !== subjectKey) continue;
    await collections.put({ ...c, createdBy: ERASED_SUBJECT });
    touched += 1;
  }
  log.info('media_subject_erased', { tenantId, rows: touched });
}

/** ADR 0579 P2 — the orphan grace window: long enough to survive an incident
 *  review or an undelete request, short enough that a failed upload's bytes do
 *  not live a century. */
const ORPHAN_GRACE_MS = (): number => {
  const env = Number(process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS);
  return Number.isFinite(env) && env >= 0 ? env : 7 * 24 * 60 * 60 * 1000;
};

/** ADR 0579 — reclaim byte refs NO asset row references (a put that succeeded
 *  where createAsset then failed; a generate path that stored images the
 *  request then reported failed on; a pre-MED2-B1 half-delete). Design
 *  correction recorded in the ADR: the refindex it proposed is UNNECESSARY —
 *  refs are 1:1 with rows by construction (dedup runs BEFORE put; a
 *  cross-collection copy re-stores its own bytes) — so reference-absence is a
 *  set difference, not a counter. Reference-absence — never age of LIVE bytes,
 *  never subject identity — is the only trigger; the operator's retention
 *  window still gates WHEN the sweep runs at all (no window ⇒ never). */
export async function sweepOrphanedMediaBytes(tenantId: string, now = Date.now()): Promise<number> {
  const referenced = new Set((await assets.list()).filter((a) => a.tenantId === tenantId).map((a) => a.storageRef));
  // PROF-1 — refs held by features OUTSIDE the library (profile avatars/
  // portfolio). FAIL CLOSED: if a provider cannot enumerate, we cannot know the
  // full referenced set, so we must not delete anything this pass (a skipped
  // sweep is delayed reclamation; a wrong delete is unrecoverable byte loss).
  let external: Set<string>;
  try {
    // Review F7 — STRUCTURAL load guarantee, not a boot-order side effect: the
    // sweep itself loads the module(s) that register external byte-ref
    // providers before collecting, so a process that reaches this sweep without
    // having imported profiles (a future slim boot, a script) still gets the
    // full referenced set. Runtime-only dynamic import (the GRADE DATA-2
    // safe-cycle pattern); a failed import aborts the sweep via the same
    // fail-closed catch below.
    await import('../profiles/profilesService.js');
    external = await mediaStorage.collectExternalByteRefs(tenantId);
  } catch (err) {
    log.warn('media_orphan_sweep_aborted_external_refs', { tenantId, err: String(err) });
    return 0;
  }
  let removed = 0;
  for (const ref of await mediaStorage.listRefs(tenantId)) {
    if (referenced.has(ref.storageRef) || external.has(ref.storageRef)) continue;
    // Legacy rows without storedAtMs report null — a pre-0579 orphan has
    // waited long enough; fresh orphans wait out the grace window.
    if (ref.storedAtMs !== null && now - ref.storedAtMs < ORPHAN_GRACE_MS()) continue;

    // Legacy rows without storedAtMs report null — a pre-0579 orphan has
    // waited long enough; fresh orphans wait out the grace window.

    const out = await mediaStorage.remove(tenantId, ref.storageRef);
    if (out === 'removed') removed += 1;
    else log.warn('media_orphan_sweep_skip', { storageRef: ref.storageRef, outcome: out });
  }
  if (removed > 0) log.info('media_orphan_bytes_reclaimed', { tenantId, removed });
  return removed;
}

export function registerMediaErasure(): void {
  registerSubjectEraser(eraseMediaSubject);

  // ADR 0579 P2 — the orphan sweep rides the retention daemon (classification
  // `internal`: byte lifecycle, not PII — the PII half is the eraser above).
  registerRetentionPurger({
    feature: 'media',
    async purge(tenantId, classification) {
      if (!tenantId || classification !== 'internal') return 0;
      return sweepOrphanedMediaBytes(tenantId);
    },
  });
  // The free text only — `uploadedBy`/`createdBy` are opaque principal ids,
  // which comments decided in writing are NOT PII for log-masking even though
  // erasure still keys on them (the two decisions are separate).
  declarePiiFields('media:asset', ['lineage']);
}
