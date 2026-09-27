/**
 * ADR 0458 §2.3 — the challenge-outline client wrappers hit the right route +
 * method, and pass the plan-validation defect list through VERBATIM.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ensureOutlineCanvas, applyOutline } from '../kicktodoStudioClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('challenge-outline client', () => {
  it('ensureOutlineCanvas POSTs to /candidates/:id/outline and returns the canvas id', async () => {
    const m = vi.fn(async () => jsonRes({ canvasId: 'cv-1', seededFrom: 'plan', reused: false }));
    vi.stubGlobal('fetch', m);
    const r = await ensureOutlineCanvas('cand-9');
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain('/kicktodo/creator/candidates/cand-9/outline');
    expect((init as RequestInit).method).toBe('POST');
    expect(r.canvasId).toBe('cv-1');
  });

  it('applyOutline surfaces a 422 defect envelope verbatim (never throws)', async () => {
    // The backend returns the standard error envelope: 422 with the defect list
    // under `details.defects` (the participant-facing honesty of validatePlan).
    const defects = [{ code: 'evidence-parity', message: 'Alternative evidence must match its day.', ref: 'day-3' }];
    const m = vi.fn(async () => jsonRes({ error: 'validation_error', message: 'nope', details: { defects } }, 422));
    vi.stubGlobal('fetch', m);
    const r = await applyOutline('cand-9');
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain('/kicktodo/creator/candidates/cand-9/outline/apply');
    expect((init as RequestInit).method).toBe('POST');
    expect(r.applied).toBe(false);
    expect(r.defects).toEqual(defects);
  });

  it('applyOutline reports the persisted challenge version on a 200 pass', async () => {
    const m = vi.fn(async () => jsonRes({ revision: 4, challengeId: 'ch-1', challengeVersion: 4 }));
    vi.stubGlobal('fetch', m);
    const r = await applyOutline('cand-9');
    expect(r.applied).toBe(true);
    expect(r.defects).toEqual([]);
    expect(r.challengeVersion).toBe(4);
  });

  it('applyOutline flags a 409 published-draft conflict distinctly (never throws)', async () => {
    const m = vi.fn(async () => jsonRes({ error: 'conflict', message: 'already published' }, 409));
    vi.stubGlobal('fetch', m);
    const r = await applyOutline('cand-9');
    expect(r.applied).toBe(false);
    expect(r.publishedConflict).toBe(true);
    expect(r.defects).toEqual([]);
  });

  it('applyOutline throws on an unexpected failure (404 → generic error path)', async () => {
    const m = vi.fn(async () => jsonRes({ error: 'not_found' }, 404));
    vi.stubGlobal('fetch', m);
    await expect(applyOutline('cand-9')).rejects.toThrow(/404/);
  });
});
