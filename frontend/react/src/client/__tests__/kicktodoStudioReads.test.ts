/**
 * DESIGN.md §4.6 / ADR 0415 D5 (KTC-3) — the Studio side reads separate "the server has nothing here"
 * (404 → null, an honest empty state) from "the read failed" (anything else →
 * throws). Before this, every failure collapsed to `null`, so a 500 on the gate
 * matrix rendered "No gate status yet." on the publish decision.
 *
 * Breaks it: a read that swallows a non-404 failure into `null` again, or one
 * that throws on a 404 (which would turn every not-yet-simulated candidate into
 * an error).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getCandidate,
  getPublication,
  getGateStatus,
  getSimulationVerdicts,
  getLessonStatus,
  getMonitorReport,
  StudioRequestError,
} from '../kicktodoStudioClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

function status(code: number): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x' }), {
    status: code, headers: { 'content-type': 'application/json' },
  })));
}

const READS: Array<[string, (id: string) => Promise<unknown>]> = [
  ['getCandidate', getCandidate],
  ['getPublication', getPublication],
  ['getGateStatus', getGateStatus],
  ['getSimulationVerdicts', getSimulationVerdicts],
  ['getLessonStatus', getLessonStatus],
  ['getMonitorReport', getMonitorReport],
];

describe('studio side reads: 404 is empty, a failure is a failure', () => {
  it.each(READS)('%s resolves null on 404', async (_name, read) => {
    status(404);
    await expect(read('cand:1')).resolves.toBeNull();
  });

  it.each(READS)('%s rejects with the status on a 500', async (_name, read) => {
    status(500);
    const err = await read('cand:1').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StudioRequestError);
    expect((err as StudioRequestError).status).toBe(500);
  });

  it('unwraps the gate list on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ gates: [{ gate: 'evidence', state: 'pass' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await expect(getGateStatus('cand:1')).resolves.toEqual([{ gate: 'evidence', state: 'pass' }]);
  });
});
