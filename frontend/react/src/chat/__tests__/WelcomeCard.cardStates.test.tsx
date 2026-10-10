/**
 * ADR 0768 follow-up P4 — the welcome starter cards tell their states apart.
 *
 * They used to render four disabled "(not available)" tiles for three different
 * facts: the read was still in flight, the read FAILED, or the starter workflows
 * are simply not installed in this workspace. Each now has its own designed
 * state, and a failed read is never presented as "not installed".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: undefined, loading: false }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('../lib/agentMentions.js', () => ({ useAgentMentions: () => ({ entries: [] }) }));
const wf = vi.hoisted(() => ({ mentions: [] as Array<{ slug: string; displayName: string }>, failed: false, refreshes: 0 }));
vi.mock('../lib/workflowMentions.js', () => ({
  listWorkflowMentions: () => wf.mentions,
  refreshWorkflowMentionCache: async () => { wf.refreshes += 1; },
  workflowMentionLoadFailed: () => wf.failed,
}));
vi.mock('../../features/profiles/profilesClient.js', () => ({ getMyProfile: async () => ({}) }));
vi.mock('../../agents/rosterClient.js', () => ({ listRoster: async () => [] }));

import { WelcomeCard } from '../WelcomeCard.js';

beforeEach(() => { wf.mentions = []; wf.failed = false; wf.refreshes = 0; });
afterEach(() => cleanup());

describe('WelcomeCard starter cards (ADR 0768 follow-up P4)', () => {
  it('shows the runnable cards once the inventory resolves', async () => {
    wf.mentions = [{ slug: 'lead-triage', displayName: 'Inbound Lead Triage & Routing' }];
    render(<WelcomeCard onPickSuggestion={vi.fn()} />);
    expect(await screen.findByText('/lead-triage')).toBeTruthy();
  });

  it('a FAILED read says so (announced) and retries — it is never "not installed"', async () => {
    wf.failed = true;
    render(<WelcomeCard onPickSuggestion={vi.fn()} />);
    expect(await screen.findByText('welcomeCardsFailedTitle')).toBeTruthy();
    expect(screen.queryByText('welcomeCardsNoneTitle')).toBeNull();
    wf.failed = false;
    wf.mentions = [{ slug: 'lead-triage', displayName: 'Inbound Lead Triage & Routing' }];
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
