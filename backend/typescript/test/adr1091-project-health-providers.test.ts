/**
 * ADR 1091 — project health providers. The route returns the charter's own
 * value (the override) and the first provider's computed reading, behind the
 * project's read gate. A throwing provider and an invalid reading are skipped
 * and named in `failed`; a provider with no reading defers to the next; a
 * private project's non-member gets the uniform 404.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, type Client } from './planningHarness.js';
import { createProject, setProjectVisibility, updateProject } from '../src/features/projects/projectsService.js';
import { PROVIDER_TIMEOUT_MS, registerProjectHealthProvider, resolveComputedProjectHealth, __resetProjectHealthProviders } from '../src/host/projectHealthProviders.js';

const H = '/host/openwop-app';
let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;
beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('projects', 'on').catch(() => undefined);
});
afterAll(async () => { __resetProjectHealthProviders(); await closeApp(); });
beforeEach(() => { __resetProjectHealthProviders(); });

async function firm(): Promise<{ tenantId: string; owner: Client; ownerId: string; orgId: string; viewer: Client }> {
  const tenantId = `org:h1091-${Date.now()}-${n++}`;
  const owner = makeClient(() => BASE);
  const ownerId = (await owner.post(`${H}/test/login`, { email: `o-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post(`${H}/orgs`, { name: 'Studio' })).body.orgId as string;
  const viewer = makeClient(() => BASE);
  const viewerId = (await viewer.post(`${H}/test/login`, { email: `v-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId as string;
  await owner.post(`${H}/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Vic', subject: viewerId, roles: ['viewer'] });
  return { tenantId, owner, ownerId, orgId, viewer };
}
const reading = (level: string, reason = 'Two decisions are late.') => ({ level, reason, source: 'Test records', asOf: '2027-01-25' }) as never;

describe('ADR 1091 — project health providers', () => {
  it('returns the manual value and the first provider reading; skips failures', async () => {
    const f = await firm();
    const p = await createProject(f.tenantId, f.orgId, { name: 'Atlas' }, f.ownerId);
    await updateProject(f.tenantId, p.id, { charter: { health: 'on-track' } });
    registerProjectHealthProvider('none', async () => undefined);
    registerProjectHealthProvider('throws', async () => { throw new Error('boom'); });
    registerProjectHealthProvider('invalid', async () => ({ level: 'great', reason: '', source: 'x', asOf: 'today' }) as never);
    registerProjectHealthProvider('real', async ({ project }) => (project.id === p.id ? reading('at-risk') : undefined));
    registerProjectHealthProvider('later', async () => reading('off-track'));
    registerProjectHealthProvider('real', async () => reading('off-track')); // idempotent by id: ignored
    const r = await f.owner.get(`${H}/projects/${encodeURIComponent(p.id)}/health`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ manual: 'on-track', computed: { level: 'at-risk', reason: 'Two decisions are late.', source: 'Test records', providerId: 'real' }, failed: ['throws', 'invalid'] });
    // The single-project read carries it too, so the page needs no second request.
    expect((await f.owner.get(`${H}/projects/${encodeURIComponent(p.id)}`)).body.computedHealth).toMatchObject({ level: 'at-risk', providerId: 'real' });
  });

  it('no providers: computed is null; a private project hides from a non-member', async () => {
    const f = await firm();
    const p = await createProject(f.tenantId, f.orgId, { name: 'Atlas' }, f.ownerId);
    const r = await f.viewer.get(`${H}/projects/${encodeURIComponent(p.id)}/health`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ manual: null, computed: null, failed: [] });
    await setProjectVisibility(f.tenantId, p.id, 'private');
    expect((await f.viewer.get(`${H}/projects/${encodeURIComponent(p.id)}/health`)).status).toBe(404);
    expect((await f.viewer.get(`${H}/projects/no-such/health`)).status).toBe(404);
  });

  it('a hung provider times out and the next one answers', async () => {
    vi.useFakeTimers();
    try {
      registerProjectHealthProvider('hung', () => new Promise(() => undefined));
      registerProjectHealthProvider('next', async () => reading('on-track', 'All clear.'));
      const pending = resolveComputedProjectHealth({ tenantId: 't', project: { id: 'p' } as never });
      await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS + 1);
      const out = await pending;
      expect(out.failed).toEqual(['hung']);
      expect(out.computed).toMatchObject({ providerId: 'next', level: 'on-track' });
    } finally { vi.useRealTimers(); }
  });

  it('trims and bounds a reason', async () => {
    registerProjectHealthProvider('long', async () => reading('at-risk', `  ${'x'.repeat(900)}  `));
    const out = await resolveComputedProjectHealth({ tenantId: 't', project: { id: 'p' } as never });
    expect(out.computed!.reason.length).toBe(500);
  });
});
