/**
 * ADR 0458 §2.3 — the challenge-outline client wrappers hit the right route +
 * method, and pass the plan-validation defect list through VERBATIM.
 *
 * Breaks it: a wrong path or method, an un-encoded candidate id (ids carry `:`),
 * a 422 whose defects are dropped, a 409 that loses its published-conflict flag,
 * or an unexpected status that resolves instead of throwing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ensureOutlineCanvas, applyOutline, type OutlineDefect } from '../kicktodoStudioClient.js';
import { config } from '../config.js';

afterEach(() => { vi.unstubAllGlobals(); });

const CREATOR = `${config.baseUrl}/host/openwop-app/kicktodo/creator`;

/** A real `Response`, so `ok`/`status`/`json()` behave as they do in production. */
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('challenge-outline client', () => {
  it('ensureOutlineCanvas POSTs to /candidates/:id/outline and returns the canvas id', async () => {
    const m = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonRes({ canvasId: 'cv-1', seededFrom: 'plan', reused: false }));
    vi.stubGlobal('fetch', m);
    const r = await ensureOutlineCanvas('cand:9');
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toBe(`${CREATOR}/candidates/cand%3A9/outline`);
    expect(init?.method).toBe('POST');
    expect(r.canvasId).toBe('cv-1');
  });

  it('applyOutline surfaces a 422 defect envelope verbatim (never throws)', async () => {
    // The backend returns the standard error envelope: 422 with the defect list
    // under `details.defects` (the participant-facing honesty of validatePlan).
    const defects: OutlineDefect[] = [{ code: 'evidence-parity', message: 'Alternative evidence must match its day.', ref: 'day-3' }];
    const m = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonRes({ error: 'validation_error', message: 'nope', details: { defects } }, 422));
    vi.stubGlobal('fetch', m);
    const r = await applyOutline('cand:9');
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toBe(`${CREATOR}/candidates/cand%3A9/outline/apply`);
    expect(init?.method).toBe('POST');
    expect(r.applied).toBe(false);
    expect(r.defects).toEqual(defects);
  });

  it('applyOutline reports the persisted challenge version on a 200 pass', async () => {
    const m = vi.fn(async () => jsonRes({ revision: 4, challengeId: 'ch-1', challengeVersion: 4 }));
    vi.stubGlobal('fetch', m);
    const r = await applyOutline('cand:9');
    expect(r.applied).toBe(true);
    expect(r.defects).toEqual([]);
    expect(r.challengeVersion).toBe(4);
  });

  it('applyOutline flags a 409 published-draft conflict distinctly (never throws)', async () => {
    const m = vi.fn(async () => jsonRes({ error: 'conflict', message: 'already published' }, 409));
    vi.stubGlobal('fetch', m);
    const r = await applyOutline('cand:9');
    expect(r.applied).toBe(false);
    expect(r.publishedConflict).toBe(true);
    expect(r.defects).toEqual([]);
  });

  it('applyOutline throws on an unexpected failure (404 → generic error path)', async () => {
    const m = vi.fn(async () => jsonRes({ error: 'not_found' }, 404));
    vi.stubGlobal('fetch', m);
    await expect(applyOutline('cand:9')).rejects.toThrow('apply outline failed: 404');
  });
});
