/**
 * User profiles (ADR 0005) — host-extension, best-effort. One descriptive
 * `Profile` per `User.userId`, tenant-scoped, backed by the same read-through
 * `DurableCollection` the other host-ext stores use.
 *
 * BOUNDARY: this owns DESCRIPTIVE profile data only. Identity (displayName,
 * email) stays in the `users` feature (ADR 0002/0003); authority is RBAC
 * (ADR 0006) and a profile field confers NONE of it (RFC 0087 §B —
 * `org-position-no-authority-escalation` applies to descriptions in general);
 * avatar/portfolio BYTES live in the media-asset surface (RFC 0055) and are
 * referenced here by token, never stored inline; `emailVerified` is OWNED by the
 * auth layer and only surfaced here (Phase 4).
 *
 * @see docs/adr/0005-profiles.md
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { scrubSecretShaped } from '../../host/redactSecrets.js';
import { safeUrl } from '../../host/boundedStrings.js';

export type AvailabilityStatus = 'available' | 'busy' | 'away';

export interface ProfileSkill {
  /** Skill label (e.g. "TypeScript"). Bounded, secret-scrubbed. */
  name: string;
  /** Self-asserted proficiency, 1..5. */
  proficiency: number;
  /** Endorser `User.userId`s (opaque). Surfaced as a count + did-I-endorse. */
  endorsements: string[];
}

export interface ProfileLink {
  label: string;
  url: string;
}

export interface ProfileContact {
  location?: string;
  links: ProfileLink[];
}

export interface ProfileAvailability {
  timezone?: string;
  hoursPerWeek?: number;
  status?: AvailabilityStatus;
}

/** The stored record. `completeness` + `emailVerified` are DERIVED at read time
 *  (see `viewProfile`) and never persisted — so they can't drift from truth. */
