/**
 * KickTodo engagement FE client (ADR 0425 P4) — React-free (the ADR 0413
 * shared-contract seam) over `/host/openwop-app/kicktodo/engagement/*`.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const BASE = `${config.baseUrl}/host/openwop-app/kicktodo/engagement`;

export interface LeaderboardEntry {
  displayName: string;
  completedCount: number;
  rank: number;
  you: boolean;
}

export interface LeaderboardView {
  entries: LeaderboardEntry[];
  belowFloor: boolean;
}

export interface EngagementOptIn {
  displayName: string;
  optedInAt: string;
}

export interface KicktodoAward {
  awardId: string;
  kind: string;
  enrollmentId: string;
  earnedAt: string;
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
  if (!res.ok) throw new Error(`engagement request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getOptIn(): Promise<EngagementOptIn | null> {
  return (await req<{ optIn: EngagementOptIn | null }>('/opt-in')).optIn;
}

export async function joinLeaderboard(displayName: string): Promise<EngagementOptIn> {
  return await req<EngagementOptIn>('/opt-in', { method: 'POST', body: JSON.stringify({ displayName }) });
}

export async function leaveLeaderboard(): Promise<void> {
  await req('/opt-out', { method: 'POST', body: '{}' });
}

/** ADR 0641 decision 13 — one board per challenge. `challengeId` is REQUIRED by
 *  the route (a missing one is a 400, deliberately, so nothing silently falls
 *  back to the old cross-challenge board). A 404 means "not enrolled here". */
export async function getLeaderboard(challengeId: string): Promise<LeaderboardView> {
  return await req<LeaderboardView>(`/leaderboard?challengeId=${encodeURIComponent(challengeId)}`);
}

export async function getAwards(): Promise<KicktodoAward[]> {
  return (await req<{ awards: KicktodoAward[] }>('/awards')).awards;
}
