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
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { removeProfile } from './profilesKnowledgeService.js'; // GRADE DATA-2 (runtime-only use; safe cycle)
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerExternalByteRefProvider, promoteToDurable, releaseByteRef } from '../media/mediaStorage.js';
import { computeCompleteness, completenessMissing } from './completeness.js';
import { emitProfileWrite, endorsementGiven, endorsementRemoved } from './emit.js';

// ADR 0081 P5 — a profile is descriptive person data: `bio` + `contact.location` are
// free-text personal data (declare for log-masking, ADR 0077). `jobTitle`/`department`
// are org attributes, not personal data.
declarePiiFields('profiles.profile', ['bio', 'location']);

export type AvailabilityStatus = 'available' | 'busy' | 'away';

export interface ProfileSkill {
  /** Skill label (e.g. "TypeScript"). Bounded, secret-scrubbed. */
  name: string;
  /** Self-asserted proficiency, 1..5. */
  proficiency: number;
  /** Endorser `User.userId`s (opaque) — the STORED shape. The route view
   *  projects it as `{ count, endorsedByMe, endorserUserIds }` (`viewProfile`,
   *  ADR 0624 D7) and the workflow surface as `{ count, endorserUserIds }`
   *  (viewer-independent, so a recorded node output replays actor-free). */
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
  /** ADR 0320 — what agents should CALL the user (address name). A self-service
   *  preference: when set it overrides the identity `displayName` for how an agent
   *  addresses them (e.g. "David" instead of "David Tufts"); unset ⇒ the caller
   *  falls back to the first token of `displayName`. Descriptive-only; confers no
   *  authority and never changes the identity record. */
  preferredName?: string;
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
  /** ADR 0356 P6 — explicit growth aspirations (self-editable), preferred by
   *  production-plan ranking over the generic interests. */
  growthInterests?: string[];
  /** ADR 0025 — the user's assigned-workflow portfolio (the set the human or
   *  their assistant runs), mirroring `RosterEntry.workflows[]` for an agent.
   *  Workflow ids; descriptive only — confers no authority. */
  workflows: string[];
  /** Roster member ids the user has PINNED to the sidebar (an indented
   *  sub-menu under "Agents"). A pure per-user UI preference — confers no
   *  authority; an unresolvable id is simply skipped when the sidebar renders. */
  pinnedAgentIds: string[];
  /** Roster member ids the user has PINNED to the AI-chat welcome panel (the
   *  "hand it to an agent" row). Independent of `pinnedAgentIds` (the two pin
   *  targets are separate). Optional for back-compat with profiles stored before
   *  this field; read with `?? []`. Same no-authority / skip-unresolvable rules. */
  pinnedChatAgentIds?: string[];
  /** ADR 0042 — the human's knowledge binding (a REFERENCE, never content):
   *  bound KB `collectionIds` (cited docs live in `kbService`, ADR 0011) +
   *  optional retrieval tuning. Mirrors `agentProfile.knowledge`. The descriptive
   *  Profile record holds only the pointers (ADR 0005 descriptive-only boundary);
   *  the documents + notes themselves live in KB + the `user:<id>` memory scope. */
  knowledge?: {
    collectionIds?: string[];
    retrieval?: { topK?: number; sources?: ('kb' | 'memory')[] };
  };
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/** ADR 0624 D7 — a skill as the ROUTE view projects it: the endorsement count,
 *  whether the VIEWER endorsed it, and the opaque endorser ids (same-tenant,
 *  team-visible by design — ADR 0005). */
export interface ProfileViewSkill {
  name: string;
  proficiency: number;
  endorsements: { count: number; endorsedByMe: boolean; endorserUserIds: string[] };
}

/** The shape returned to clients: the stored profile + derived fields surfaced
 *  from the identity/auth layer (NOT owned here). */
export interface ProfileView extends Omit<Profile, 'skills'> {
  skills: ProfileViewSkill[];
  /** 0..100, weighted field completeness (derived). */
  completeness: number;
  /** Whether the user's email is proven (surfaced from the auth layer, Phase 4). */
  emailVerified?: boolean;
  /** The user's display name (surfaced from the `users` identity record). */
  displayName?: string;
}

/** ADR 0624 D4 — the OWNER's view: the team view plus the "what next" list the
 *  completeness meter captions. SELF-ONLY: served by the `/me` lane routes and
 *  never by `/team`, `GET /:userId` or the workflow surface. */
export interface OwnProfileView extends ProfileView {
  /** Weights not yet earned, heaviest first. */
  completenessMissing: Array<{ field: string; weight: number }>;
}

// GOV-1: `tenantOf` arms the tenant secondary index (bounded retention-purge scan).
const store = new DurableCollection<Profile>('profiles:profile', (p) => p.userId, undefined, (p) => p.tenantId);

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
    pinnedChatAgentIds: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

// ADR 0624 D4 — the weights table lives in ONE constant (`completeness.ts`),
// read by `computeCompleteness` (the meter) and `completenessMissing` (the
// self-lane "what next" list). Re-exported so existing importers keep working.
export { computeCompleteness, completenessMissing, COMPLETENESS_WEIGHTS } from './completeness.js';

export interface ViewProfileOpts {
  emailVerified?: boolean;
  displayName?: string;
  /** The caller — decides `endorsements.endorsedByMe` (ADR 0624 D7). */
  viewerUserId?: string;
}

/** Project a stored profile to its client view (derived + surfaced fields added;
 *  endorsements projected for the viewer — D7). Team-visible: carries NO
 *  `completenessMissing` (that is `viewOwnProfile`, self-only). */
export function viewProfile(p: Profile, opts: ViewProfileOpts = {}): ProfileView {
  const viewer = opts.viewerUserId;
  return {
    ...p,
    skills: (p.skills ?? []).map((s) => {
      const ids = s.endorsements ?? [];
      return { name: s.name, proficiency: s.proficiency, endorsements: { count: ids.length, endorsedByMe: viewer !== undefined && ids.includes(viewer), endorserUserIds: [...ids] } };
    }),
    // Back-compat: rows stored before ADR 0025 lack `workflows` — normalize to [].
    workflows: p.workflows ?? [],
    pinnedAgentIds: p.pinnedAgentIds ?? [],
    pinnedChatAgentIds: p.pinnedChatAgentIds ?? [],
    completeness: computeCompleteness(p),
    ...(opts.emailVerified !== undefined ? { emailVerified: opts.emailVerified } : {}),
    ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
  };
}

/** ADR 0624 D4 — the owner's own view (`/me` lane ONLY): `viewProfile` +
 *  `completenessMissing` (weights not yet earned, heaviest first) so the meter
 *  can say what to do next. The viewer IS the owner, so `endorsedByMe` is always
 *  false here (no self-endorsement). */
export function viewOwnProfile(p: Profile, opts: Omit<ViewProfileOpts, 'viewerUserId'> = {}): OwnProfileView {
  return { ...viewProfile(p, { ...opts, viewerUserId: p.userId }), completenessMissing: completenessMissing(p) };
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

// ── Review F6 — the ONE profile write path ──────────────────────────────────
// Every profile mutation is a read-modify-write; a blind `put` loses whichever
// concurrent write commits first (PROF-4 proved it for endorsements — the same
// family survived on every other lane). All writers now route through this CAS
// helper: the mutate fn is PURE + SYNC and re-runs against a fresh read on each
// retry, so the loser merges instead of clobbering. Exhaustion is an honest 409.

const CAS_ATTEMPTS = 5;
type ProfileMutation = (current: Profile) => Profile | 'unchanged' | 'abort';

/** ADR 0624 D3 — what a CAS write reports to its writer. `before` is the WINNING
 *  attempt's `current` (the row the committed write was diffed against — well-
 *  defined and linearised, so two concurrent writers cannot both claim the same
 *  transition); `changed` is false on `'unchanged'` (then `profile === before`).
 *  The writers diff `before` vs `profile` to emit — never this helper, which can
 *  throw `not_found` from the loop and must stay emit-free. */
export interface CasWrite {
  profile: Profile;
  changed: boolean;
  before: Profile;
}

async function casMutateProfile(
  tenantId: string,
  userId: string,
  mutate: ProfileMutation,
  opts: { createIfMissing?: boolean } = {},
): Promise<CasWrite | null> {
  const createIfMissing = opts.createIfMissing ?? true;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = createIfMissing
      ? await getOrCreateProfile(tenantId, userId)
      : await getProfile(tenantId, userId);
    if (!current) return null;
    const next = mutate(current);
    if (next === 'abort') return null;
    if (next === 'unchanged') return { profile: current, changed: false, before: current };
    if (await store.compareAndSwap(current, next)) return { profile: next, changed: true, before: current };
    // Lost the race — re-read and re-apply the mutation on the fresh row.
  }
  throw new OpenwopError('conflict', 'The profile was updated concurrently — please retry.', 409, { userId });
}

/** Review F1 — a byte ref this profile just let go of (cleared/replaced/removed
 *  avatar or portfolio token, or a deleted profile's refs). Demotes the token
 *  back to the scratch TTL UNLESS something still references it (this or another
 *  profile in the tenant, or a media-library row) — `releaseByteRef` runs the
 *  full referent check. Called AFTER the row write commits so the post-write
 *  state is what gets checked. */
async function releaseProfileByteRef(tenantId: string, token: string | undefined): Promise<void> {
  if (!token) return;
  await releaseByteRef(tenantId, token);
}

/** Pin / unpin a roster member to the caller's sidebar (ADR 0023 — pinned
 *  agents render as an indented sub-menu under "Agents"). Idempotent; preserves
 *  insertion order (newest pin last). A pure UI preference — no authority, and
 *  the caller can only pin agents that exist in their tenant (checked at the
 *  route). Capped to keep the sub-menu sane — the 13th pin is an HONEST 409
 *  (`validation_error`, `details.maxPinned`, mirroring the portfolio cap), never
 *  a silent eviction of the oldest pin (`PROF-10`, ADR 0624 D6). */
const MAX_PINNED = 12;
/** Where a pin lands: the sidebar sub-menu (`sidebar`) or the AI-chat welcome
 *  "hand it to an agent" row (`chat`). The two are independent. */
export type PinTarget = 'sidebar' | 'chat';
const PIN_FIELD: Record<PinTarget, 'pinnedAgentIds' | 'pinnedChatAgentIds'> = {
  sidebar: 'pinnedAgentIds',
  chat: 'pinnedChatAgentIds',
};

export async function setAgentPinned(
  tenantId: string,
  userId: string,
  rosterId: string,
  pinned: boolean,
  target: PinTarget = 'sidebar',
): Promise<Profile> {
  const field = PIN_FIELD[target];
  const updated = await casMutateProfile(tenantId, userId, (current) => {
    const list = current[field] ?? [];
    const have = new Set(list);
    if (pinned === have.has(rosterId)) return 'unchanged';
    if (pinned && list.length >= MAX_PINNED) {
      throw new OpenwopError('validation_error', `Pinned agents are full (max ${MAX_PINNED}).`, 409, { maxPinned: MAX_PINNED, target });
    }
    const next = pinned ? [...list, rosterId] : list.filter((id) => id !== rosterId);
    return { ...current, [field]: next, updatedAt: nowIso(), updatedBy: userId };
  });
  return updated!.profile; // ADR 0624 D3 — deliberately silent (ADR 0023 UI preference)
}

/** Merge a `knowledge` binding patch into the caller's own profile (ADR 0042) —
 *  the human counterpart of `setAgentKnowledge`. Shallow-merges onto the existing
 *  `knowledge` block (an explicit field replaces; absent fields are left). The
 *  binding stores only references (collectionIds); cited docs live in `kbService`.
 *  Self-owned — the route resolves the caller's own `userId`. Tenant-scoped. */
export async function setProfileKnowledge(
  tenantId: string,
  userId: string,
  patch: NonNullable<Profile['knowledge']>,
): Promise<Profile> {
  const updated = await casMutateProfile(tenantId, userId, (current) => ({
    ...current,
    knowledge: { ...(current.knowledge ?? {}), ...patch },
    updatedAt: nowIso(),
    updatedBy: userId,
  }));
  return updated!.profile; // ADR 0624 D3 — deliberately silent (ADR 0042: no `knowledge.bound`)
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
    await casMutateProfile(tenantId, p.userId, (current) => {
      const pinned = current.pinnedAgentIds ?? [];
      const chat = current.pinnedChatAgentIds ?? [];
      const nextPinned = pinned.filter((id) => !drop.has(id));
      const nextChat = chat.filter((id) => !drop.has(id));
      if (nextPinned.length === pinned.length && nextChat.length === chat.length) return 'unchanged';
      return { ...current, pinnedAgentIds: nextPinned, pinnedChatAgentIds: nextChat, updatedAt: nowIso(), updatedBy: 'system' };
    });
  }
}

