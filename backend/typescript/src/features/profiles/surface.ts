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
import { getProfile, viewProfile, type Profile, type ProfileSkill } from './profilesService.js';
import { listHomeDirectory } from './homeDirectory.js';
import { getUser } from '../users/usersService.js';
import { getLiveShare, listLiveShares, resolveRunDirectory, type DirectoryScope } from './directory.js';

/**
 * ADR 0888 D2 — what a RUN may record about a person: the team allowlist minus
 * the declared-PII and bearer fields. A node output is written into the run log
 * and replayed on `:fork`, and a person's later erasure does not rewrite another
 * run's history — so `bio`, `contact` and the avatar/portfolio asset tokens (bearer
 * URLs on the unauthenticated `/assets/:token` route) never enter it. What stays is
 * what this surface exists for: capability (ADR 0005 / ADR 0172).
 */
const RUN_OMITTED = new Set(['bio', 'contact', 'avatarAssetToken', 'portfolioAssetTokens', 'emailVerified']);

/** The surface's skill shape: endorsements as a count + the opaque endorser ids. */
export interface SurfaceProfileSkill {
  name: string;
  proficiency: number;
  endorsements: { count: number; endorserUserIds: string[] };
}

function projectSkill(s: ProfileSkill, scope: DirectoryScope): SurfaceProfileSkill {
  const ids = s.endorsements ?? [];
  // In a workspace the endorser ids are home-tenant people (ADR 0888 D1): count only.
  return { name: s.name, proficiency: s.proficiency, endorsements: { count: ids.length, endorserUserIds: scope.kind === 'workspace' ? [] : [...ids] } };
}

function projectProfileForSurface(p: Profile, scope: DirectoryScope, displayName?: string): Record<string, unknown> {
  // The ONE team projector (D2) first, so a field it withholds from peers can
  // never reach a run; then the run-only omissions.
  const team = viewProfile(p, { scope: scope.kind, ...(displayName ? { displayName } : {}) }) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(team)) if (!RUN_OMITTED.has(k)) out[k] = v;
  out.skills = (p.skills ?? []).map((s) => projectSkill(s, scope));
  return out;
}

export function buildProfilesSurface(scope: BundleScope): FeatureSurface {
  return {
    // The team the run's acting user may see (ADR 0888 D1/D3) — the SAME
    // resolver the `/profiles` route uses. A run with no acting user, an API key,
    // an anonymous session, a disabled user or a non-member is REFUSED
    // (`forbidden_scope`, named `reason`), never served the directory.
    listProfiles: async () => {
      const { scope: dir } = await resolveRunDirectory(scope);
      if (dir.kind === 'home') return { profiles: (await listHomeDirectory(dir.tenantId)).map(({ profile }) => projectProfileForSurface(profile, dir)) };
      const { users, truncated } = await listLiveShares(dir.workspaceId);
      const profiles: Record<string, unknown>[] = [];
      for (const u of users) {
        const p = await getProfile(u.tenantId, u.userId);
        if (p) profiles.push(projectProfileForSurface(p, dir, u.displayName));
      }
      return { profiles, ...(truncated ? { truncated } : {}) };
    },
    // One member's profile. An EMPTY id is a typed refusal (never a null read);
    // an id outside the reader's directory is `{ profile: null, found: false }`.
    getProfile: async (args) => {
      const userId = str(args.userId).trim();
      if (!userId) throw new OpenwopError('validation_error', '`userId` is required', 400, { field: 'userId' });
      const { scope: dir } = await resolveRunDirectory(scope);
      let p: Profile | null = null;
      let displayName: string | undefined;
      if (dir.kind === 'home') {
        p = await getProfile(dir.tenantId, userId);
        // The route's rule: an orphan (its user is gone) is not found.
        if (p && !(await getUser(p.userId))) p = null;
      } else {
        const u = await getLiveShare(dir.workspaceId, userId);
        p = u ? await getProfile(u.tenantId, userId) : null;
        displayName = u?.displayName;
      }
      return { profile: p ? projectProfileForSurface(p, dir, displayName) : null, found: p !== null };
    },
  };
}
