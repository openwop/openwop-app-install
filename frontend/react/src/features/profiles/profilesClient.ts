/**
 * Profiles API client (ADR 0005). Mirrors the backend /host/openwop-app/profiles
 * surface. Avatar/portfolio images are uploaded to the shared media surface and
 * referenced here by token (the same pattern the chat attachment path uses).
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { cachedRead } from '../../client/requestCache.js';
import { readErrorCode, readErrorMessage } from '../../client/errorEnvelope.js';
import { noteSessionRefusal } from '../../client/sessionRefusal.js';
import { blobToBase64 } from '../../client/blobToBase64.js';
import type { AgentActivityItem } from '../../agents/rosterClient.js';

export type { AgentActivityItem };

export type AvailabilityStatus = 'available' | 'busy' | 'away';

/**
 * ADR 0624 D7 — a skill's endorsements as the ROUTE view projects them: the
 * count, whether the CALLER endorsed it (decided server-side from the acting
 * user, so the SPA never re-derives it from an id list), and the opaque
 * endorser ids (same-tenant, team-visible by design — ADR 0005). Every route
 * that serves a profile (`/me`, `/team`, `GET /:userId`, the endorse toggle)
 * projects this shape; the stored `string[]` never reaches the wire.
 */
export interface ProfileSkillEndorsements {
  count: number;
  endorsedByMe: boolean;
  endorserUserIds: string[];
}
export interface ProfileSkill {
  name: string;
  proficiency: number;
  endorsements: ProfileSkillEndorsements;
}

/**
 * ADR 0624 D4 — the profile field ids `completenessMissing[].field` can carry,
 * mirroring the backend's ONE weights table (`profiles/completeness.ts`,
 * `COMPLETENESS_WEIGHTS`). Listed here so the meter caption's label map is
 * checked EXHAUSTIVELY at compile time against the contract, not left to a
 * raw-id fallback at runtime.
 */
export const COMPLETENESS_FIELD_IDS = [
  'avatar', 'bio', 'skills', 'jobTitle', 'department', 'availability', 'interests', 'portfolio', 'equipment',
] as const;
export type CompletenessFieldId = (typeof COMPLETENESS_FIELD_IDS)[number];
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
export interface Profile {
  userId: string;
  tenantId: string;
  /** ADR 0320 — what agents should call you (preferred/first name). */
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
  /** ADR 0025 — the user's assigned-workflow portfolio (workflow ids). */
  workflows: string[];
  /** Roster member ids pinned to the sidebar (ADR 0023). */
  pinnedAgentIds: string[];
  /** Roster member ids pinned to the AI-chat welcome "hand it to an agent" row. */
  pinnedChatAgentIds?: string[];
  completeness: number;
  /**
   * ADR 0624 D4 / PROF-UX-14 — what the meter is missing, ordered by weight
   * desc, so the SPA can say what to do NEXT. SELF-ONLY: served by the `/me`
   * lane routes (`GET`/`PATCH /me`, avatar, portfolio, skills, workflows, pins)
   * and NEVER by `/team` or `GET /:userId` — hence optional on this shared
   * type; the meter caption renders nothing when absent. `field` is one of
   * `COMPLETENESS_FIELD_IDS` (typed loosely so a newer backend's id degrades
   * to the raw-id fallback instead of a type hole).
   */
  completenessMissing?: Array<{ field: CompletenessFieldId | (string & Record<never, never>); weight: number }>;
  emailVerified?: boolean;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
}

const base = `${config.baseUrl}/host/openwop-app/profiles`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/**
 * The typed failure this client throws (the `usersClient.UsersApiError` shape).
 * Carries the HTTP `status`, the canonical envelope's machine-readable `code`
 * (`validation_error`, `not_found`, `forbidden`, …) and its `details`, so a
 * caller can key a DESIGNED state on the contract — the pin cap answers
 * `409 validation_error { maxPinned, target }` (ADR 0624 D6 / PROF-10) and the
 * agent workspace says "full (max N)" from `details.maxPinned`, never by
 * sniffing the English message.
 */
export class ProfilesApiError extends Error {
  readonly code: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /** The parsed envelope, for a caller that needs more than code + details. */
  readonly body: unknown;
  constructor(message: string, readonly status: number, body?: unknown) {
    super(message);
    this.name = 'ProfilesApiError';
    this.body = body;
    this.code = readErrorCode(body);
    this.details = readDetails(body);
  }
}

function readDetails(body: unknown): Readonly<Record<string, unknown>> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const d = (body as { details?: unknown }).details;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return undefined;
  return d as Record<string, unknown>;
}

/** The pin cap, when `err` is the backend's 409 for it (`details.maxPinned`);
 *  `undefined` for every other failure so the caller falls through to its
 *  generic copy. */
export function pinLimitOf(err: unknown): number | undefined {
  if (!(err instanceof ProfilesApiError) || err.status !== 409) return undefined;
  const max = err.details?.maxPinned;
  return typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : undefined;
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    // ADR 0621 D5 — a session-refusal 401 runs the hard sign-out choke.
    noteSessionRefusal(res.status, body);
    throw new ProfilesApiError(readErrorMessage(body) || `${ctx} returned ${res.status}`, res.status, body);
  }
  return (await res.json()) as T;
}