/** Read a specific user's profile, tenant-scoped (IDOR guard — returns null for a
 *  foreign-tenant or missing profile, no existence leak). */
export async function getProfile(tenantId: string, userId: string): Promise<Profile | null> {
  const p = await store.get(userId);
  return p && p.tenantId === tenantId ? p : null;
}

/** The tenant directory — every profile in the tenant. PROF-3: rides the armed
 *  tenant secondary index (bounded scan of this tenant's slice), never a bare
 *  `list()` full-deployment scan + in-memory filter. Serves the directory route,
 *  the roster-cascade unpin, the workflow surface, and the KB backfill. */
export async function listProfiles(tenantId: string): Promise<Profile[]> {
  return store.listForTenantIndexed(tenantId);
}

export interface ProfilePatch {
  preferredName?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  bio?: string | null;
  contact?: ProfileContact | null;
  equipment?: string[];
  interests?: string[];
  growthInterests?: string[];
  availability?: ProfileAvailability | null;
}

/** Apply a self-edit patch to the caller's own profile. `null` clears a field;
 *  `undefined` leaves it. Bounds + secret-scrub are applied here. */
export async function updateOwnProfile(
  tenantId: string,
  userId: string,
  patch: ProfilePatch,
  opts: { silent?: boolean } = {},
): Promise<Profile> {
  const updated = await casMutateProfile(tenantId, userId, (current) => {
    const next: Profile = { ...current };

    const setText = (key: 'preferredName' | 'jobTitle' | 'department' | 'bio', max: number): void => {
      const v = patch[key];
      if (v === undefined) return;
      if (v === null) { delete next[key]; return; }
      next[key] = scrubSecretShaped(v.trim()).slice(0, max);
    };
    setText('preferredName', MAX.short);
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
    if (patch.growthInterests !== undefined) {
      // ADR 0356 P6 — same scrub discipline as interests.
      const cleaned = patch.growthInterests.slice(0, MAX.list).map((e) => scrubSecretShaped(e.trim()).slice(0, MAX.item)).filter((e) => e.length > 0);
      if (cleaned.length > 0) next.growthInterests = cleaned; else delete next.growthInterests;
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
    return next;
  });
  // ADR 0624 D3 — `updated` iff a non-bookkeeping field differs (an identical
  // PATCH emits nothing), then `crossed` iff a band moved. `silent` is the demo
  // seed lane (ADR 0617 D1 shape).
  if (!opts.silent) emitProfileWrite(tenantId, userId, updated!.before, updated!.profile);
  return updated!.profile;
}

// ── Phase 2: avatar + portfolio (media-asset references) ────────────────────
// The ROUTE validates a token resolves in the caller's tenant AND is an image
// (the `media-asset-url-tenant-scoped` invariant) before calling these; the
// service stores REFERENCES only — bytes never enter the profile store.
//
// Byte lifecycle (review F1/F2): a reference-IN promotes the token onto the
// durable lane AFTER the row write commits (a capacity 409 or any pre-write
// failure therefore never strands durable bytes), and a reference-OUT (clear,
// replace, remove, subject erasure) releases it — demoted back to the scratch
// TTL unless something still references it. Promotion failing after the write
// (the asset died in the window) UNWINDS the just-written reference and 404s —
// a profile must never durably reference dead bytes.

const MAX_PORTFOLIO = 24;

export async function setAvatarToken(tenantId: string, userId: string, token: string): Promise<Profile> {
  let previous: string | undefined;
  const updated = await casMutateProfile(tenantId, userId, (current) => {
    previous = current.avatarAssetToken;
    return { ...current, avatarAssetToken: token, updatedAt: nowIso(), updatedBy: userId };
  });
  if (!(await promoteToDurable(tenantId, token))) {
    // The asset vanished between the route's validation and this promotion —
    // unwind the reference (if still ours) and fail honestly. ADR 0624 D3: the
    // unwind is SILENT and the emit below is never reached — a dead-asset
    // promotion produces ZERO events (the row ends where it started).
    await casMutateProfile(tenantId, userId, (current) => {
      if (current.avatarAssetToken !== token) return 'unchanged';
      const next: Profile = { ...current, updatedAt: nowIso(), updatedBy: userId };
      delete next.avatarAssetToken;
      return next;
    });
    throw new OpenwopError('not_found', 'Media asset not found in this tenant.', 404, { token });
  }
  if (previous && previous !== token) await releaseProfileByteRef(tenantId, previous); // F1 — the overwritten token
  emitProfileWrite(tenantId, userId, updated!.before, updated!.profile); // ADR 0624 D3 — AFTER the promotion succeeded
  return updated!.profile;
}

export async function clearAvatar(tenantId: string, userId: string): Promise<Profile> {
  let previous: string | undefined;
  const updated = await casMutateProfile(tenantId, userId, (current) => {
    previous = current.avatarAssetToken;
    const next: Profile = { ...current, updatedAt: nowIso(), updatedBy: userId };
    delete next.avatarAssetToken;
    return next;
  });
  await releaseProfileByteRef(tenantId, previous); // F1 — the cleared token
  emitProfileWrite(tenantId, userId, updated!.before, updated!.profile); // ADR 0624 D3 (no avatar to clear ⇒ no field differs ⇒ silent)
  return updated!.profile;
}

/** Append a portfolio asset reference (idempotent, capped). Returns the profile
 *  (callers map to a view). */
export async function addPortfolioToken(tenantId: string, userId: string, token: string): Promise<Profile> {
  const updated = await casMutateProfile(tenantId, userId, (current) => {
    if (current.portfolioAssetTokens.includes(token)) return 'unchanged'; // idempotent
    if (current.portfolioAssetTokens.length >= MAX_PORTFOLIO) {
      // F2 — the capacity refusal fires BEFORE any promotion, so a full
      // portfolio can never strand durable bytes.
      throw new OpenwopError('validation_error', `Portfolio is full (max ${MAX_PORTFOLIO} items).`, 409, { maxPortfolio: MAX_PORTFOLIO });
    }
    return { ...current, portfolioAssetTokens: [...current.portfolioAssetTokens, token], updatedAt: nowIso(), updatedBy: userId };
  });
  if (!(await promoteToDurable(tenantId, token))) {
    // ADR 0624 D3 — silent unwind; the emit below is never reached (ZERO events).
    await casMutateProfile(tenantId, userId, (current) => {
      if (!current.portfolioAssetTokens.includes(token)) return 'unchanged';
      return { ...current, portfolioAssetTokens: current.portfolioAssetTokens.filter((t) => t !== token), updatedAt: nowIso(), updatedBy: userId };
    });
    throw new OpenwopError('not_found', 'Media asset not found in this tenant.', 404, { token });
  }
  emitProfileWrite(tenantId, userId, updated!.before, updated!.profile); // ADR 0624 D3 — AFTER the promotion; the idempotent re-add is 'unchanged' ⇒ silent
  return updated!.profile;
}

/** Remove a portfolio asset reference. Returns null if the token wasn't present
 *  (so the route can 404 honestly). */
export async function removePortfolioToken(tenantId: string, userId: string, token: string): Promise<Profile | null> {
  const updated = await casMutateProfile(tenantId, userId, (current) => {
    if (!current.portfolioAssetTokens.includes(token)) return 'abort';
    return {
      ...current,
      portfolioAssetTokens: current.portfolioAssetTokens.filter((t) => t !== token),
      updatedAt: nowIso(),
      updatedBy: userId,
    };
  });
  if (!updated) return null;
  await releaseProfileByteRef(tenantId, token); // F1 — the removed token
  emitProfileWrite(tenantId, userId, updated.before, updated.profile); // ADR 0624 D3
  return updated.profile;
}


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
  opts: { silent?: boolean } = {},
): Promise<Profile> {
  const updated = await casMutateProfile(tenantId, userId, (current) => {
    // Recomputed per CAS attempt against the FRESH row (F6): an endorsement that
    // lands concurrently is picked up by the retry instead of being dropped.
    const priorEndorsements = new Map(current.skills.map((s) => [s.name.toLowerCase(), s.endorsements]));
    const byName = new Map<string, ProfileSkill>();
    for (const raw of skills.slice(0, MAX_SKILLS)) {
      const name = scrubSecretShaped(String(raw.name ?? '').trim()).slice(0, MAX.item);
      if (!name) continue;
      const proficiency = Math.max(1, Math.min(5, Math.round(Number(raw.proficiency))));
      byName.set(name.toLowerCase(), { name, proficiency, endorsements: priorEndorsements.get(name.toLowerCase()) ?? [] });
    }
    return { ...current, skills: [...byName.values()], updatedAt: nowIso(), updatedBy: userId };
  });
  if (!opts.silent) emitProfileWrite(tenantId, userId, updated!.before, updated!.profile); // ADR 0624 D3
  return updated!.profile;
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
  const seen = new Set<string>();
  const workflows: string[] = [];
  for (const raw of workflowIds.slice(0, MAX_WORKFLOWS)) {
    const id = String(raw ?? '').trim().slice(0, MAX.item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    workflows.push(id);
  }
  const updated = await casMutateProfile(tenantId, userId, (current) => ({
    ...current, workflows, updatedAt: nowIso(), updatedBy: userId,
  }));
  emitProfileWrite(tenantId, userId, updated!.before, updated!.profile); // ADR 0624 D3
  return updated!.profile;
}

/** Add or remove an endorsement on `targetUserId`'s named skill. The CALLER
 *  (route) MUST have already enforced: the target profile exists, the skill
 *  exists, and the endorser is NOT the target (no self-endorsement). Idempotent:
 *  adding an existing endorser, or removing an absent one, is a no-op. Returns
 *  `{ profile, changed }` — `changed` is the CAS-WON transition flag (false on
 *  the idempotent no-op) so the route audits ONLY a real transition — or null if
 *  the skill vanished between check and write.
 *
 *  PROF-4 — the write is a CAS, not a blind put: two concurrent endorsers on
 *  the same profile each read the same baseline, and a last-writer-wins put
 *  silently dropped one endorsement. Routed through the shared `casMutateProfile`
 *  helper (F6) — the loser re-reads and merges; exhaustion is an honest 409. */
export async function setEndorsement(
  tenantId: string,
  targetUserId: string,
  skillName: string,
  endorserUserId: string,
  add: boolean,
): Promise<{ profile: Profile; changed: boolean } | null> {
  let skillLabel = skillName;
  const written = await casMutateProfile(tenantId, targetUserId, (p) => {
    const idx = p.skills.findIndex((s) => s.name.toLowerCase() === skillName.toLowerCase());
    if (idx === -1) return 'abort'; // skill vanished — the route 404s
    const skill = p.skills[idx]!;
    skillLabel = skill.name; // the stored (canonical) name, not the caller's casing
    const has = skill.endorsements.includes(endorserUserId);
    if (add === has) return 'unchanged'; // already in the desired state — idempotent no-op
    const endorsements = add
      ? [...skill.endorsements, endorserUserId]
      : skill.endorsements.filter((e) => e !== endorserUserId);
    const nextSkills = [...p.skills];
    nextSkills[idx] = { ...skill, endorsements };
    // NB: endorsing does NOT bump updatedAt/updatedBy — that tracks the OWNER's
    // edits, and an endorsement is a peer action, not the owner editing.
    return { ...p, skills: nextSkills };
  }, { createIfMissing: false });
  if (!written) return null;
  // ADR 0624 D3 — the CAS-WON transition only; 'unchanged' never emits, and an
  // endorsement is NOT a `profile.updated` (a peer action, not an owner edit).
  if (written.changed) {
    const ev = { tenantId, userId: targetUserId, endorserUserId, skill: skillLabel };
    if (add) endorsementGiven(ev); else endorsementRemoved(ev);
  }
  return { profile: written.profile, changed: written.changed };
}


// ADR 0081 P5 — time-based retention (ADR 0077 seam). Delete this tenant's profiles NOT
// touched within the window — age on `updatedAt` (dormant descriptive data; a profile
// re-materializes empty on the next read, so this drops stale PII without breaking an
// active user). No-op on a falsy tenant / non-PII classification (fail-closed).
registerRetentionPurger({
  feature: 'profiles',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('profiles', await store.listForTenantIndexed(tenantId), tenantId, cutoffIso,
      (p) => ({ tenantId: p.tenantId, updatedAt: p.updatedAt, id: p.userId }),
      // GRADE DATA-2: cascade to the Team Portfolio KB so retention doesn't orphan
      // a departed member's descriptive PII as a searchable doc. Best-effort import
      // (runtime-only use → the profiles↔kb-service cycle is safe).
      async (id) => { await store.delete(id); await removeProfile(tenantId, id); });
  },
});

