import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * ENG-14 — `?rail=` deep-link parity for the multi-tab deck.
 *
 * The deck already consumed `?agent=` and `?conversation=`; `?rail=` was the one
 * member of the ChatSidebar deep-link family it dropped. The symptom is silent:
 * a feature CTA that targets a rail (the Studio publication link → the reviews
 * inbox) still navigates and still renders a chat, so nothing looks broken —
 * the user just lands on whatever tab localStorage last held, and the CTA's
 * intent is gone. Nothing throws, so only a test pins it.
 */

vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId }: { sessionId: string }) => <div data-testid="tabsession" data-sid={sessionId} />,
}));
vi.mock('../../hooks/useChatSessions.js', () => ({
  useChatSessions: () => ({ sessions: [], isLoading: false, error: null, markRead: vi.fn(), createSession: vi.fn(), rename: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: null }),
}));

import { TabChatDeck } from '../TabChatDeck.js';

const CONFIG = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' } as never;

beforeEach(() => { localStorage.clear(); });

async function renderAt(url: string): Promise<void> {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[url]}>
        <TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} />
      </MemoryRouter>,
    );
  });
}

/** The rail tablist exposes which tab is selected; read it rather than internals. */
function selectedRailTab(): string | null {
  const selected = screen.queryAllByRole('tab', { selected: true });
  return selected.length > 0 ? (selected[0]!.textContent?.trim() ?? null) : null;
}

describe('TabChatDeck — ?rail= deep link (ENG-14)', () => {
  it('selects the reviews rail when deep-linked, instead of the persisted default', async () => {
    // Persist a DIFFERENT rail first, so a pass cannot come from the default
    // happening to match — the deep link has to actually override it.
    localStorage.setItem('openwop-app.chat.rail-tab', JSON.stringify('conversations'));
    await renderAt('/chat?rail=reviews');
    expect(selectedRailTab()).toMatch(/review/i);
  });

  it('ignores an unknown rail value rather than selecting nothing', async () => {
    await renderAt('/chat?rail=not-a-real-rail');
    // The guard only accepts the deck's own LeftRailTab union, so an unknown
    // value must leave the existing selection intact — not blank the rail.
    expect(selectedRailTab()).not.toBeNull();
  });

  it('strips the param so reload/back/share does not re-trigger', async () => {
    // Observe the real router location rather than asserting on a proxy — the
    // strip is the half that keeps a shared URL clean, and an assertion that
    // cannot fail would be worse than no test.
    let search = '';
    function LocationSpy(): null {
      search = useLocation().search;
      return null;
    }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/chat?rail=progress']}>
          <LocationSpy />
          <TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} />
        </MemoryRouter>,
      );
    });
    expect(search).not.toContain('rail=');
  });
});
