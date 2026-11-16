/**
 * ADR 0189 Phase 2 — the connect-to-continue interrupt card.
 * Pins: Connect launches beginOAuth for a connectable provider; the resume
 * actions ({connected}/{skip}) flow through onAction; a capability-only prompt
 * (no providerId) falls back to the Access-hub link, not a dead Connect button.
 *
 * Sabotage witnesses (w43; re-probed w110 as `w110g3-crc-*`): ignoring or inverting
 * `oauthConfigured` (an unconfigured provider gets the link, not Connect), dropping the
 * `window.location.href` launch, the providerId argument, either resume payload,
 * the card's `onAction('resolve')` adaptation, the capability-only branch, the
 * no-providerId catalog skip, the return path, or the Access-hub href each turn a case red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

const { beginOAuth, listProviders } = vi.hoisted(() => ({
  beginOAuth: vi.fn<(provider: string, returnTo?: string) => Promise<string>>(),
  listProviders: vi.fn<() => Promise<Provider[]>>(),
}));
vi.mock('../../features/connections/connectionsClient.js', () => ({ beginOAuth, listProviders }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.label ? `${k}:${o.label}` : k) }) }));

import { ConnectionRequiredCard } from '../cards/ConnectionRequiredCard.js';
import type { CardProps } from '../registry/types.js';
import type { Provider } from '../../features/connections/connectionsClient.js';

/** A catalog row as `listProviders` returns it (the P9 `oauthConfigured` honesty flag set). */
const GOOGLE: Provider = { id: 'google', label: 'Google Workspace', kind: 'oauth2', reach: 'workspace', refreshable: true, oauthConfigured: true };

function renderCard(connection: Record<string, unknown>, onAction = vi.fn<CardProps['onAction']>(async () => {})): { onAction: typeof onAction } {
  const props: CardProps = {
    payload: { data: { profile: 'openwop-connection', connection } },
    // The connection prompt rides the clarification interrupt (defaultCards
    // discriminates on `data.profile`), so this is the card type it arrives as.
    cardType: 'interrupt.clarification',
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
    listProviders.mockResolvedValue([GOOGLE]);
    renderCard({ ref: 'google', providerId: 'google', label: 'Google Workspace' });
    const connectBtn = await screen.findByText('connectionRequiredConnect:Google Workspace');
    // The button renders DISABLED while the provider catalog read is in flight
    // (`connectable === null`), and a click on it then does nothing. Finding the
    // label is not the same as the button being live: this clicked too early in a
    // loaded gate (slot 77, `beginOAuth` "Number of calls: 0").
    await waitFor(() => expect((connectBtn.closest('button') as HTMLButtonElement).disabled).toBe(false));
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
      value: { ...realLocation, pathname: '/chat', search: '?conversation=c1', set href(v: string) { nav.push(v); }, get href() { return nav[nav.length - 1] ?? ''; } },
    });
    try {
      fireEvent.click(connectBtn);
      // The consent returns to THIS surface (path AND query), so the open interrupt is
      // where the user lands to click "I've connected".
      await waitFor(() => expect(beginOAuth).toHaveBeenCalledWith('google', '/chat?conversation=c1'));
      expect(beginOAuth).toHaveBeenCalledTimes(1);
      // The launch actually happened: the component navigated to the URL it was
      // given. Asserting only `beginOAuth` would leave a component that fetched the
      // URL and dropped it indistinguishable from one that launched.
      await waitFor(() => expect(nav).toContain('https://accounts.example.test/oauth?state=x'));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }

    // "Host-configured" is half the claim (the P9 `oauthConfigured` honesty flag): the
    // same provider listed WITHOUT a configured OAuth client gets the Access-hub link,
    // never a Connect button whose consent this host cannot run.
    cleanup();
    listProviders.mockResolvedValue([{ ...GOOGLE, oauthConfigured: false }]);
    renderCard({ ref: 'google', providerId: 'google', label: 'Google Workspace' });
    expect((await screen.findByText('connectionRequiredManage')).closest('a')?.getAttribute('href')).toBe('/access?tab=connections');
    expect(screen.queryByText(/connectionRequiredConnect/)).toBeNull();
  });

  it('resume actions flow through onAction (connected carries providerId; skip is bare)', async () => {
    listProviders.mockResolvedValue([GOOGLE]);
    const { onAction } = renderCard({ providerId: 'google', label: 'Google Workspace' });
    fireEvent.click(screen.getByText('connectionRequiredContinue'));
    expect(onAction).toHaveBeenNthCalledWith(1, 'resolve', { action: 'connected', providerId: 'google' });
    fireEvent.click(screen.getByText('connectionRequiredSkip'));
    // Exactly one resume per click, in order: a Skip that also fired `connected`
    // (or a Continue that fired twice) would resume the run with the wrong verdict.
    expect(onAction).toHaveBeenNthCalledWith(2, 'resolve', { action: 'skip' });
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('a capability-only prompt (no providerId) shows the Access-hub link, not Connect', () => {
    // The catalog WOULD answer (and offer Google), so "not called" below is the
    // no-providerId skip, not a read that had nothing to return.
    listProviders.mockResolvedValue([GOOGLE]);
    renderCard({ ref: 'capability:ticketing', category: 'ticketing' });
    expect(screen.getByText('connectionRequiredManage').closest('a')?.getAttribute('href')).toBe('/access?tab=connections');
    expect(screen.queryByText(/connectionRequiredConnect/)).toBeNull();
    expect(listProviders).not.toHaveBeenCalled();
  });
});