// GDPR data-subject erasure (subject-erasure seam, ADR 0077 / ADR 0081 follow-up): a
// profile IS the descriptive PII of the person identified by `userId`, and a DSAR
// `subjectKey` is documented as an anon id OR a `User.userId` — so when it is the userId,
// `subjectKey === profile.userId` is exactly "this subject's own profile". Tenant-guarded
// (never a foreign-tenant delete), fail-closed on a falsy subject. Returns whether a row
// was deleted. The complement of the time-based purger above (erase-by-subject, age-blind).
export async function deleteSubjectProfile(tenantId: string, subjectKey: string): Promise<boolean> {
  return (await eraseProfileSubject(tenantId, subjectKey)).deleted;
}

/** The full erasure outcome: the subject's OWN row (if any, tenant-scoped) and
 *  the PEER rows its endorser id was stripped from (D5). The registered eraser
 *  reports the sum as `rowsTouched` so a fan-out that matched nothing is not
 *  reported as success (`foundNothing`). */
export async function eraseProfileSubject(tenantId: string, subjectKey: string): Promise<{ deleted: boolean; peersStripped: number }> {
  if (!subjectKey) return { deleted: false, peersStripped: 0 };
  const p = await store.get(subjectKey);
  let deleted = false;
  if (p && p.tenantId === tenantId) { // fail-closed, tenant-scoped
    deleted = await store.delete(subjectKey);
    // Review F1 — erasing the row must also reclaim the promoted BYTES, or the
    // subject's face stays fetchable forever on the unauthenticated
    // /assets/:token route (retention inversion). Released AFTER the row delete
    // so a surviving co-referent (another profile using the same token) keeps it.
    if (deleted) {
      await releaseProfileByteRef(tenantId, p.avatarAssetToken);
      for (const token of p.portfolioAssetTokens ?? []) await releaseProfileByteRef(tenantId, token);
    }
  }
  // ADR 0624 D5 / PROF-8 — the subject's id also lives in every PEER's
  // `skills[].endorsements` in this tenant (`setEndorsement` writes the endorser's
  // id into the TARGET's row); the ADR 0464 ratchet is keyed on the subject's OWN
  // row and cannot see the embedding. Strip it — guarded on the `user:` key so
  // the resolver's EMAIL key (`subjectErasure.ts` passes both) does not waste a
  // scan. Runs whether or not the subject had an own row here (an endorser never
  // needs one). Reach: the ERASING tenant only (ADR 0042 home-tenant rows; no
  // tenant-axis expansion — WF-TWIN-3).
  const peersStripped = subjectKey.startsWith('user:') ? await stripEndorsementsBy(tenantId, subjectKey) : 0;
  return { deleted, peersStripped };
}

