/**
 * Profiles workflow surface (ADR 0005 / ADR 0014) — `ctx.features.profiles`.
 * A thin, DESCRIPTIVE-ONLY read surface over `profilesService` (the ADR 0005
 * boundary: profiles confer no authority and expose no ranking — ranking is
 * Production's concern, `buildProductionContext`). Added so a workflow node can
 * read the team roster through `ctx` (the ADR 0172 sibling-service-import gap);
 * Production's own surface keeps its in-process read (surfaces are peers, not
 * composable within a builder). Always-on/ungated (profiles has no toggle).
 *
 * ADR 0624 D1/D7 — `getProfile` REFUSES an empty id with a typed
 * `validation_error` (the `users/surface.ts` shape): `surfaceStr` coerces an
 * absent key to `''`, and answering `null` for `''` is exactly how the 1.0.0
 * pack's `{ profileId }` drift shipped green as success-with-empty (`UPWF-1`).
 * A REAL-id miss is an explicit `{ profile: null, found: false }`. Endorsements
 * are projected VIEWER-INDEPENDENTLY as `{ count, endorserUserIds }` (no
 * `endorsedByMe` — a viewer-dependent field in a recorded node output would make
 * replay actor-dependent). `completenessMissing` (D4) is NOT on this surface.
 *
 * @see docs/adr/0005-profiles.md
 * @see docs/adr/0624-profiles-lifecycle-events-and-node-honesty.md
 */

import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { listProfiles, getProfile, type Profile, type ProfileSkill } from './profilesService.js';

/** Tenant-owned bookkeeping columns stripped from surface output. */
const INTERNAL = new Set(['tenantId', 'updatedBy']);

/** The surface's skill shape: endorsements as a count + the opaque endorser ids. */
export interface SurfaceProfileSkill {
  name: string;
  proficiency: number;
  endorsements: { count: number; endorserUserIds: string[] };
}

function projectSkill(s: ProfileSkill): SurfaceProfileSkill {
  const ids = s.endorsements ?? [];
  return { name: s.name, proficiency: s.proficiency, endorsements: { count: ids.length, endorserUserIds: [...ids] } };
}

function projectProfileForSurface(p: Profile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (!INTERNAL.has(k)) out[k] = v;
  out.skills = (p.skills ?? []).map(projectSkill);
  return out;
}

export function buildProfilesSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // The tenant's team roster (descriptive capability profiles).
    listProfiles: async () => ({ profiles: (await listProfiles(tenantId)).map(projectProfileForSurface) }),
    // One member's profile. An EMPTY id is a typed refusal (never a null read);
    // a real id that is not in the tenant is `{ profile: null, found: false }`
    // (tenant-scoped; a foreign user is not found).
    getProfile: async (args) => {
      const userId = str(args.userId).trim();
      if (!userId) throw new OpenwopError('validation_error', '`userId` is required', 400, { field: 'userId' });
      const p = await getProfile(tenantId, userId);
      return { profile: p ? projectProfileForSurface(p) : null, found: p !== null };
    },
  };
}
