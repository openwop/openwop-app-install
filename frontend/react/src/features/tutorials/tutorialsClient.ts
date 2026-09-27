/**
 * Tutorials client (ADR 0488 P2) — progress reads/writes against the host-ext
 * routes, with a `localStorage` floor.
 *
 * The floor is not a nicety. Progress was `localStorage`-only before this
 * (ADR 0490), and `/tutorials` is always-on for signed-out visitors too, so the
 * server lane must DEGRADE to local rather than replace it:
 *
 *   signed in  → server row is authoritative; local copy is a cache/offline floor
 *   anonymous  → `persisted:false`; local only, and the UI says so
 *   read fails → local only, surfaced as a failed read — NEVER as "no progress",
 *                which would read to the learner as their work being lost
 *
 * That last arm is the app's dominant defect class (failed-read-rendered-as-
 * empty); here a failure is distinguishable from genuinely-empty by `ok`.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface TutorialProgressRow {
  tutorialId: string;
  completedStepIds: string[];
  updatedAt: string;
}

export interface TutorialProgressResult {
  /** False ⇒ the read FAILED. Distinct from `rows: []`, which means "no progress yet". */
  ok: boolean;
  /** False ⇒ no durable subject (anonymous); the client owns the truth locally. */
  persisted: boolean;
  rows: TutorialProgressRow[];
}

const BASE = '/host/openwop-app/tutorials';

export async function fetchTutorialProgress(): Promise<TutorialProgressResult> {
  try {
    const res = await fetch(`${config.baseUrl}${BASE}/progress`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return { ok: false, persisted: false, rows: [] };
    const body = (await res.json()) as { progress?: TutorialProgressRow[]; persisted?: boolean };
    return { ok: true, persisted: body.persisted === true, rows: body.progress ?? [] };
  } catch {
    return { ok: false, persisted: false, rows: [] };
  }
}

/**
 * Persist one tutorial's completed steps. Resolves false when the write did not
 * land (anonymous, offline, server error) so the caller can keep the local copy
 * and stay honest about it — never a silent success.
 */
/**
 * Persist this tutorial's completed steps.
 *
 * `mode:'clear'` marks the RESET path explicitly. The server unions on a
 * concurrent-write conflict so a completion is never lost across devices
 * (grade-data `TUT-7`), and a reset is the one write whose purpose is removal —
 * it must never be unioned back.
 *
 * Returns the AUTHORITATIVE stored list when the server had to merge, so the
 * caller can adopt it rather than sitting on a set the server no longer holds.
 */
export async function saveTutorialProgress(
  tutorialId: string,
  completedStepIds: string[],
  mode?: 'clear',
): Promise<{ ok: boolean; merged?: string[] }> {
  try {
    const res = await fetch(`${config.baseUrl}${BASE}/progress`, fetchOpts({
      method: 'POST',
      headers: authedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ tutorialId, completedStepIds, ...(mode ? { mode } : {}) }),
    }));
    if (!res.ok) return { ok: false };
    const body = (await res.json().catch(() => ({}))) as { merged?: unknown; completedStepIds?: unknown };
    // Only adopt when the server SAYS it merged and hands back a usable list —
    // a malformed body must not silently replace the learner's state.
    if (body.merged === true && Array.isArray(body.completedStepIds)) {
      return { ok: true, merged: body.completedStepIds.filter((s): s is string => typeof s === 'string') };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** One tutorial card as the catalog route returns it. */
export interface TutorialSummary {
  id: string;
  category: string;
  title: string;
  description: string;
  difficulty?: string;
  estimatedMinutes?: number;
  surfaces?: string[];
  /** 'kernel' = this workspace's own (possibly edited) row; 'seed' = the shipped copy. */
  source: 'kernel' | 'seed';
  customized?: boolean;
}

export interface TutorialCatalogResult {
  ok: boolean;
  /** True when the server served shipped seeds because the content store was unreachable. */
  degraded: boolean;
  tutorials: TutorialSummary[];
}

/**
 * The workspace's tutorial catalog.
 *
 * `ok:false` means the READ failed — distinct from an empty list. The caller
 * falls back to the in-tree library rather than rendering "no tutorials", which
 * would be indistinguishable from a workspace that genuinely has none.
 */
export async function fetchTutorials(): Promise<TutorialCatalogResult> {
  try {
    const res = await fetch(`${config.baseUrl}${BASE}`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return { ok: false, degraded: false, tutorials: [] };
    const body = (await res.json()) as { tutorials?: TutorialSummary[]; degraded?: boolean };
    return { ok: true, degraded: body.degraded === true, tutorials: body.tutorials ?? [] };
  } catch {
    return { ok: false, degraded: false, tutorials: [] };
  }
}

/** One tutorial in full. `null` = not found OR the read failed; the caller floors
 *  to the in-tree copy either way, so the reader never dead-ends. */
export async function fetchTutorial(slug: string): Promise<{ ok: boolean; tutorial: unknown | null }> {
  try {
    const res = await fetch(`${config.baseUrl}${BASE}/${encodeURIComponent(slug)}`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return { ok: res.status === 404, tutorial: null };
    const body = (await res.json()) as { tutorial?: unknown };
    return { ok: true, tutorial: body.tutorial ?? null };
  } catch {
    return { ok: false, tutorial: null };
  }
}
