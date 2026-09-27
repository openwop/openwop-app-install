/**
 * UX_UPGRADE-funnels — the visitor-facing step upgrades (FN-G1..FN-G4).
 *
 * The load-bearing case here is FN-G4: a failed `/next` must NOT throw the
 * visitor into the unavailable state. Losing a part-completed funnel to one
 * flaky request is the worst thing this screen can do, and the old code did
 * exactly that (`show(null)` → unavailable).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FunnelViewerPage } from '../FunnelViewerPage.js';

const step = (ix: number, stepId: string, pageSlug: string, name?: string) => ({
  ix, stepId, kind: 'landing', pageSlug, ...(name ? { name } : {}), formContext: { funnelId: 'fun:1', stepId },
});
const page = (title: string) => ({ slug: 's', title, sections: [{ sectionId: 'x', type: 'richText', data: { text: title } }], updatedAt: '', seo: {} });
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** Route table; a value of `null` means "this route fails" (non-2xx). */
function mockRoutes(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    for (const [frag, body] of Object.entries(routes)) {
      if (u.includes(frag)) return body === null ? new Response('{}', { status: 503 }) : json(body);
    }
    return new Response('{}', { status: 404 });
  }));
}

const renderViewer = () => render(<MemoryRouter><FunnelViewerPage orgId="org:1" slug="launch" /></MemoryRouter>);

const FUNNEL = { slug: 'launch', name: 'Launch' };

afterEach(() => vi.unstubAllGlobals());

describe('funnel viewer — progress (FN-G1) + stage label (FN-G3)', () => {
  it('exposes a real progressbar whose value tracks the step, with the stage name', async () => {
    mockRoutes({
      '/funnels/launch/steps/1': { funnel: FUNNEL, stepCount: 3, step: step(1, 's1', 'p1', 'Your details') },
      '/funnels/launch': { funnel: FUNNEL, stepCount: 3, step: step(0, 's0', 'p0', 'Welcome') },
      '/pages/p0': page('Hello'),
      '/pages/p1': page('Details'),
    });
    renderViewer();
    await screen.findByText('Hello');

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    // The stage LABEL, not a bare percentage — that's the researched difference.
    expect(bar.getAttribute('aria-valuetext')).toBe('Step 1 of 3 · Welcome');
    expect(screen.getByText('Welcome')).toBeTruthy();
  });

  it('omits the stage name cleanly when a step has none', async () => {
    mockRoutes({
      '/funnels/launch': { funnel: FUNNEL, stepCount: 2, step: step(0, 's0', 'p0') },
      '/pages/p0': page('Hello'),
    });
    renderViewer();
    await screen.findByText('Hello');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('Step 1 of 2');
  });
});

describe('funnel viewer — back (FN-G2)', () => {
  it('offers Back only past the first step, and moves the view WITHOUT completing anything', async () => {
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/funnels/launch/steps/0')) return json({ funnel: FUNNEL, stepCount: 3, step: step(0, 's0', 'p0', 'Welcome') });
      if (u.includes('/funnels/launch/steps/1')) return json({ funnel: FUNNEL, stepCount: 3, step: step(1, 's1', 'p1', 'Details') });
      if (u.includes('/pages/p0')) return json(page('Hello'));
      if (u.includes('/pages/p1')) return json(page('Details page'));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<MemoryRouter initialEntries={['/fn/org:1/launch?step=1']}><FunnelViewerPage orgId="org:1" slug="launch" /></MemoryRouter>);
    await screen.findByText('Details page');

    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    await screen.findByText('Hello');

    // The safety property: going back never hits `/next`, so no step is
    // completed and nothing the visitor already did is undone.
    expect(fetchSpy.mock.calls.every(([u]) => !String(u).includes('/next'))).toBe(true);
    // …and at the first step there is nothing to go back to.
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
  });
});

describe('funnel viewer — a failed advance keeps the funnel (FN-G4)', () => {
  it('keeps the current step, explains, and offers a retry instead of going unavailable', async () => {
    mockRoutes({
      '/funnels/launch/next': null, // the advance fails
      '/funnels/launch': { funnel: FUNNEL, stepCount: 3, step: step(0, 's0', 'p0', 'Welcome') },
      '/pages/p0': page('Hello'),
    });
    renderViewer();
    await screen.findByText('Hello');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByText(/couldn’t move you to the next step/i);
    // The step is STILL THERE — this is the regression that matters.
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByText(/isn’t available/)).toBeNull();
    // …and the primary action becomes an honest retry.
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('clears the failure once a retry succeeds', async () => {
    let failNext = true;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/funnels/launch/next')) {
        if (failNext) { failNext = false; return new Response('{}', { status: 503 }); }
        return json({ funnel: FUNNEL, stepCount: 2, complete: true });
      }
      if (u.includes('/funnels/launch')) return json({ funnel: FUNNEL, stepCount: 2, step: step(0, 's0', 'p0') });
      if (u.includes('/pages/p0')) return json(page('Hello'));
      return new Response('{}', { status: 404 });
    }));

    renderViewer();
    await screen.findByText('Hello');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('button', { name: /try again/i });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText(/all done/)).toBeTruthy());
  });
});