/** Remove `endorserUserId` from every peer's `skills[].endorsements` in the
 *  tenant (the `unpinAgentsForTenant` shape): indexed scan, pre-filtered so
 *  only rows that HOLD the id are CAS-written; `'unchanged'` writes nothing.
 *  Deliberately silent — no `endorsement.removed` fan-out (the users `erased`
 *  event already names the person), and no `updatedAt` bump (an endorsement is
 *  a peer action, not the owner editing). Returns the rows rewritten. */
export async function stripEndorsementsBy(tenantId: string, endorserUserId: string): Promise<number> {
  let touched = 0;
  for (const row of await store.listForTenantIndexed(tenantId)) {
    if (row.userId === endorserUserId) continue;
    if (!(row.skills ?? []).some((s) => (s.endorsements ?? []).includes(endorserUserId))) continue;
    const written = await casMutateProfile(tenantId, row.userId, (current) => {
      let changed = false;
      const skills = (current.skills ?? []).map((s) => {
        if (!(s.endorsements ?? []).includes(endorserUserId)) return s;
        changed = true;
        return { ...s, endorsements: s.endorsements.filter((e) => e !== endorserUserId) };
      });
      return changed ? { ...current, skills } : 'unchanged';
    }, { createIfMissing: false });
    if (written?.changed) touched += 1;
  }
  return touched;
}