/** The token-scoped serve URL for a stored avatar/portfolio asset. */
export function assetUrl(token: string): string {
  return `${config.baseUrl}/host/openwop-app/assets/${encodeURIComponent(token)}`;
}

export interface ProfilePatch {
  preferredName?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  bio?: string | null;
  contact?: ProfileContact | null;
  equipment?: string[];
  interests?: string[];
  availability?: ProfileAvailability | null;
}

export async function getMyProfile(): Promise<Profile> {
  // Read on mount by the welcome card and every chat session. Coalesce concurrent
  // reads (TTL 0 = in-flight-only); updateMyProfile reflects on the next read.
  return cachedRead('profiles.me', 0, async () => {
    const res = await fetch(`${base}/me`, fetchOpts({ headers: authedHeaders() }));
    return asJson<Profile>(res, 'getMyProfile');
  });
}

export async function updateMyProfile(patch: ProfilePatch): Promise<Profile> {
  const res = await fetch(`${base}/me`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Profile>(res, 'updateMyProfile');
}

export async function listProfiles(): Promise<Profile[]> {
  const res = await fetch(base, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ profiles: Profile[] }>(res, 'listProfiles');
  return body.profiles;
}

export async function getProfile(userId: string): Promise<Profile> {
  const res = await fetch(`${base}/${encodeURIComponent(userId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<Profile>(res, 'getProfile');
}

export async function setMySkills(skills: { name: string; proficiency: number }[]): Promise<Profile> {
  const res = await fetch(`${base}/me/skills`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ skills }) }));
  return asJson<Profile>(res, 'setMySkills');
}

/** Replace the caller's assigned-workflow portfolio (ADR 0025). */
/** Pin or unpin an agent to the caller's sidebar (ADR 0023). */
export async function setAgentPinned(rosterId: string, pinned: boolean): Promise<Profile> {
  const res = await fetch(`${base}/me/pinned-agents/${encodeURIComponent(rosterId)}`, fetchOpts({ method: pinned ? 'PUT' : 'DELETE', headers: authedHeaders() }));
  return asJson<Profile>(res, 'setAgentPinned');
}

/** Pin or unpin an agent to the AI-chat welcome "hand it to an agent" row. */
export async function setChatAgentPinned(rosterId: string, pinned: boolean): Promise<Profile> {
  const res = await fetch(`${base}/me/pinned-chat-agents/${encodeURIComponent(rosterId)}`, fetchOpts({ method: pinned ? 'PUT' : 'DELETE', headers: authedHeaders() }));
  return asJson<Profile>(res, 'setChatAgentPinned');
}

export async function setMyWorkflows(workflows: string[]): Promise<Profile> {
  const res = await fetch(`${base}/me/workflows`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ workflows }) }));
  return asJson<Profile>(res, 'setMyWorkflows');
}

/** The caller's own run-activity feed (ADR 0025) — runs their personal board /
 *  schedule fired on their behalf, newest first. The user-side mirror of an
 *  agent's activity feed. `truncated` ⇒ the scan window was hit. */
export async function getMyActivity(): Promise<{ items: AgentActivityItem[]; truncated: boolean }> {
  const res = await fetch(`${base}/me/activity`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ items: AgentActivityItem[]; truncated?: boolean }>(res, 'getMyActivity');
  return { items: body.items, truncated: body.truncated ?? false };
}

export async function setAvatar(token: string): Promise<Profile> {
  const res = await fetch(`${base}/me/avatar`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ token }) }));
  return asJson<Profile>(res, 'setAvatar');
}

export async function clearAvatar(): Promise<Profile> {
  const res = await fetch(`${base}/me/avatar`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  return asJson<Profile>(res, 'clearAvatar');
}

export async function addPortfolio(token: string): Promise<Profile> {
  const res = await fetch(`${base}/me/portfolio`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ token }) }));
  return asJson<Profile>(res, 'addPortfolio');
}

export async function removePortfolio(token: string): Promise<Profile> {
  const res = await fetch(`${base}/me/portfolio/${encodeURIComponent(token)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  return asJson<Profile>(res, 'removePortfolio');
}

export async function endorseSkill(userId: string, skill: string): Promise<Profile> {
  const res = await fetch(`${base}/${encodeURIComponent(userId)}/skills/${encodeURIComponent(skill)}/endorse`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<Profile>(res, 'endorseSkill');
}

export async function unendorseSkill(userId: string, skill: string): Promise<Profile> {
  const res = await fetch(`${base}/${encodeURIComponent(userId)}/skills/${encodeURIComponent(skill)}/endorse`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  return asJson<Profile>(res, 'unendorseSkill');
}

/** Upload an image to the media surface and return its stored token. */
export async function uploadImage(file: File): Promise<string> {
  const contentBase64 = await blobToBase64(file);
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/media/upload`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ contentBase64, contentType: file.type, name: file.name }) }),
  );
  const body = await asJson<{ token: string }>(res, 'uploadImage');
  return body.token;
}
