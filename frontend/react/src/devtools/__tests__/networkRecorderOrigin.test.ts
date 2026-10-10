/**
 * Which traffic the recorder captures (ADR 0812). The backend is unversioned
 * (`/runs`, `/host/openwop-app/…`), so the old `path.startsWith('/v1/')` test
 * matched nothing once v1 was withdrawn: a backend on its OWN origin was never
 * recorded. Same-origin traffic is backend traffic only behind `/api` or on
 * discovery; a third party that happens to use `/v1/` never is.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../client/config.js', () => ({ config: { baseUrl: 'http://backend.test' } }));

let rec: typeof import('../networkRecorder.js');

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
  rec = await import('../networkRecorder.js');
  rec.installNetworkRecorder();
});

const recorded = (path: string) => rec.listNetworkEntries().some((e) => e.path === path);

describe('networkRecorder — origin and path filter', () => {
  it('records an unversioned call to a backend on its own origin', async () => {
    await window.fetch('http://backend.test/host/openwop-app/agents');
    await window.fetch('http://backend.test/runs/r-1');
    await vi.waitFor(() => expect(recorded('/host/openwop-app/agents') && recorded('/runs/r-1')).toBe(true));
  });

  it('records same-origin /api and discovery, but not an SPA page path', async () => {
    await window.fetch('/api/runs');
    await window.fetch('/.well-known/openwop');
    await window.fetch('/dashboard');
    await vi.waitFor(() => expect(recorded('/api/runs') && recorded('/.well-known/openwop')).toBe(true));
    expect(recorded('/dashboard')).toBe(false);
  });

  it('never records a third party, /v1/ or not', async () => {
    await window.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup');
    expect(recorded('/v1/accounts:lookup')).toBe(false);
  });
});
