/**
 * ADR 0768 follow-up P4 — the welcome starter cards tell their states apart.
 *
 * They used to render four disabled "(not available)" tiles for three different
 * facts: the read was still in flight, the read FAILED, or the starter workflows
 * are simply not installed in this workspace. Each now has its own designed
 * state, and a failed read is never presented as "not installed".
 *
 * Sabotage witnesses (w43): resolving no slug, never classifying a failure,
 * a Retry that does not re-run the read, dropping the failure card's `announce`,
 * dropping the effect's re-resolve, and losing the none-installed branch or its
 * /builder link each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../auth/useAuth.js', () => ({
  useAuth: (): UseAuth => ({
    user: null, loading: false, isConfigured: false,
    signIn: { google: async () => undefined, github: async () => undefined },
    signOut: async () => undefined,
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('../lib/agentMentions.js', () => ({ useAgentMentions: () => ({ entries: [] }) }));
type Mention = { slug: string; displayName: string };
const wf = vi.hoisted(() => ({ mentions: [] as Mention[], next: null as Mention[] | null, failed: false, refreshes: 0 }));
vi.mock('../lib/workflowMentions.js', () => ({
  listWorkflowMentions: () => wf.mentions,
  // The refresh is what lands the inventory: `next` (when set) becomes the cache.
  refreshWorkflowMentionCache: async () => { wf.refreshes += 1; if (wf.next) wf.mentions = wf.next; },
  workflowMentionLoadFailed: () => wf.failed,
}));
vi.mock('../../features/profiles/profilesClient.js', () => ({ getMyProfile: async () => ({}) }));
vi.mock('../../agents/rosterClient.js', () => ({ listRoster: async () => [] }));

import { WelcomeCard } from '../WelcomeCard.js';
import { announce, currentAnnouncements } from '../../ui/announce.js';
import type { UseAuth } from '../../auth/useAuth.js';

const LEAD: Mention = { slug: 'lead-triage', displayName: 'Inbound Lead Triage & Routing' };

beforeEach(() => {
  wf.mentions = []; wf.next = null; wf.failed = false; wf.refreshes = 0;
  // The announcer is module-global; an empty message resets both channels.
  announce(''); announce('', { assertive: true });
});
afterEach(() => cleanup());

describe('WelcomeCard starter cards (ADR 0768 follow-up P4)', () => {
  it('shows the runnable cards once the inventory resolves', async () => {
    // Empty at mount; the inventory arrives through the refresh, so the card can
    // only resolve through the effect's re-resolve (not the mount-time initializer).
    wf.next = [LEAD];
    render(<WelcomeCard onPickSuggestion={vi.fn()} />);
    expect(await screen.findByText('/lead-triage')).toBeTruthy();
    expect(wf.refreshes).toBe(1);
  });

  it('a FAILED read says so (announced) and retries — it is never "not installed"', async () => {
    wf.failed = true;
    render(<WelcomeCard onPickSuggestion={vi.fn()} />);
    expect(await screen.findByText('welcomeCardsFailedTitle')).toBeTruthy();
    expect(screen.queryByText('welcomeCardsNoneTitle')).toBeNull();
    // "Announced": StateCard speaks the title on the polite channel. WAITED, not
    // read once: the failed card lands from an async update outside act(), so the
    // title can be in the DOM before StateCard's passive announce effect has run
    // (w43 shuffle red under load). `beforeEach` cleared the channel, so only
    // THIS case's announcement can satisfy it.
    await waitFor(() => expect(currentAnnouncements().polite).toContain('welcomeCardsFailedTitle'));
    wf.failed = false;
    wf.mentions = [LEAD];
    fireEvent.click(screen.getByRole('button', { name: 'common:retry' }));
    expect(await screen.findByText('/lead-triage')).toBeTruthy();
    expect(wf.refreshes).toBe(2);
  });

  it('none installed (a successful read) offers the Builder gallery instead of dead tiles', async () => {
    render(<WelcomeCard onPickSuggestion={vi.fn()} />);
    expect(await screen.findByText('welcomeCardsNoneTitle')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'welcomeCardsBrowse' }).getAttribute('href')).toBe('/builder');
    await waitFor(() => expect(screen.queryByText('notAvailable')).toBeNull());
  });
});
