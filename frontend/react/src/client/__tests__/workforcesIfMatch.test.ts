/**
 * ADR 0775 P4 follow-up (`ARWF-11`, workforce PATCH) — the cut-over and
 * migration writes carry the read copy's version as `If-Match`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchMigrationJourney, updateWorkforceStatus } from '../workforcesClient.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('workforces client', () => {
  it('sends the read version as a quoted If-Match on both writes, and none without one', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const ifMatchOf = (i: number): string | null => new Headers(fetchMock.mock.calls[i]![1]?.headers).get('If-Match');
    await updateWorkforceStatus('w1', 'piloting', { ifMatch: 'v1' });
    await updateWorkforceStatus('w1', 'shadow');
    await patchMigrationJourney('w1', { stageStatus: { assess: 'done' } }, { ifMatch: 'j1' });
    await patchMigrationJourney('w1', { stageStatus: { assess: 'done' } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(ifMatchOf(0)).toBe('"v1"');
    expect(ifMatchOf(1)).toBeNull();
    expect(ifMatchOf(2)).toBe('"j1"');
    expect(ifMatchOf(3)).toBeNull();
  });
});