export interface Profile {
  userId: string;
  tenantId: string;
  jobTitle?: string;
  department?: string;
  bio?: string;
  contact?: ProfileContact;
  avatarAssetToken?: string;
  portfolioAssetTokens: string[];
  skills: ProfileSkill[];
  equipment: string[];
  availability?: ProfileAvailability;
  interests: string[];
  /** ADR 0025 — the user's assigned-workflow portfolio (the set the human or
   *  their assistant runs), mirroring `RosterEntry.workflows[]` for an agent.
   *  Workflow ids; descriptive only — confers no authority. */
  workflows: string[];
  /** Roster member ids the user has PINNED to the sidebar (an indented
   *  sub-menu under "Agents"). A pure per-user UI preference — confers no
   *  authority; an unresolvable id is simply skipped when the sidebar renders. */
  pinnedAgentIds: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/** The shape returned to clients: the stored profile + derived fields surfaced
 *  from the identity/auth layer (NOT owned here). */
export interface ProfileView extends Profile {
  /** 0..100, weighted field completeness (derived). */
  completeness: number;
  /** Whether the user's email is proven (surfaced from the auth layer, Phase 4). */
  emailVerified?: boolean;
  /** The user's display name (surfaced from the `users` identity record). */
  displayName?: string;
}

const store = new DurableCollection<Profile>('profiles:profile', (p) => p.userId);

const MAX = { short: 120, bio: 2000, list: 64, item: 120, links: 16, url: 2048 } as const;

/** A safe link URL (shared `safeUrl`), or null to DROP the link — a dangerous
 *  scheme (javascript:/data:/…) is rejected (stored-XSS guard). */
function sanitizeLinkUrl(raw: string): string | null {
  return safeUrl(raw, MAX.url) || null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyProfile(tenantId: string, userId: string): Profile {
  const ts = nowIso();
  return {
    userId,
    tenantId,
    portfolioAssetTokens: [],
    skills: [],
    equipment: [],
    interests: [],
    workflows: [],
    pinnedAgentIds: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Weighted completeness (sums to 100). Derived on every read so it can't drift.
 * Weights are a product judgment (ADR 0005 open question — tune with real usage).
 */
export function computeCompleteness(p: Profile): number {
  let score = 0;
  if (p.avatarAssetToken) score += 15;
  if (p.jobTitle) score += 10;
  if (p.department) score += 10;
  if (p.bio) score += 15;
  if (p.skills.length > 0) score += 15;
  if (p.equipment.length > 0) score += 5;
  if (p.availability && (p.availability.status || p.availability.timezone || p.availability.hoursPerWeek !== undefined)) score += 10;
  if (p.interests.length > 0) score += 10;
  if (p.portfolioAssetTokens.length > 0) score += 10;
  return score;
}

/** Project a stored profile to its client view (derived + surfaced fields added). */
export function viewProfile(p: Profile, opts: { emailVerified?: boolean; displayName?: string } = {}): ProfileView {
  return {
    ...p,
    // Back-compat: rows stored before ADR 0025 lack `workflows` — normalize to [].
    workflows: p.workflows ?? [],
    pinnedAgentIds: p.pinnedAgentIds ?? [],
    completeness: computeCompleteness(p),
    ...(opts.emailVerified !== undefined ? { emailVerified: opts.emailVerified } : {}),
    ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
  };
}

/** The caller's own profile, lazily materialized on first read (a signed-in user
 *  always has a profile to edit). */
export async function getOrCreateProfile(tenantId: string, userId: string): Promise<Profile> {
  const existing = await store.get(userId);
  if (existing && existing.tenantId === tenantId) return existing;
  if (existing && existing.tenantId !== tenantId) {
    // userId collision across tenants should be impossible (userId is globally
    // unique), but never serve/overwrite a foreign-tenant row — fail closed.
    throw new OpenwopError('not_found', 'Profile not found.', 404, { userId });
  }
  const fresh = emptyProfile(tenantId, userId);
  await store.put(fresh);
  return fresh;
}

/** Pin / unpin a roster member to the caller's sidebar (ADR 0023 — pinned
 *  agents render as an indented sub-menu under "Agents"). Idempotent; preserves
 *  insertion order (newest pin last). A pure UI preference — no authority, and
 *  the caller can only pin agents that exist in their tenant (checked at the
 *  route). Capped to keep the sub-menu sane. */
const MAX_PINNED = 12;
export async function setAgentPinned(
  tenantId: string,
  userId: string,
  rosterId: string,
  pinned: boolean,
): Promise<Profile> {
  const current = await getOrCreateProfile(tenantId, userId);
  const have = new Set(current.pinnedAgentIds ?? []);
  if (pinned) {
    if (!have.has(rosterId)) {
      const next = [...(current.pinnedAgentIds ?? []), rosterId].slice(-MAX_PINNED);
      const updated: Profile = { ...current, pinnedAgentIds: next, updatedAt: nowIso(), updatedBy: userId };
      await store.put(updated);
      return updated;
    }
    return current;
  }
  if (have.has(rosterId)) {
    const updated: Profile = {
      ...current,
      pinnedAgentIds: (current.pinnedAgentIds ?? []).filter((id) => id !== rosterId),
      updatedAt: nowIso(),
      updatedBy: userId,
    };
    await store.put(updated);
    return updated;
  }
  return current;
}

/** Remove one or more agents from EVERY profile's pinned list in this tenant —
 *  the cascade for agent deletion (e.g. "Clear demo data"). Without it a pin
 *  outlives its agent: the sidebar filters the dead id, but it lingers in the
 *  stored profile and would resurface if the same rosterId were re-seeded.
 *  Idempotent; only rewrites profiles that actually held one of the ids. */
export async function unpinAgentsForTenant(tenantId: string, rosterIds: string[]): Promise<void> {
  if (rosterIds.length === 0) return;
  const drop = new Set(rosterIds);
  for (const p of await listProfiles(tenantId)) {
    const pinned = p.pinnedAgentIds ?? [];
    const next = pinned.filter((id) => !drop.has(id));
    if (next.length !== pinned.length) {
      await store.put({ ...p, pinnedAgentIds: next, updatedAt: nowIso(), updatedBy: 'system' });
    }
  }
}

/** Read a specific user's profile, tenant-scoped (IDOR guard — returns null for a
 *  foreign-tenant or missing profile, no existence leak). */
export async function getProfile(tenantId: string, userId: string): Promise<Profile | null> {
  const p = await store.get(userId);
  return p && p.tenantId === tenantId ? p : null;
}

/** The tenant directory — every profile in the tenant. */
export async function listProfiles(tenantId: string): Promise<Profile[]> {
  return (await store.list()).filter((p) => p.tenantId === tenantId);
}

export interface ProfilePatch {
  jobTitle?: string | null;
  department?: string | null;
  bio?: string | null;
  contact?: ProfileContact | null;
  equipment?: string[];
  interests?: string[];
  availability?: ProfileAvailability | null;
}

/** Apply a self-edit patch to the caller's own profile. `null` clears a field;
 *  `undefined` leaves it. Bounds + secret-scrub are applied here. */
export async function updateOwnProfile(
  tenantId: string,
  userId: string,
  patch: ProfilePatch,
): Promise<Profile> {
  const current = await getOrCreateProfile(tenantId, userId);
  const next: Profile = { ...current };

  const setText = (key: 'jobTitle' | 'department' | 'bio', max: number): void => {
    const v = patch[key];
    if (v === undefined) return;
    if (v === null) { delete next[key]; return; }
    next[key] = scrubSecretShaped(v.trim()).slice(0, max);
  };
  setText('jobTitle', MAX.short);
  setText('department', MAX.short);
  setText('bio', MAX.bio);

  if (patch.contact !== undefined) {
    if (patch.contact === null) {
      delete next.contact;
    } else {
      // Sanitize each link's URL scheme (drop dangerous-scheme links entirely —
      // they would be a stored-XSS vector once rendered as an href). The label is
      // secret-scrubbed like every other free-text field.
      const links = (patch.contact.links ?? [])
        .slice(0, MAX.links)
        .map((l) => ({ label: scrubSecretShaped(String(l.label ?? '').trim()).slice(0, MAX.item), url: sanitizeLinkUrl(String(l.url ?? '')) }))
        .filter((l): l is { label: string; url: string } => l.url !== null);
      next.contact = {
        ...(patch.contact.location ? { location: scrubSecretShaped(patch.contact.location.trim()).slice(0, MAX.item) } : {}),
        links,
      };
    }
  }

  if (patch.equipment !== undefined) {
    next.equipment = patch.equipment.slice(0, MAX.list).map((e) => scrubSecretShaped(e.trim()).slice(0, MAX.item)).filter((e) => e.length > 0);
  }
  if (patch.interests !== undefined) {
    next.interests = patch.interests.slice(0, MAX.list).map((e) => scrubSecretShaped(e.trim()).slice(0, MAX.item)).filter((e) => e.length > 0);
  }

  if (patch.availability !== undefined) {
    if (patch.availability === null) {
      delete next.availability;
    } else {
      const a = patch.availability;
      next.availability = {
        ...(a.timezone ? { timezone: a.timezone.trim().slice(0, MAX.item) } : {}),
        ...(a.hoursPerWeek !== undefined ? { hoursPerWeek: Math.max(0, Math.min(168, Math.round(a.hoursPerWeek))) } : {}),
        ...(a.status ? { status: a.status } : {}),
      };
    }
  }

  next.updatedAt = nowIso();
  next.updatedBy = userId;
  await store.put(next);
  return next;
}

// ── Phase 2: avatar + portfolio (media-asset references) ────────────────────
// The ROUTE validates a token resolves in the caller's tenant AND is an image
// (the `media-asset-url-tenant-scoped` invariant) before calling these; the
// service stores REFERENCES only — bytes never enter the profile store.

const MAX_PORTFOLIO = 24;

export async function setAvatarToken(tenantId: string, userId: string, token: string): Promise<Profile> {
  const p = await getOrCreateProfile(tenantId, userId);
  const next: Profile = { ...p, avatarAssetToken: token, updatedAt: nowIso(), updatedBy: userId };
  await store.put(next);
  return next;
}

export async function clearAvatar(tenantId: string, userId: string): Promise<Profile> {
  const p = await getOrCreateProfile(tenantId, userId);
  const next: Profile = { ...p, updatedAt: nowIso(), updatedBy: userId };
  delete next.avatarAssetToken;
  await store.put(next);
  return next;
}

/** Append a portfolio asset reference (idempotent, capped). Returns the profile
 *  (callers map to a view). */
export async function addPortfolioToken(tenantId: string, userId: string, token: string): Promise<Profile> {
  const p = await getOrCreateProfile(tenantId, userId);
  if (p.portfolioAssetTokens.includes(token)) return p; // idempotent
  if (p.portfolioAssetTokens.length >= MAX_PORTFOLIO) {
    throw new OpenwopError('validation_error', `Portfolio is full (max ${MAX_PORTFOLIO} items).`, 409, { maxPortfolio: MAX_PORTFOLIO });
  }
  const next: Profile = { ...p, portfolioAssetTokens: [...p.portfolioAssetTokens, token], updatedAt: nowIso(), updatedBy: userId };
  await store.put(next);
  return next;
}

/** Remove a portfolio asset reference. Returns null if the token wasn't present
 *  (so the route can 404 honestly). */
export async function removePortfolioToken(tenantId: string, userId: string, token: string): Promise<Profile | null> {
  const p = await getOrCreateProfile(tenantId, userId);
  if (!p.portfolioAssetTokens.includes(token)) return null;
  const next: Profile = {
    ...p,
    portfolioAssetTokens: p.portfolioAssetTokens.filter((t) => t !== token),
    updatedAt: nowIso(),
    updatedBy: userId,
  };
  await store.put(next);
  return next;
}

export const PORTFOLIO_LIMIT = MAX_PORTFOLIO;

// ── Phase 3: skills + endorsements ──────────────────────────────────────────

const MAX_SKILLS = 50;

/** Replace the caller's skill list. Endorsements are PRESERVED for a skill whose
 *  name survives the edit (matched case-insensitively) — editing your skills
 *  must not silently wipe your peers' endorsements — and reset for new skills.
 *  Names are scrubbed/bounded; proficiency is clamped to 1..5; duplicate names
 *  collapse to the last. */
export async function setOwnSkills(
  tenantId: string,
  userId: string,
  skills: { name: string; proficiency: number }[],
): Promise<Profile> {
  const current = await getOrCreateProfile(tenantId, userId);
  const priorEndorsements = new Map(current.skills.map((s) => [s.name.toLowerCase(), s.endorsements]));
  const byName = new Map<string, ProfileSkill>();
  for (const raw of skills.slice(0, MAX_SKILLS)) {
    const name = scrubSecretShaped(String(raw.name ?? '').trim()).slice(0, MAX.item);
    if (!name) continue;
    const proficiency = Math.max(1, Math.min(5, Math.round(Number(raw.proficiency))));
    byName.set(name.toLowerCase(), { name, proficiency, endorsements: priorEndorsements.get(name.toLowerCase()) ?? [] });
  }
  const next: Profile = { ...current, skills: [...byName.values()], updatedAt: nowIso(), updatedBy: userId };
  await store.put(next);
  return next;
}

// ── ADR 0025: assigned-workflow portfolio (self) ────────────────────────────

const MAX_WORKFLOWS = 50;

/** Replace the caller's assigned-workflow portfolio (ADR 0025). Workflow ids are
 *  trimmed, bounded, and de-duplicated (order preserved, first occurrence wins).
 *  Descriptive only — assigning a workflow confers no authority; it just curates
 *  the set the human (or their assistant) runs, exactly as `RosterEntry.workflows`
 *  does for an agent. The route validates the ids are non-empty strings. */
export async function setOwnWorkflows(
  tenantId: string,
  userId: string,
  workflowIds: string[],
): Promise<Profile> {
  const current = await getOrCreateProfile(tenantId, userId);
  const seen = new Set<string>();
  const workflows: string[] = [];
  for (const raw of workflowIds.slice(0, MAX_WORKFLOWS)) {
    const id = String(raw ?? '').trim().slice(0, MAX.item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    workflows.push(id);
  }
  const next: Profile = { ...current, workflows, updatedAt: nowIso(), updatedBy: userId };
  await store.put(next);
  return next;
}

/** Add or remove an endorsement on `targetUserId`'s named skill. The CALLER
 *  (route) MUST have already enforced: the target profile exists, the skill
 *  exists, and the endorser is NOT the target (no self-endorsement). Idempotent:
 *  adding an existing endorser, or removing an absent one, is a no-op. Returns
 *  the updated profile, or null if the skill vanished between check and write. */
export async function setEndorsement(
  tenantId: string,
  targetUserId: string,
  skillName: string,
  endorserUserId: string,
  add: boolean,
): Promise<Profile | null> {
  const p = await getProfile(tenantId, targetUserId);
  if (!p) return null;
  const idx = p.skills.findIndex((s) => s.name.toLowerCase() === skillName.toLowerCase());
  if (idx === -1) return null;
  const skill = p.skills[idx]!;
  const has = skill.endorsements.includes(endorserUserId);
  if (add === has) return p; // already in the desired state — idempotent no-op
  const endorsements = add
    ? [...skill.endorsements, endorserUserId]
    : skill.endorsements.filter((e) => e !== endorserUserId);
  const nextSkills = [...p.skills];
  nextSkills[idx] = { ...skill, endorsements };
  // NB: endorsing does NOT bump updatedAt/updatedBy — that tracks the OWNER's
  // edits, and an endorsement is a peer action, not the owner editing.
  const next: Profile = { ...p, skills: nextSkills };
  await store.put(next);
  return next;
}

export const SKILLS_LIMIT = MAX_SKILLS;

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetProfiles(): Promise<void> {
  await store.__clear();
}
