/**
 * Profiles API client (ADR 0005). Mirrors the backend /v1/host/sample/profiles
 * surface. Avatar/portfolio images are uploaded to the shared media surface and
 * referenced here by token (the same pattern the chat attachment path uses).
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { blobToBase64 } from '../../chat/hooks/useAudioRecorder.js';

export type AvailabilityStatus = 'available' | 'busy' | 'away';

export interface ProfileSkill {
  name: string;
  proficiency: number;
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
  completeness: number;
  emailVerified?: boolean;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
}

const base = `${config.baseUrl}/v1/host/sample/profiles`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string };
      detail = body?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The token-scoped serve URL for a stored avatar/portfolio asset. */
export function assetUrl(token: string): string {
  return `${config.baseUrl}/v1/host/sample/assets/${encodeURIComponent(token)}`;
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

export async function getMyProfile(): Promise<Profile> {
  const res = await fetch(`${base}/me`, fetchOpts({ headers: authedHeaders() }));
  return asJson<Profile>(res, 'getMyProfile');
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
    `${config.baseUrl}/v1/host/sample/media/upload`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ contentBase64, contentType: file.type, name: file.name }) }),
  );
  const body = await asJson<{ token: string }>(res, 'uploadImage');
  return body.token;
}
