/**
 * Which traffic the recorder captures (ADR 0812; ADR 0196 Gate B). The backend is
 * unversioned (`/runs`, `/host/openwop-app/…`), so the old `path.startsWith('/v1/')` test
 * matched nothing once v1 was withdrawn: a backend on its OWN origin was never
 * recorded. Same-origin traffic is backend traffic only behind `/api` or on
 * discovery; a third party never is — whatever its path. That last half is a privacy
 * guard (e.g. identitytoolkit carries Firebase ID tokens), and the ORIGIN check is its
 * only guard for a third-party path that looks like ours (`/api/…`, `/.well-known/openwop`).
 *
 * Sabotage that turns it red: classifying a foreign origin as 'spa' or 'backend',
 * dropping the backend-origin match, the discovery prefix, or the `/api/` path filter.
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
    // Paths the SPA-origin path filter WOULD accept — only the origin check refuses these.
    await window.fetch('https://identitytoolkit.googleapis.com/api/accounts');
    await window.fetch('https://evil.example/.well-known/openwop');
    // Positive control in this case: the recorder is live (it pushes before its await).
    await window.fetch('http://backend.test/runs/r-3p-control');
    expect(recorded('/runs/r-3p-control')).toBe(true);
    const foreign = rec.listNetworkEntries().filter((e) => e.url.startsWith('https://'));
    expect(foreign.map((e) => e.url)).toEqual([]);
  });
});
