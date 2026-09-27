/**
 * UX_UPGRADE-sharing — the public share viewer (SH-G1..SH-G3).
 *
 * Two properties matter and neither is cosmetic:
 *  - a capability-token URL must be marked `noindex` while it is on screen, and
 *    must NOT leave the whole app marked noindex once you navigate on;
 *  - a share is a point-in-time SNAPSHOT, and the recipient must be told so on
 *    EVERY resource type — which is why all four render branches now go through
 *    one frame.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import type { SharedResource } from '../sharingClient.js';

const resolveSharedPublic = vi.fn<() => Promise<SharedResource>>();
vi.mock('../sharingClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSharedPublic: () => resolveSharedPublic(),
}));
// The heavy lazy viewers aren't what these cases are about.
vi.mock('../../chat/artifacts/AppBuilderInteractiveViewer.js', () => ({ AppBuilderInteractiveViewer: () => <div data-testid="app-viewer" /> }));
vi.mock('../../slides/SharedDeckViewer.js', () => ({ SharedDeckViewer: () => <div data-testid="deck-viewer" /> }));
vi.mock('../SharedQuoteView.js', () => ({ SharedQuoteView: () => <div data-testid="quote-view" /> }));

const { SharedSharePage } = await import('../SharedSharePage.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); document.head.querySelector('meta[name="robots"]')?.remove(); });

const SNAP = '2026-07-01T09:00:00.000Z';
const robots = () => document.head.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null;

describe('shared viewer — unlisted head (SH-G3)', () => {
  it('marks the page noindex while mounted and RESTORES the head on unmount', async () => {
    resolveSharedPublic.mockResolvedValue({
      resourceType: 'conversation', resource: { title: 'Design chat', markdown: 'Hello' }, snapshotAt: SNAP,
    });
    const before = document.title;
    const view = render(<SharedSharePage token="tok" />);
    await screen.findByText('Design chat');

    // These are passive-effect side effects, so await them rather than reading
    // straight after `findByText` — the DOM can be observable a tick before the
    // effect that touches <head> has flushed.
    await waitFor(() => expect(robots()).toBe('noindex,nofollow'));
    // …and the tab gets a real name rather than the app default.
    await waitFor(() => expect(document.title).toBe('Design chat'));

    view.unmount();
    // The whole app must not be left unindexable by visiting one share link.
    await waitFor(() => expect(robots()).toBeNull());
    expect(document.title).toBe(before);
  });
});

describe('shared viewer — snapshot/live honesty on EVERY type (SH-G1/SH-G2, corrected by R2 SR-3)', () => {
  // R2 SR-3: only a CONVERSATION is actually snapshotted server-side, so only
  // it carries snapshotAt on the wire. Living types (no snapshotAt) must show
  // the LIVE disclosure instead of a false snapshot date.
  it('tells the recipient a conversation is a snapshot', async () => {
    resolveSharedPublic.mockResolvedValue({ resourceType: 'conversation', resource: { title: 'Design chat', markdown: 'Hi' }, snapshotAt: SNAP } as SharedResource);
    render(<SharedSharePage token="tok" />);
    await screen.findByText('Design chat');
    expect(screen.getByText(/snapshot from/i)).toBeTruthy();
    expect(screen.queryByText(/live view/i)).toBeNull();
  });

  const livingCases: Array<[string, SharedResource, string]> = [
    ['app design', { resourceType: 'app_builder_canvas', resource: { title: 'My app', app: {} } }, 'My app'],
    ['slide deck', { resourceType: 'slides_canvas', resource: { title: 'Q3 deck', deck: {} } }, 'Q3 deck'],
  ];
  for (const [label, payload, heading] of livingCases) {
    it(`tells the recipient a ${label} is a LIVE view, never a snapshot`, async () => {
      resolveSharedPublic.mockResolvedValue(payload);
      render(<SharedSharePage token="tok" />);
      await screen.findByText(heading);
      expect(screen.getByText(/live view/i)).toBeTruthy();
      expect(screen.queryByText(/snapshot from/i)).toBeNull();
    });
  }

  it('covers the quote type too (it has no title row of its own) — live, not snapshot', async () => {
    resolveSharedPublic.mockResolvedValue({ resourceType: 'commerce_quote', resource: {} } as SharedResource);
    render(<SharedSharePage token="tok" />);
    await screen.findByTestId('quote-view');
    expect(screen.getByText(/live view/i)).toBeTruthy();
    expect(screen.queryByText(/snapshot from/i)).toBeNull();
  });

  it('adds the expiry when the owner set one, and stays silent when they did not', async () => {
    resolveSharedPublic.mockResolvedValue({
      resourceType: 'conversation', resource: { title: 'Design chat', markdown: 'Hi' },
      snapshotAt: SNAP, expiresAt: '2026-08-01T00:00:00.000Z',
    });
    render(<SharedSharePage token="tok" />);
    await screen.findByText('Design chat');
    expect(screen.getByText(/link expires/i)).toBeTruthy();

    cleanup();
    resolveSharedPublic.mockResolvedValue({ resourceType: 'conversation', resource: { title: 'Design chat', markdown: 'Hi' }, snapshotAt: SNAP });
    render(<SharedSharePage token="tok" />);
    await screen.findByText('Design chat');
    expect(screen.queryByText(/link expires/i)).toBeNull();
  });

  it('claims no snapshot DATE when the server did not send one (the live line shows instead)', async () => {
    resolveSharedPublic.mockResolvedValue({ resourceType: 'conversation', resource: { title: 'Design chat', markdown: 'Hi' } });
    render(<SharedSharePage token="tok" />);
    await screen.findByText('Design chat');
    expect(screen.queryByText(/snapshot from/i)).toBeNull();
    expect(screen.getByText(/live view/i)).toBeTruthy();
  });
});

describe('shared viewer — dead and failed links (R2 SR-2/SR-10)', () => {
  it('a revoked link (kind: gone) still shows the designed gone state, with no snapshot claim', async () => {
    resolveSharedPublic.mockRejectedValue(Object.assign(new Error('not-found'), { kind: 'gone' }));
    render(<SharedSharePage token="tok" />);
    await screen.findByText(/no longer available/i);
    expect(screen.queryByText(/snapshot from/i)).toBeNull();
  });

  it('an expired link says it EXPIRED — not the generic gone copy', async () => {
    resolveSharedPublic.mockRejectedValue(Object.assign(new Error('expired'), { kind: 'expired' }));
    render(<SharedSharePage token="tok" />);
    await screen.findByText(/link has expired/i);
    expect(screen.queryByText(/no longer available/i)).toBeNull();
  });

  it('a FAILED resolve renders the retryable card, never the dead-link claim — and Retry re-resolves', async () => {
    resolveSharedPublic
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { kind: 'unavailable' }))
      .mockResolvedValueOnce({ resourceType: 'conversation', resource: { title: 'Back', markdown: 'hello' }, snapshotAt: '2026-08-01T00:00:00Z' });
    render(<SharedSharePage token="tok" />);
    await screen.findByText(/couldn.t load this shared view/i);
    expect(screen.queryByText(/no longer available/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Back');
  });
});

describe('R2 SR-1 — the picker default types RENDER (they used to say "Nothing to show here")', () => {
  it('a cms_page share renders its prerendered markdown', async () => {
    resolveSharedPublic.mockResolvedValue({
      resourceType: 'cms_page',
      resource: { title: 'Landing', markdown: '# Build faster\n\nShip the thing.' },
    } as SharedResource);
    render(<SharedSharePage token="tok" />);
    await screen.findByText('Build faster');
    expect(screen.getByText('Ship the thing.')).toBeTruthy();
    expect(screen.queryByText(/nothing to show here/i)).toBeNull();
  });

  it('a kb_collection share renders name + document list from the prerendered markdown', async () => {
    resolveSharedPublic.mockResolvedValue({
      resourceType: 'kb_collection',
      resource: { name: 'Handbook', markdown: 'Everything we know.\n\n**2 document(s)**\n\n- Doc One\n- Doc Two' },
    } as SharedResource);
    render(<SharedSharePage token="tok" />);
    await screen.findByText('Handbook');
    expect(screen.getByText('Doc One')).toBeTruthy();
    expect(screen.queryByText(/nothing to show here/i)).toBeNull();
  });
});
