/**
 * ADR 0820 §7 — the export client walks the door's pages (`page.nextOffset`) and
 * merges every section into ONE document; a refusal is a typed error, never an
 * empty export — also when a LATER page fails (no half-export).
 *
 * Witnessed (wave 52): ignoring `nextOffset`, replacing instead of appending a
 * section, returning the paging envelope, swallowing a non-OK response, and a
 * wrong status on the thrown error each turn a case red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFeatureExport } from '../dataExportClient.js';
import { ApiError } from '../../../client/errorEnvelope.js';
import { config } from '../../../client/config.js';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
// The door's path, as a literal (not built from the client's own constant).
const ROOT = `${config.baseUrl}/host/openwop-app/export/features`;
afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchFeatureExport', () => {
  it('merges every page in order and drops the paging envelope', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      seen.push(u);
      return u.endsWith('offset=0')
        ? json({ featureId: 'funnels', readOnly: true, access: 'plan-lapsed', exportedAt: '2026-10-07T00:00:00Z', sections: { funnels: [1, 2] }, page: { offset: 0, limit: 2, totals: { funnels: 3 }, nextOffset: 2 } })
        : json({ featureId: 'funnels', readOnly: true, access: 'plan-lapsed', exportedAt: '2026-10-07T00:00:00Z', sections: { funnels: [3] }, page: { offset: 2, limit: 2, totals: { funnels: 3 }, nextOffset: null } });
    }));
    const doc = await fetchFeatureExport('funnels');
    expect(seen).toEqual([`${ROOT}/funnels?offset=0`, `${ROOT}/funnels?offset=2`]);
    expect(doc.sections.funnels).toEqual([1, 2, 3]);
    expect('page' in doc).toBe(false);
  });

  it('a refusal throws a typed ApiError carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'switched off' }, 403)));
    const err: unknown = await fetchFeatureExport('funnels').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, message: 'switched off' });
  });

  it('a failure on a LATER page rejects — never the first page as the whole export', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (String(url).endsWith('offset=0')
      ? json({ featureId: 'funnels', readOnly: true, access: 'plan-lapsed', exportedAt: '2026-10-07T00:00:00Z', sections: { funnels: [1, 2] }, page: { offset: 0, limit: 2, totals: { funnels: 3 }, nextOffset: 2 } })
      : json({ message: 'upstream down' }, 500))));
    const err: unknown = await fetchFeatureExport('funnels').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500 });
  });
});
