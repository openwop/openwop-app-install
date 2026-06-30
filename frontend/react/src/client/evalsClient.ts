/**
 * ADR 0123 Phase 4a — eval leaderboard + arena FE client. The data layer for the
 * admin leaderboard view + the model arena: fetch the per-model win-rate/Elo
 * leaderboard, capture an arena winner, read a model's arena rating. Org-scoped.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

export interface Org { orgId: string; name: string }

/** The caller's orgs (the dashboard org picker). */
export async function listOrgs(): Promise<Org[]> {
  return (await http<{ orgs: Org[] }>('/v1/host/openwop-app/orgs')).orgs ?? [];
}

export interface LeaderboardRow {
  model: string;
  up: number;
  down: number;
  neutral: number;
  total: number;
  winRate: number;
  elo: number;
}

const BASE = (orgId: string): string => `/v1/host/openwop-app/evals/orgs/${encodeURIComponent(orgId)}`;

export async function fetchLeaderboard(orgId: string): Promise<LeaderboardRow[]> {
  return (await http<{ leaderboard: LeaderboardRow[] }>(`${BASE(orgId)}/leaderboard`)).leaderboard ?? [];
}

export async function captureArenaMatch(orgId: string, input: { modelA: string; modelB: string; winner: 'A' | 'B' | 'tie' }): Promise<{ ratingA: number; ratingB: number }> {
  return http<{ ratingA: number; ratingB: number }>(`${BASE(orgId)}/arena/match`, { method: 'POST', body: JSON.stringify(input) });
}

export async function fetchArenaRating(orgId: string, model: string): Promise<number> {
  return (await http<{ elo: number }>(`${BASE(orgId)}/arena/rating?model=${encodeURIComponent(model)}`)).elo;
}
