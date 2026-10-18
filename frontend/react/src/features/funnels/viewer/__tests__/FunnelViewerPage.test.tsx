/**
 * ADR 0339 — the PUBLIC funnel viewer, as an anonymous visitor's browser sees it.
 *
 * Two claims, each owned here (the step/progress/back/failure state machine is
 * `funnelViewerUpgrade.test.tsx`'s):
 * 1. The visitor's browser calls EXACTLY the public endpoints, in order: the
 *    entry read, the routed `/next?from=<stepId>`, and the public page read —
 *    each under `/host/openwop-app/public/<encoded org id>/…` (org ids carry a
 *    `:`), and nothing else (the consent posture read is the consent lane's,
 *    filtered out). Completion names THIS funnel.
 * 2. A 410 (unpublished) entry is the same uniform "isn’t available" posture as
 *    a 404, never the load-failed outage card. (The 404 twin is
 *    `funnelViewerUpgrade.test.tsx` › "a 404 entry keeps the uniform unavailable
 *    posture".)
 *
 * What breaks it: the org id not encoded in the public URL, `from` not naming
 * the step the visitor is leaving, an extra/foreign request, a 410 treated as an
 * outage, or the completion title naming the wrong funnel.
 * Sabotage-witnessed (round 2): `encodeURIComponent(orgId)` dropped from `PUB`,
 * `from: fromStepId` → a constant, 410 removed from the not-found branch, the
 * completion `funnelName` blanked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { config } from '../../../../client/config.js';
import { FunnelViewerPage } from '../FunnelViewerPage.js';

const step = (ix: number, stepId: string, pageSlug: string) => ({ ix, stepId, kind: 'landing', pageSlug, formContext: { funnelId: 'fun:1', stepId } });
const page = (title: string) => ({ slug: 's', title, sections: [{ sectionId: 'x', type: 'richText', data: { text: title } }], updatedAt: '', seo: {} });
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const PUBLIC = `${config.baseUrl}/host/openwop-app/public/org%3A1`;

/** EXACT-URL table. Unmatched → 404. Every non-consent URL is recorded. */
function mockExact(routes: Record<string, () => Response>): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (!u.includes('/public-consent/')) calls.push(u);
    const hit = routes[u];
    return hit ? hit() : new Response('{}', { status: 404 });
  }));
  return calls;
}

const renderViewer = () => render(<MemoryRouter><FunnelViewerPage orgId="org:1" slug="launch" /></MemoryRouter>);

describe('FunnelViewerPage — the public surface', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the entry step page + position, and advances to complete via Continue', async () => {
    const calls = mockExact({
      [`${PUBLIC}/funnels/launch`]: () => json({ funnel: { slug: 'launch', name: 'Launch' }, stepCount: 1, step: step(0, 's0', 'p0') }),
      [`${PUBLIC}/pages/p0`]: () => json(page('Welcome')),
      [`${PUBLIC}/funnels/launch/next?from=s0`]: () => json({ funnel: { slug: 'launch', name: 'Launch' }, stepCount: 1, complete: true }),
    });
    renderViewer();
    await screen.findByText('Welcome');
    expect(screen.getByText('Step 1 of 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Launch — all done')).toBeTruthy();
    // Exactly the three public reads, in order — no visitor key (no consent
    // decision was recorded), nothing outside the public lane.
    expect(calls).toEqual([
      `${PUBLIC}/funnels/launch`,
      `${PUBLIC}/pages/p0`,
      `${PUBLIC}/funnels/launch/next?from=s0`,
    ]);
  });

  it('a 410 (unpublished) entry shows the uniform unavailable state, never load-failed', async () => {
    mockExact({ [`${PUBLIC}/funnels/launch`]: () => new Response('{}', { status: 410 }) });
    renderViewer();
    expect(await screen.findByText('This funnel isn’t available')).toBeTruthy();
    expect(screen.queryByText(/couldn’t load this funnel/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
