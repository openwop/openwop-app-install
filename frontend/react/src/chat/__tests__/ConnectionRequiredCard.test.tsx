/**
 * ADR 0189 Phase 2 — the connect-to-continue interrupt card.
 * Pins: Connect launches beginOAuth for a connectable provider; the resume
 * actions ({connected}/{skip}) flow through onAction; a capability-only prompt
 * (no providerId) falls back to the Access-hub link, not a dead Connect button.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

const { beginOAuth, listProviders } = vi.hoisted(() => ({ beginOAuth: vi.fn(), listProviders: vi.fn() }));
vi.mock('../../features/connections/connectionsClient.js', () => ({ beginOAuth, listProviders }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.label ? `${k}:${o.label}` : k) }) }));

import { ConnectionRequiredCard } from '../cards/ConnectionRequiredCard.js';
import type { CardProps } from '../registry/types.js';

function renderCard(connection: Record<string, unknown>, onAction = vi.fn()): { onAction: ReturnType<typeof vi.fn> } {
  const props: CardProps = {
    payload: { data: { profile: 'openwop-connection', connection } },
    onAction,
    isLoading: false,
    // `CardContext` requires both — an empty object left the card reading
    // undefined ids, which is not the shape it ever sees in production.
    context: { runId: 'run-1', tenantId: 't1' },
  };
  render(<ConnectionRequiredCard {...props} />);
  return { onAction };
}

beforeEach(() => { beginOAuth.mockReset(); listProviders.mockReset(); cleanup(); });

describe('ConnectionRequiredCard', () => {
  it('offers Connect for a host-configured provider and launches beginOAuth', async () => {
    listProviders.mockResolvedValue([{ id: 'google', oauthConfigured: true }]);
    renderCard({ ref: 'google', providerId: 'google', label: 'Google Workspace' });
    const connectBtn = await screen.findByText('connectionRequiredConnect:Google Workspace');
    expect(connectBtn).toBeTruthy();
    // NAVIGATION IS STUBBED, and the comment this replaces was wrong in a way that
    // cost gate runs. It said "window.location assignment is a jsdom no-op" — it is
    // not. `ConnectionRequiredControls` sets `window.location.href`, and jsdom
    // throws `Not implemented: navigation (except hash changes)`. The throw escapes
    // the click handler AFTER the assertion below has already passed, so the test
    // reports green while the run records an unhandled error — and `ci.sh` fails on
    // that ("This FAILS the run even though every test may report passing").
    //
    // It surfaced intermittently because whether the escaped error is attributed to
    // this file depends on worker timing, which is why it read as a flake twice
    // before anyone traced it.
    //
    // `beginOAuth` also gets a real URL: unmocked it resolves `undefined`, so the
    // component assigned `href = undefined` and jsdom tried to navigate to it.
    beginOAuth.mockResolvedValue('https://accounts.example.test/oauth?state=x');
    const nav: string[] = [];
    const realLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, pathname: '/', search: '', set href(v: string) { nav.push(v); }, get href() { return nav[nav.length - 1] ?? ''; } },
    });
    try {
      fireEvent.click(connectBtn);
      await waitFor(() => expect(beginOAuth).toHaveBeenCalledWith('google', expect.any(String)));
      // The launch actually happened: the component navigated to the URL it was
      // given. Asserting only `beginOAuth` would leave a component that fetched the
      // URL and dropped it indistinguishable from one that launched.
      await waitFor(() => expect(nav).toContain('https://accounts.example.test/oauth?state=x'));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });

  it('resume actions flow through onAction (connected carries providerId; skip is bare)', async () => {
    listProviders.mockResolvedValue([{ id: 'google', oauthConfigured: true }]);
    const { onAction } = renderCard({ providerId: 'google', label: 'Google Workspace' });
    fireEvent.click(screen.getByText('connectionRequiredContinue'));
    expect(onAction).toHaveBeenCalledWith('resolve', { action: 'connected', providerId: 'google' });
    fireEvent.click(screen.getByText('connectionRequiredSkip'));
    expect(onAction).toHaveBeenCalledWith('resolve', { action: 'skip' });
  });

  it('a capability-only prompt (no providerId) shows the Access-hub link, not Connect', () => {
    renderCard({ ref: 'capability:ticketing', category: 'ticketing' });
    expect(screen.getByText('connectionRequiredManage')).toBeTruthy();
    expect(screen.queryByText(/connectionRequiredConnect/)).toBeNull();
    expect(listProviders).not.toHaveBeenCalled();
  });
});
