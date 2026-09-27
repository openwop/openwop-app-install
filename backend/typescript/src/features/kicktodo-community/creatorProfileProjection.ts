/**
 * Creator-profile → content-kernel projection (ADR 0453 P1). An APPROVED creator
 * profile is a mutable public page — exactly the kernel's shape (unlike
 * challenges, which stay off-kernel per ADR 0430). This publishes the approved
 * projection as a `kicktodo.creator_profile` system-type entity so it rides the
 * ONE public-read gate (published + publicRead + !neverPublic) and, in P2, the
 * per-locale overlay for `display_name`/`bio`.
 *
 * Boundary: the DRAFT/approval write-model + handle uniqueness stay in
 * `communityService` (KickTodo policy the kernel has no opinion on — the same
 * split `cms.page` uses, where workflow status drives the kernel status). This
 * module owns only the published PROJECTION, kept in sync on every state change.
 * Best-effort: a projection failure must never fail the approval/edit itself.
 */

import { mintSystemType, updateEntityType, putSystemEntity, deleteSystemEntity } from '../entities/entitiesService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('kicktodo.creator-profile-projection');

export const CREATOR_PROFILE_TYPE = 'kicktodo.creator_profile';

/** Scalars mirrored to the kernel. `display_name`/`bio` are `localizable` so P2
 *  can attach per-locale overlays; `handle` is the stable public slug (never localised). */
const PROFILE_SCALARS = [
  { key: 'handle', label: 'Handle', type: 'string', required: true },
  { key: 'display_name', label: 'Display name', type: 'string', required: true, localizable: true },
  { key: 'bio', label: 'Bio', type: 'string', required: false, localizable: true },
];

/** Idempotent: mint the type + flip its `publicRead` opt-in (approved profiles
 *  are public). `mintSystemType` reconciles on re-mint; `publicRead` is the one
 *  operator-mutable flag on a system type. */
export async function ensureCreatorProfileType(tenantId: string): Promise<void> {
  await mintSystemType({
    tenantId, name: CREATOR_PROFILE_TYPE, displayName: 'Creator profile',
    fields: PROFILE_SCALARS, actor: 'system:kicktodo-community',
  });
  await updateEntityType({ tenantId, name: CREATOR_PROFILE_TYPE, patch: { publicRead: true }, actor: 'system:kicktodo-community' });
}

interface ProjectableProfile {
  tenantId: string;
  creatorSubject: string;
  handle: string;
  displayName: string;
  bio: string;
  links: string[];
  /** ADR 0453 P2 — per-locale overlays in the WRITE-MODEL's field names. */
  localizations?: Record<string, { displayName?: string; bio?: string }>;
  state: 'draft' | 'pending' | 'approved' | 'suspended';
}

/** Map the write-model overlays (`displayName`/`bio`) onto the kernel field KEYS
 *  (`display_name`/`bio`). Empty ⇒ `{}` (putSystemEntity drops it / clears l10n). */
function toKernelLocalizations(loc: ProjectableProfile['localizations']): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [locale, o] of Object.entries(loc ?? {})) {
    const overlay: Record<string, string> = {};
    if (o.displayName) overlay.display_name = o.displayName;
    if (o.bio) overlay.bio = o.bio;
    if (Object.keys(overlay).length > 0) out[locale] = overlay;
  }
  return out;
}

/**
 * Sync the kernel projection to a profile's current state: publish (status
 * `live` + publicRead) when APPROVED, else remove it. Keyed by `creatorSubject`
 * (stable), so a handle rename is a field update on the same entity. Best-effort
 * (a projection failure must never fail the approval/edit itself).
 *
 * This IS the write-model→projection RECONCILE primitive: it is idempotent and
 * derives the projection purely from the profile's current state, so a P3 sweep
 * over all profiles re-heals any divergence a swallowed failure below left behind.
 *
 * grade-fix: a swallowed failure on the UN-PUBLISH direction is the dangerous one
 * — it can leave a rejected/withdrawn profile still publicly readable on the
 * kernel surface (a visibility/consent divergence), whereas a failed publish only
 * *withholds* a public page. So the two directions log at different severities: an
 * un-publish failure is an ERROR (surfaced for a reconcile), a publish failure a warn.
 */
export async function syncCreatorProfileProjection(p: ProjectableProfile): Promise<void> {
  const publishing = p.state === 'approved';
  try {
    if (publishing) {
      await ensureCreatorProfileType(p.tenantId);
      await putSystemEntity({
        tenantId: p.tenantId,
        typeName: CREATOR_PROFILE_TYPE,
        entityId: p.creatorSubject,
        values: { handle: p.handle, display_name: p.displayName, bio: p.bio },
        ext: { links: p.links },
        localizations: toKernelLocalizations(p.localizations), // ADR 0453 P2 — per-locale display_name/bio
        status: 'live',
        actor: 'system:kicktodo-community',
      });
    } else {
      // Not public → pull the projection down (no-op when it was never published,
      // incl. a tenant whose type was never minted — swallowed as best-effort).
      await deleteSystemEntity({ tenantId: p.tenantId, typeName: CREATOR_PROFILE_TYPE, entityId: p.creatorSubject });
    }
  } catch (err) {
    const detail = { handle: p.handle, state: p.state, error: err instanceof Error ? err.message : String(err) };
    if (publishing) {
      log.warn('kicktodo_profile_projection_publish_failed', detail); // withholds a public page — benign
    } else {
      // The projection may still be LIVE while the profile is non-public — surface
      // it loudly so a reconcile (re-running this sync) closes the divergence.
      log.error('kicktodo_profile_projection_unpublish_failed_may_stay_public', detail);
    }
  }
}
