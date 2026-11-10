/** FUNNEL1: actual getFunnel transport decoding + real empty detail route.
 * Only fetch/other feature reads are controlled; getFunnel is not mocked. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { Funnel } from '../funnelsClient.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }) }));
vi.mock('../../cms/cmsClient.js', () => ({ listPages: vi.fn(async () => []) }));
vi.mock('../../custom-domains/domainsClient.js', () => ({ listDomains: vi.fn(async () => []) }));
vi.mock('../funnelsClient.js', async orig => ({
  ...await orig<Record<string, unknown>>(),
  listOrgs: vi.fn(async () => [{ orgId: 'org-kick', name: 'QA KickTodo' }]),
  getFunnelStats: vi.fn(async () => ({ funnelId: 'new-funnel', steps: [], days: [], eventWindow: 30, rebuiltAt: null })),
}));
import { getFunnel, funnelViewerUrl, publicFunnelUrl } from '../funnelsClient.js';
import { FunnelDetailPage } from '../FunnelDetailPage.js';
import { ErrorBoundary } from '../../../ui/ErrorBoundary.js';
const FUNNEL: Funnel = { funnelId: 'new-funnel', orgId: 'org-kick', name: 'QA KickTodo funnel', slug: 'qa-kick', status: 'draft', steps: [], createdAt: '', updatedAt: '' };
const transport = vi.fn<typeof fetch>();
beforeEach(() => { transport.mockReset().mockResolvedValue(new Response(JSON.stringify({ funnel: FUNNEL, publicUrl: 'https://host.example/fn/org-kick/qa-kick' }), { status: 200 })); vi.stubGlobal('fetch', transport); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() {
  render(<MemoryRouter initialEntries={['/funnels/new-funnel?org=org-kick']}><ErrorBoundary fallback={error => <p>Funnel crashed: {error.message}</p>}><Routes><Route path="/funnels/:funnelId" element={<FunnelDetailPage />} /></Routes></ErrorBoundary></MemoryRouter>);
}
it('unwraps the existing GET envelope into the entity while preserving its actual empty steps', async () => {
  expect(await getFunnel('org-kick', 'new-funnel')).toEqual(FUNNEL);
  expect(String(transport.mock.calls[0]?.[0])).toMatch(/\/funnels\/orgs\/org-kick\/funnels\/new-funnel$/);
  const root = { ...FUNNEL, orgId: 'ws:qa-root' };
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ funnel: root, publicUrl: 'https://host.example/fn/ws%3Aqa-root/qa-kick' }), { status: 200 }));
  expect(await getFunnel(root.orgId, root.funnelId)).toEqual(root);
  expect(String(transport.mock.calls[1]?.[0])).toMatch(/\/orgs\/ws%3Aqa-root\/funnels\/new-funnel$/);
});
it('renders the actual newly created empty funnel through its standalone detail route', async () => {
  mount();
  expect(await screen.findByRole('heading', { name: FUNNEL.name })).toBeTruthy();
  expect(screen.getByText('No steps yet. Add a step and bind it to a CMS page.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add step' })).toBeTruthy();
  expect(screen.queryByText(/Funnel crashed:/)).toBeNull();
});
it('preserves existing public link consumers rather than treating envelope publicUrl as entity data', async () => {
  transport.mockResolvedValue(new Response(JSON.stringify({ funnel: { ...FUNNEL, status: 'published' }, publicUrl: 'https://host.example/server-entry' }), { status: 200 }));
  mount(); await screen.findByRole('heading', { name: FUNNEL.name });
  expect(screen.getByRole('link', { name: funnelViewerUrl('org-kick', 'qa-kick') }).getAttribute('href')).toBe(funnelViewerUrl('org-kick', 'qa-kick'));
  expect(screen.getByRole('link', { name: publicFunnelUrl('org-kick', 'qa-kick') }).getAttribute('href')).toBe(publicFunnelUrl('org-kick', 'qa-kick'));
  expect(screen.queryByRole('link', { name: 'https://host.example/server-entry' })).toBeNull();
});
it('keeps caller-supplied org/path scope and propagates foreign-scope refusal without inventing an entity', async () => {
  transport.mockResolvedValue(new Response(JSON.stringify({ message: 'Funnel not found.' }), { status: 404 }));
  await expect(getFunnel('foreign/org', 'funnel:opaque')).rejects.toThrow('Funnel not found.');
  expect(String(transport.mock.calls[0]?.[0])).toMatch(/\/orgs\/foreign%2Forg\/funnels\/funnel%3Aopaque$/);
});
