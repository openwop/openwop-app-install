/**
 * User-profiles feature routes (host-extension, sample-grade — ADR 0005).
 *
 * Surface under /v1/host/sample/profiles:
 *   GET   /me                       the caller's own profile (lazily created)
 *   PATCH /me                       self-edit (text / contact / equipment /
 *                                   interests / availability)        [self only]
 *   GET   /                         tenant directory (every profile)
 *   GET   /:userId                  one user's profile (team-visible)
 *
 * TOGGLE-GATED (backend authority — ADR 0001 §3.4): every route resolves the
 * caller's `profiles` assignment server-side; off ⇒ 404. AUTHORITY (ADR 0005):
 * read = any signed-in tenant member; write = the caller's OWN profile only.
 * Tenant-scoped throughout (IDOR guard — a foreign-tenant id reads as 404).
 *
 * @see docs/adr/0005-profiles.md
 */

import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { getUser, listUsers, type User } from '../users/usersService.js';
import { isEmailVerified } from '../users/credentialsService.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import {
  addPortfolioToken,
  clearAvatar,
  getOrCreateProfile,
  getProfile,
  listProfiles,
  removePortfolioToken,
  setAvatarToken,
  setEndorsement,
  setOwnSkills,
  updateOwnProfile,
  viewProfile,
  type AvailabilityStatus,
  type ProfileAvailability,
  type ProfileContact,
  type ProfilePatch,
} from './profilesService.js';

const TOGGLE_ID = 'profiles';
const requireEnabled = (req: Request): Promise<unknown> => requireFeatureEnabled(req, TOGGLE_ID, 'Profiles');

// ── Patch parsing (null = clear, undefined = leave) ─────────────────────────

/** A patch key absent ⇒ undefined (leave); JSON `null` ⇒ null (clear); a string
 *  ⇒ the trimmed value. Anything else is a validation error. */
function patchText(body: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in body)) return undefined;
  const v = body[field];
  if (v === null) return null;
  if (typeof v === 'string') return v;
  throw new OpenwopError('validation_error', `Field \`${field}\` must be a string or null.`, 400, { field });
}

function parseStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  if (!(field in body)) return undefined;
  const v = body[field];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new OpenwopError('validation_error', `Field \`${field}\` must be an array of strings.`, 400, { field });
  }
  return v as string[];
}

const AVAIL_STATUS: AvailabilityStatus[] = ['available', 'busy', 'away'];

function parseAvailability(body: Record<string, unknown>): ProfileAvailability | null | undefined {
  if (!('availability' in body)) return undefined;
  const v = body.availability;
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new OpenwopError('validation_error', 'Field `availability` must be an object or null.', 400, { field: 'availability' });
  }
  const a = v as Record<string, unknown>;
  const out: ProfileAvailability = {};
  if (typeof a.timezone === 'string') out.timezone = a.timezone;
  if (a.hoursPerWeek !== undefined) {
    if (typeof a.hoursPerWeek !== 'number' || !Number.isFinite(a.hoursPerWeek)) {
      throw new OpenwopError('validation_error', '`availability.hoursPerWeek` must be a number.', 400, { field: 'availability.hoursPerWeek' });
    }
    out.hoursPerWeek = a.hoursPerWeek;
  }
  if (a.status !== undefined) {
    if (!AVAIL_STATUS.includes(a.status as AvailabilityStatus)) {
      throw new OpenwopError('validation_error', `\`availability.status\` must be one of ${AVAIL_STATUS.join(', ')}.`, 400, { field: 'availability.status' });
    }
    out.status = a.status as AvailabilityStatus;
  }
  return out;
}

function parseContact(body: Record<string, unknown>): ProfileContact | null | undefined {
  if (!('contact' in body)) return undefined;
  const v = body.contact;
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new OpenwopError('validation_error', 'Field `contact` must be an object or null.', 400, { field: 'contact' });
  }
  const c = v as Record<string, unknown>;
  const links: { label: string; url: string }[] = [];
  if (c.links !== undefined) {
    if (!Array.isArray(c.links)) throw new OpenwopError('validation_error', '`contact.links` must be an array.', 400, { field: 'contact.links' });
    for (const raw of c.links) {
      if (typeof raw !== 'object' || raw === null) continue;
      const l = raw as Record<string, unknown>;
      const label = typeof l.label === 'string' ? l.label : '';
      const url = typeof l.url === 'string' ? l.url : '';
      if (label || url) links.push({ label, url });
    }
  }
  return {
    ...(typeof c.location === 'string' ? { location: c.location } : {}),
    links,
  };
}