/**
 * Review F4 — one-shot app-migration backfill for profiles that stored a
 * SCRATCH-lane token before the PROF-1 promotion existed: promote every live
 * avatar/portfolio token onto the durable lane, and CLEAR refs whose asset is
 * already gone (a dead ref renders as a broken image forever; the row should
 * say what the media store says). Idempotent (promotion is monotonic; a cleared
 * ref stays cleared) and concurrency-safe (per-row CAS mutate; concurrent runs
 * converge on the same state).
 */
export async function backfillProfileMediaDurability(): Promise<{ examined: number; promoted: number; cleared: number; failed: number }> {
  let examined = 0;
  let promoted = 0;
  let cleared = 0;
  let failed = 0;
  for (const row of await store.list()) {
    examined += 1;
    try {
      const dead = new Set<string>();
      const candidates = [row.avatarAssetToken, ...(row.portfolioAssetTokens ?? [])].filter((t): t is string => Boolean(t));
      for (const token of candidates) {
        if (await promoteToDurable(row.tenantId, token)) promoted += 1;
        else dead.add(token);
      }
      if (dead.size === 0) continue;
      cleared += dead.size;
      await casMutateProfile(row.tenantId, row.userId, (current) => {
        const next: Profile = { ...current };
        let changed = false;
        if (next.avatarAssetToken && dead.has(next.avatarAssetToken)) { delete next.avatarAssetToken; changed = true; }
        const kept = (next.portfolioAssetTokens ?? []).filter((t) => !dead.has(t));
        if (kept.length !== (next.portfolioAssetTokens ?? []).length) { next.portfolioAssetTokens = kept; changed = true; }
        return changed ? next : 'unchanged';
      });
    } catch {
      failed += 1; // named in the migration log; never fatal to boot
    }
  }
  return { examined, promoted, cleared, failed };
}

export const profileEraser = async (tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> => {
  const r = await eraseProfileSubject(tenantId, subjectKey);
  return { rowsTouched: (r.deleted ? 1 : 0) + r.peersStripped };
};
registerSubjectEraser(profileEraser);

// PROF-1 — profile avatar/portfolio tokens are promoted onto the DURABLE byte
// lane (routes.ts `requireImageToken`) but have no `media:asset` library row, so
// the ADR 0579 orphan sweep would reclaim them as unreferenced. Declare them as
// live external references (bounded per-tenant indexed scan; a throw here makes
// the sweep fail closed for the tenant rather than delete on partial knowledge).
registerExternalByteRefProvider(async (tenantId) => {
  const refs: string[] = [];
  for (const p of await store.listForTenantIndexed(tenantId)) {
    if (p.avatarAssetToken) refs.push(p.avatarAssetToken);
    for (const t of p.portfolioAssetTokens ?? []) refs.push(t);
  }
  return refs;
});

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetProfiles(): Promise<void> {
  await store.__clear();
}
