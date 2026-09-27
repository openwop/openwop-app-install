/**
 * ADR 0339 — viewer state machine: entry renders the bound page's sections +
 * the step position; Continue advances via `/next` and renders the next step;
 * a complete payload shows the designed done state; a failed entry shows the
 * uniform unavailable state (no leak).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FunnelViewerPage } from '../FunnelViewerPage.js';

const step = (ix: number, stepId: string, pageSlug: string) => ({ ix, stepId, kind: 'landing', pageSlug, formContext: { funnelId: 'fun:1', stepId } });
const page = (title: string) => ({ slug: 's', title, sections: [{ sectionId: 'x', type: 'richText', data: { text: title } }], updatedAt: '', seo: {} });

function mockRoutes(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    for (const [frag, body] of Object.entries(routes)) {
      if (u.includes(frag)) return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }));
}

const renderViewer = () => render(<MemoryRouter><FunnelViewerPage orgId="org:1" slug="launch" /></MemoryRouter>);

describe('FunnelViewerPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the entry step page + position, and advances to complete via Continue', async () => {
    mockRoutes({
      '/funnels/launch/next': { funnel: { slug: 'launch', name: 'Launch' }, stepCount: 1, complete: true },
      '/funnels/launch': { funnel: { slug: 'launch', name: 'Launch' }, stepCount: 1, step: step(0, 's0', 'p0') },
      '/pages/p0': page('Welcome'),
    });
    renderViewer();
    await screen.findByText('Welcome');
    expect(screen.getByText('Step 1 of 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText(/all done/);
  });

  it('shows the uniform unavailable state when the funnel 404s', async () => {
    mockRoutes({});
    renderViewer();
    await screen.findByText(/isn’t available/);
  });
});
