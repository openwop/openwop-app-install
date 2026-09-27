/**
 * ADR 0534 P5 — the work-selection read client.
 *
 * One read. There is no write client and there should not be one: weights are
 * edited through Priority Matrix's existing criteria-set editor, not a second
 * editor here (ADR 0534 matrix row 10).
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';

const base = `${config.baseUrl}/host/openwop-app/work-selection`;

/** One criterion's contribution to a card's rank. */
export interface RankReason {
  criterionId: string;
  /** Human-facing criterion name, supplied by the server so the client does not
   *  re-derive the vocabulary from ids. */
  criterion: string;
  value: number;
}

export interface RankedCard {
  cardId: string;
  title: string;
  rank: number;
  score: number;
  why: RankReason[];
}

/**
 * The ranking the agent would apply to this board's To Do lane right now.
 *
 * A 404 means the feature is off for this workspace (`requireFeatureEnabled`
 * answers 404, not 403, so a disabled feature is indistinguishable from a
 * missing one). The caller renders nothing in that case rather than an error —
 * an off feature is not a fault.
 */
export type RankingResult =
  /** The feature is off for this workspace (404). Render nothing — not an error. */
  | { kind: 'disabled' }
  /** The read failed. Distinct from `disabled` so a broken route is not invisible. */
  | { kind: 'error' }
  | { kind: 'ok'; ranked: RankedCard[] };

export async function getBoardRanking(boardId: string): Promise<RankingResult> {
  let res: Response;
  try {
    res = await fetch(
      `${base}/boards/${encodeURIComponent(boardId)}/ranking`,
      fetchOpts({ headers: authedHeaders() }),
    );
  } catch {
    return { kind: 'error' }; // network/offline
  }
  // `requireFeatureEnabled` answers 404 for a disabled feature, so 404 is the
  // "off" signal. Any OTHER non-ok status is a genuine fault and must not be
  // laundered into silence — that is what made a broken route invisible.
  if (res.status === 404) return { kind: 'disabled' };
  if (!res.ok) return { kind: 'error' };
  try {
    const body = (await res.json()) as { ranked?: RankedCard[] };
    return { kind: 'ok', ranked: body.ranked ?? [] };
  } catch {
    return { kind: 'error' };
  }
}