/**
 * Surface (NOT own) the email-ownership status (ADR 0005 Phase 4, closing the
 * ADR 0004:167 deferral). The auth layer owns the truth:
 *   - password / manual → the `credentialsService` `emailVerified` flag;
 *   - saml / scim / oidc → the IdP asserted this email, so it is verified by
 *     an authoritative third party (no separate proof needed).
 * Returns undefined when the user has no email at all (no status to show).
 */
async function resolveEmailVerified(user: User): Promise<boolean | undefined> {
  if (!user.email) return undefined;
  if (user.source === 'saml' || user.source === 'scim' || user.source === 'oidc') return true;
  return isEmailVerified(user.tenantId, user.email);
}

export function registerProfilesRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // GET /me — the caller's own profile (lazily materialized).
  app.get('/v1/host/sample/profiles/me', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      const profile = await getOrCreateProfile(user.tenantId, user.userId);
      res.json(viewProfile(profile, { emailVerified: await resolveEmailVerified(user), ...(user.displayName ? { displayName: user.displayName } : {}) }));
    } catch (err) {
      next(err);
    }
  });

  // PATCH /me — self-edit. Authority is intrinsic: a caller can only patch the
  // profile keyed on THEIR OWN resolved userId.
  app.patch('/v1/host/sample/profiles/me', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: ProfilePatch = {
        jobTitle: patchText(body, 'jobTitle'),
        department: patchText(body, 'department'),
        bio: patchText(body, 'bio'),
        contact: parseContact(body),
        availability: parseAvailability(body),
      };
      const equipment = parseStringArray(body, 'equipment');
      if (equipment !== undefined) patch.equipment = equipment;
      const interests = parseStringArray(body, 'interests');
      if (interests !== undefined) patch.interests = interests;

      const updated = await updateOwnProfile(user.tenantId, user.userId, patch);
      res.json(viewProfile(updated));
    } catch (err) {
      next(err);
    }
  });

  // GET / — tenant directory. Tenant is the caller's resolved tenant (the single
  // source of truth — same `user.tenantId` the write paths key on).
  app.get('/v1/host/sample/profiles', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      const [profiles, users] = await Promise.all([listProfiles(user.tenantId), listUsers(user.tenantId)]);
      const names = new Map(users.map((u) => [u.userId, u.displayName]));
      res.json({
        // Skip ORPHANS — a profile whose owning user was deleted. Listing it
        // would render an opaque userId and leak that the account is gone.
        profiles: profiles
          .filter((p) => names.has(p.userId))
          .map((p) => {
            const dn = names.get(p.userId);
            return viewProfile(p, dn ? { displayName: dn } : {});
          }),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Phase 2: avatar + portfolio (media-asset references) ──
  // Validate a candidate token resolves IN THE CALLER'S TENANT and is an image
  // before persisting the reference (the media-asset-url-tenant-scoped
  // invariant — a foreign-tenant or non-image token fails closed).
  const requireImageToken = async (tenantId: string, token: unknown): Promise<string> => {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new OpenwopError('validation_error', 'Field `token` is required (a media-asset token).', 400, { field: 'token' });
    }
    const asset = await resolveMediaAsset(token);
    if (!asset || asset.tenantId !== tenantId) {
      throw new OpenwopError('not_found', 'Media asset not found in this tenant.', 404, { token });
    }
    if (!(asset.contentType ?? '').startsWith('image/')) {
      throw new OpenwopError('validation_error', 'Avatar/portfolio asset MUST be an image.', 400, { contentType: asset.contentType ?? null });
    }
    return token;
  };

  app.put('/v1/host/sample/profiles/me/avatar', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      const token = await requireImageToken(user.tenantId, (req.body as { token?: unknown })?.token);
      res.json(viewProfile(await setAvatarToken(user.tenantId, user.userId, token)));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/sample/profiles/me/avatar', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      res.json(viewProfile(await clearAvatar(user.tenantId, user.userId)));
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/profiles/me/portfolio', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      const token = await requireImageToken(user.tenantId, (req.body as { token?: unknown })?.token);
      res.status(201).json(viewProfile(await addPortfolioToken(user.tenantId, user.userId, token)));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/sample/profiles/me/portfolio/:token', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      const updated = await removePortfolioToken(user.tenantId, user.userId, req.params.token);
      if (!updated) throw new OpenwopError('not_found', 'Portfolio asset not found.', 404, { token: req.params.token });
      res.json(viewProfile(updated));
    } catch (err) {
      next(err);
    }
  });

  // ── Phase 3: skills (self) + endorsements (peer) ──
  // PUT /me/skills — replace the caller's skill list. Endorsements on surviving
  // skill names are preserved by the service.
  app.put('/v1/host/sample/profiles/me/skills', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      const raw = (req.body as { skills?: unknown })?.skills;
      if (!Array.isArray(raw)) {
        throw new OpenwopError('validation_error', 'Field `skills` must be an array of { name, proficiency }.', 400, { field: 'skills' });
      }
      const skills = raw.map((s, i) => {
        if (typeof s !== 'object' || s === null) {
          throw new OpenwopError('validation_error', `skills[${i}] must be an object.`, 400, { index: i });
        }
        const o = s as Record<string, unknown>;
        if (typeof o.name !== 'string' || o.name.trim().length === 0) {
          throw new OpenwopError('validation_error', `skills[${i}].name is required.`, 400, { index: i });
        }
        if (typeof o.proficiency !== 'number' || !Number.isFinite(o.proficiency)) {
          throw new OpenwopError('validation_error', `skills[${i}].proficiency must be a number 1..5.`, 400, { index: i });
        }
        return { name: o.name, proficiency: o.proficiency };
      });
      res.json(viewProfile(await setOwnSkills(user.tenantId, user.userId, skills)));
    } catch (err) {
      next(err);
    }
  });

  // POST/DELETE /:userId/skills/:skill/endorse — endorse a PEER's skill.
  // Fail-closed: not your own profile; the target + skill must exist in your
  // tenant; one endorsement per endorser (idempotent).
  const endorse = (add: boolean) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      const targetUserId = req.params.userId;
      const skillName = decodeURIComponent(req.params.skill ?? '');
      if (user.userId === targetUserId) {
        throw new OpenwopError('forbidden', 'You cannot endorse your own skill.', 403, {});
      }
      // Single read: setEndorsement loads + validates the target profile/skill in
      // the caller's tenant and returns null for a missing profile OR skill (no
      // existence leak — both map to 404).
      const updated = await setEndorsement(user.tenantId, targetUserId, skillName, user.userId, add);
      if (!updated) throw new OpenwopError('not_found', 'Profile or skill not found.', 404, { userId: targetUserId, skill: skillName });
      res.json(viewProfile(updated));
    } catch (err) {
      next(err);
    }
  };
  app.post('/v1/host/sample/profiles/:userId/skills/:skill/endorse', endorse(true));
  app.delete('/v1/host/sample/profiles/:userId/skills/:skill/endorse', endorse(false));

  // GET /:userId — one user's profile (team-visible, tenant-scoped to the caller).
  app.get('/v1/host/sample/profiles/:userId', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const caller = await resolveCallerUser(req);
      const profile = await getProfile(caller.tenantId, req.params.userId);
      if (!profile) throw new OpenwopError('not_found', 'Profile not found.', 404, { userId: req.params.userId });
      const owner = await getUser(profile.userId);
      const emailVerified = owner ? await resolveEmailVerified(owner) : undefined;
      res.json(viewProfile(profile, { emailVerified, ...(owner?.displayName ? { displayName: owner.displayName } : {}) }));
    } catch (err) {
      next(err);
    }
  });
}
