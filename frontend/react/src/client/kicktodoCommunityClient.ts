/**
 * KickTodo community FE client (ADR 0426 P4) — React-free (the ADR 0413
 * shared-contract seam) over `/host/openwop-app/kicktodo/community/*`.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const BASE = `${config.baseUrl}/host/openwop-app/kicktodo/community`;

export interface ProfileOverlay { displayName?: string; bio?: string }

export interface CreatorProfile {
  handle: string;
  displayName: string;
  bio: string;
  links: string[];
  /** ADR 0453 P2 — per-locale overlays for displayName/bio (BCP-47 keys). */
  localizations?: Record<string, ProfileOverlay>;
  state: 'draft' | 'pending' | 'approved' | 'suspended';
}

export interface VisibleReview {
  rating: number;
  body?: string;
  provenance: string;
  createdAt: string;
}

export interface ReviewAggregate {
  count: number;
  average: number | null;
}

/**
 * Carries the HTTP status so a caller can tell a REFUSAL (403 — the proof gate)
 * from a transport/server failure. Without it the review composer reported every
 * failure, including a 429 from the per-IP read budget, as "you have not proven
 * participation" — a false statement to the user (KTUX-2).
 */
export class CommunityRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`community request failed: ${status}`);
    this.name = 'CommunityRequestError';
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    // KTUX-1: fetchOpts must be CALLED — it folds `init` in AND adds
    // `credentials: 'include'` in cookie mode. The bare `...fetchOpts` spread the
    // function object, sending every request unauthenticated (401 in production
    // cookie mode). Same defect as KTEXP-1 in the studio client.
    ...fetchOpts(init),
    headers: { 'content-type': 'application/json', ...authedHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new CommunityRequestError(res.status);
  return (await res.json()) as T;
}

export async function getMyProfile(): Promise<CreatorProfile | null> {
  return (await req<{ profile: CreatorProfile | null }>('/profile')).profile;
}

export async function saveProfile(input: { handle: string; displayName: string; bio?: string; links?: string[]; localizations?: Record<string, ProfileOverlay> }): Promise<CreatorProfile> {
  return await req<CreatorProfile>('/profile', { method: 'POST', body: JSON.stringify(input) });
}

export async function submitMyProfile(): Promise<CreatorProfile> {
  return await req<CreatorProfile>('/profile/submit', { method: 'POST', body: '{}' });
}

export async function getReviews(challengeId: string): Promise<{ reviews: VisibleReview[]; aggregate: ReviewAggregate }> {
  return await req(`/reviews/${encodeURIComponent(challengeId)}`);
}

export async function writeReview(input: { challengeId: string; challengeVersion: number; rating: number; body?: string }): Promise<void> {
  await req('/reviews', { method: 'POST', body: JSON.stringify(input) });
}