describe('funnel viewer — ROUND 2 (VP-R2-0/2/3)', () => {
  it('a successful advance issues NO redundant step refetch (the keystone — the old double-load doubled server view counts)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/next')) return json({ funnel: FUNNEL, stepCount: 2, step: step(1, 's1', 'p1', 'Two') });
      if (u.includes('/pages/p0')) return json(page('One body'));
      if (u.includes('/pages/p1')) return json(page('Two body'));
      if (u.includes('/funnels/launch')) return json({ funnel: FUNNEL, stepCount: 2, step: step(0, 's0', 'p0', 'One') });
      return new Response('{}', { status: 404 });
    }));
    renderViewer();
    await screen.findByText('One body');
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText('Two body');
    // Exactly one /next and one page read for the new step — and NO
    // /funnels/launch/steps/1 refetch triggered by the URL stamp.
    expect(calls.filter((u) => u.includes('/next'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/steps/1'))).toHaveLength(0);
  });

  it('a PAGE-read blip mid-session keeps the funnel (FN-G4 one layer down) and Retry recovers', async () => {
    let failPage = false;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/next')) return json({ funnel: FUNNEL, stepCount: 2, step: step(1, 's1', 'p1') });
      if (u.includes('/pages/p1')) return failPage ? new Response('{}', { status: 503 }) : json(page('Two body'));
      if (u.includes('/pages/p0')) return json(page('One body'));
      if (u.includes('/funnels/launch')) return json({ funnel: FUNNEL, stepCount: 2, step: step(0, 's0', 'p0') });
      return new Response('{}', { status: 404 });
    }));
    renderViewer();
    await screen.findByText('One body');
    failPage = true;
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    // The session survives: current step still on screen + the retryable notice.
    await screen.findByRole('alert');
    expect(screen.getByText('One body')).toBeTruthy();
    expect(screen.queryByText(/isn’t available/i)).toBeNull();

    failPage = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByText('Two body');
  });

  it('an ENTRY read failure renders load-failed with a working Retry — never "unavailable" (FN-R2-4)', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/pages/p0')) return json(page('One body'));
      if (u.includes('/funnels/launch')) return fail ? new Response('{}', { status: 503 }) : json({ funnel: FUNNEL, stepCount: 1, step: step(0, 's0', 'p0') });
      return new Response('{}', { status: 404 });
    }));
    renderViewer();
    await screen.findByText(/couldn’t load this funnel/i);
    expect(screen.queryByText(/isn’t available/i)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('One body');
  });

  it('a 404 entry keeps the uniform unavailable posture (the positive twin)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    renderViewer();
    await screen.findByText(/isn’t available/i);
  });

  it('completion renders the operator-authored CTA — and none when absent (never invented)', async () => {
    mockRoutes({
      '/next': { funnel: FUNNEL, stepCount: 1, complete: true, completionCta: { label: 'Get the guide', url: 'https://example.com/guide' } },
      '/pages/p0': page('One body'),
      '/funnels/launch': { funnel: FUNNEL, stepCount: 1, step: step(0, 's0', 'p0') },
    });
    renderViewer();
    await screen.findByText('One body');
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    const cta = await screen.findByRole('link', { name: 'Get the guide' });
    expect(cta.getAttribute('href')).toBe('https://example.com/guide');
  });

  it('an unsafe completion CTA URL renders NO link (javascript: never reaches the DOM)', async () => {
    mockRoutes({
      '/next': { funnel: FUNNEL, stepCount: 1, complete: true, completionCta: { label: 'Evil', url: 'javascript:alert(1)' } },
      '/pages/p0': page('One body'),
      '/funnels/launch': { funnel: FUNNEL, stepCount: 1, step: step(0, 's0', 'p0') },
    });
    renderViewer();
    await screen.findByText('One body');
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText(/thanks|complete/i);
    expect(screen.queryByRole('link', { name: 'Evil' })).toBeNull();
  });
});

describe('funnel viewer — the race machinery (R2R F1/F2, FN-R2-5)', () => {
  it('Back clicked while an advance page-read is IN FLIGHT wins — no forward yank (the second-await guard)', async () => {
    let releasePage: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/next')) return json({ funnel: FUNNEL, stepCount: 3, step: step(2, 's2', 'p2', 'Three') });
      if (u.includes('/pages/p2')) {
        // the SLOW half of the advance — held until the test releases it
        await new Promise<void>((r) => { releasePage = r; });
        return json(page('Three body'));
      }
      if (u.includes('/pages/p1')) return json(page('Two body'));
      if (u.includes('/pages/p0')) return json(page('One body'));
      if (u.includes('/steps/0')) return json({ funnel: FUNNEL, stepCount: 3, step: step(0, 's0', 'p0', 'One') });
      if (u.includes('/funnels/launch')) return json({ funnel: FUNNEL, stepCount: 3, step: step(1, 's1', 'p1', 'Two') });
      return new Response('{}', { status: 404 });
    }));
    renderViewer();
    await screen.findByText('Two body'); // entry serves step 1 (ix 1) in this fixture
    fireEvent.click(screen.getByRole('button', { name: /continue/i })); // /next resolves, page p2 HANGS
    await waitFor(() => expect(releasePage).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /back/i })); // Back mid-flight — must win
    await screen.findByText('One body');
    releasePage!(); // the stale page read resolves AFTER Back
    // The stale advance must not yank forward: step 0 stays.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Three body')).toBeNull();
    expect(screen.getByText('One body')).toBeTruthy();
  });

  it('a dead ?step deep link falls back to the ENTRY instead of dead-ending (FN-R2-5)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/steps/99')) return new Response('{}', { status: 404 });
      if (u.includes('/pages/p0')) return json(page('One body'));
      if (u.includes('/funnels/launch')) return json({ funnel: FUNNEL, stepCount: 1, step: step(0, 's0', 'p0') });
      return new Response('{}', { status: 404 });
    }));
    render(
      <MemoryRouter initialEntries={['/fn/org:1/launch?step=99']}>
        <FunnelViewerPage orgId="org:1" slug="launch" />
      </MemoryRouter>,
    );
    await screen.findByText('One body'); // recovered to the entry, not "unavailable"
    expect(screen.queryByText(/isn’t available/i)).toBeNull();
  });
});
