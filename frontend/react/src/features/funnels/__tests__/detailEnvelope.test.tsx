/**
 * ADR 0294 correction (FUNNEL1, 2026-11-06) — the detail GET answers the
 * envelope `{ funnel, publicUrl }`, and `getFunnel` returns only its `funnel`.
 * Before the fix the envelope reached the editor and a new, step-less funnel
 * crashed the detail page on `funnel.steps.find`.
 *
 * Real transport decoding and the real detail route: only `fetch`, the
 * effective-access read and the other features' reads are controlled;
 * `getFunnel` is not mocked.
 *
 * Red when: getFunnel stops unwrapping `funnel`, stops encoding the caller's
 * org or funnel id into the path, turns a refusal into an entity, or the page
 * links the envelope's `publicUrl` instead of its own viewer/entry URLs.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { config } from '../../../client/config.js';
import type { Funnel, FunnelStats, Org } from '../funnelsClient.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }) }));
vi.mock('../../cms/cmsClient.js', () => ({ listPages: vi.fn(async () => []) }));
vi.mock('../../custom-domains/domainsClient.js', () => ({ listDomains: vi.fn(async () => []) }));
// A writer's effective access, as the server answers it (the page reads it per org).
vi.mock('../../../client/accessClient.js', async orig => ({
  ...await orig<typeof import('../../../client/accessClient.js')>(),
  getEffectiveAccess: vi.fn(async () => ({ roles: ['member'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' as const })),
}));
vi.mock('../funnelsClient.js', async orig => ({
  ...await orig<typeof import('../funnelsClient.js')>(),
  listOrgs: vi.fn(async (): Promise<Org[]> => [{ orgId: 'org-kick', name: 'QA KickTodo' }]),
  getFunnelStats: vi.fn(async (): Promise<FunnelStats> => ({ funnelId: 'new-funnel', steps: [], days: [], eventWindow: 30, rebuiltAt: null })),
}));
import { getFunnel, FunnelsError } from '../funnelsClient.js';
import { FunnelDetailPage } from '../FunnelDetailPage.js';
import { ErrorBoundary } from '../../../ui/ErrorBoundary.js';
const FUNNEL: Funnel = { funnelId: 'new-funnel', orgId: 'org-kick', name: 'QA KickTodo funnel', slug: 'qa-kick', status: 'draft', steps: [], createdAt: '', updatedAt: '' };
const FUNNELS = `${config.baseUrl}/host/openwop-app/funnels`;
const transport = vi.fn<typeof fetch>();
// A fresh Response per call: a body can be read once, as in production.
const answer = (body: unknown, status: number) => async (): Promise<Response> => new Response(JSON.stringify(body), { status });
beforeEach(() => { transport.mockReset().mockImplementation(answer({ funnel: FUNNEL, publicUrl: 'https://host.example/fn/org-kick/qa-kick' }, 200)); vi.stubGlobal('fetch', transport); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() {
  render(<MemoryRouter initialEntries={['/funnels/new-funnel?org=org-kick']}><ErrorBoundary fallback={error => <p>Funnel crashed: {error.message}</p>}><Routes><Route path="/funnels/:funnelId" element={<FunnelDetailPage />} /></Routes></ErrorBoundary></MemoryRouter>);
}
it('unwraps the existing GET envelope into the entity while preserving its actual empty steps', async () => {
  expect(await getFunnel('org-kick', 'new-funnel')).toEqual(FUNNEL);
  expect(String(transport.mock.calls[0]?.[0])).toBe(`${FUNNELS}/orgs/org-kick/funnels/new-funnel`);
  const root = { ...FUNNEL, orgId: 'ws:qa-root' };
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ funnel: root, publicUrl: 'https://host.example/fn/ws%3Aqa-root/qa-kick' }), { status: 200 }));
  expect(await getFunnel(root.orgId, root.funnelId)).toEqual(root);
  expect(String(transport.mock.calls[1]?.[0])).toBe(`${FUNNELS}/orgs/ws%3Aqa-root/funnels/new-funnel`);
});
it('renders the actual newly created empty funnel through its standalone detail route', async () => {
  mount();
  expect(await screen.findByRole('heading', { name: FUNNEL.name })).toBeTruthy();
  expect(screen.getByText('No steps yet. Add a step and bind it to a CMS page.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add step' })).toBeTruthy();
  expect(screen.queryByText(/Funnel crashed:/)).toBeNull();
});
it('preserves existing public link consumers rather than treating envelope publicUrl as entity data', async () => {
  transport.mockImplementation(answer({ funnel: { ...FUNNEL, status: 'published' }, publicUrl: 'https://host.example/server-entry' }, 200));
  mount(); await screen.findByRole('heading', { name: FUNNEL.name });
  // Pinned literally, never computed with the helpers the page uses.
  const viewer = `${window.location.origin}/fn/org-kick/qa-kick`;
  const entry = `${config.baseUrl}/host/openwop-app/public/org-kick/funnels/qa-kick`;
  expect(screen.getByRole('link', { name: viewer }).getAttribute('href')).toBe(viewer);
  expect(screen.getByRole('link', { name: entry }).getAttribute('href')).toBe(entry);
  expect(screen.queryByRole('link', { name: 'https://host.example/server-entry' })).toBeNull();
});
it('keeps caller-supplied org/path scope and propagates foreign-scope refusal without inventing an entity', async () => {
  transport.mockImplementation(answer({ message: 'Funnel not found.' }, 404));
  const refused = await getFunnel('foreign/org', 'funnel:opaque').then(() => null, (e: unknown) => e);
  expect(refused).toBeInstanceOf(FunnelsError);
  expect(refused).toMatchObject({ message: 'Funnel not found.', status: 404 });
  expect(String(transport.mock.calls[0]?.[0])).toBe(`${FUNNELS}/orgs/foreign%2Forg/funnels/funnel%3Aopaque`);
});
