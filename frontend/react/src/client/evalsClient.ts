/**
 * ADR 0123 Phase 4a — eval leaderboard + arena FE client. The data layer for the
 * admin leaderboard view + the model arena: fetch the attributed board (chat ratings + arena
 * standings + coverage) and capture an arena verdict on two runs. Org-scoped. ADR 0986: the board is server-attributed, the arena run-bound.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string; details?: { reason?: unknown } };
    throw new EvalsHttpError(
      `${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`,
      res.status,
      typeof err.details?.reason === 'string' ? err.details.reason : null,
    );
  }
  return body as T;
}

/** A refused evals request. `reason` carries the server's machine-readable cause
 *  (e.g. `arena_same_model`), so the arena can say WHY a verdict was refused
 *  instead of "retry" — most refusals are permanent for that pair (ADR 0986). */
export class EvalsHttpError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string | null) {
    super(message);
    this.name = 'EvalsHttpError';
  }
}

export interface Org { orgId: string; name: string }

/** The caller's orgs (the dashboard org picker). */
export async function listOrgs(): Promise<Org[]> {
  return (await http<{ orgs: Org[] }>('/host/openwop-app/orgs')).orgs ?? [];
}

/** One model's chat-ratings row (ADR 0986 D3). Attributed by the SERVER to the
 *  model that answered; `managed` marks a managed tier, `simulated` the mock. */
export interface LeaderboardRow {
  key: string;
  provider: string;
  model: string;
  managed?: true;
  simulated?: true;
  up: number;
  down: number;
  neutral: number;
  total: number;
  raters: number;
  winRate: number;
  /** Wilson 95% lower bound — the ranking score. */
  score: number;
}

/** One model's arena standing (ADR 0986 D5) — a Bradley–Terry fit, Elo scale. */
export interface ArenaStanding {
  key: string;
  provider: string;
  model: string;
  managed?: true;
  rating: number;
  wins: number;
  losses: number;
  ties: number;
  matches: number;
}

export interface EvalsBoard {
  leaderboard: LeaderboardRow[];
  arena: ArenaStanding[];
  /** Ratings the server could (not) attribute to a model. */
  coverage: { attributed: number; unattributed: number };
}

const BASE = (orgId: string): string => `/host/openwop-app/evals/orgs/${encodeURIComponent(orgId)}`;

export async function fetchEvalsBoard(orgId: string): Promise<EvalsBoard> {
  const b = await http<Partial<EvalsBoard>>(`${BASE(orgId)}/leaderboard`);
  return { leaderboard: b.leaderboard ?? [], arena: b.arena ?? [], coverage: b.coverage ?? { attributed: 0, unattributed: 0 } };
}

/** The chat-ratings rows only (the dashboard tile). */
export async function fetchLeaderboard(orgId: string): Promise<LeaderboardRow[]> {
  return (await fetchEvalsBoard(orgId)).leaderboard;
}

export interface ArenaMatchResult {
  /** The models that ANSWERED, named by the server after the vote. */
  match: { modelA: string; modelB: string; providerA?: string; providerB?: string; winner: 'A' | 'B' | 'tie' };
  ratingA: number;
  ratingB: number;
  /** The pair was already voted on; `match.winner` is the stored verdict. */
  replayed?: true;
}

/** A verdict on two of the caller's own conversation runs (ADR 0986 D4). */
export async function captureArenaMatch(orgId: string, input: { runIdA: string; runIdB: string; winner: 'A' | 'B' | 'tie' }): Promise<ArenaMatchResult> {
  return http<ArenaMatchResult>(`${BASE(orgId)}/arena/match`, { method: 'POST', body: JSON.stringify(input) });
}
