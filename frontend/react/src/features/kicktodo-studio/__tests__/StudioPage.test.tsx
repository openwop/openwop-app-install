/**
 * ADR 0458 P4 + ADR 0461 P2 regression net — Studio intake is CHAT-FIRST and
 * now IN PLACE: the intake section embeds the ONE chat scoped to the Challenge
 * Author (EmbeddedChatPanel — never a second chat system), with the full-chat
 * deep-link kept as the durable-thread escape hatch. This pins:
 *  - the embed is scoped to the Challenge Author agent id;
 *  - the welcome receives the roster-truth workflow portfolio (from the
 *    /creator/author read), not a hand-painted list;
 *  - the deep-link target survives;
 *  - the demolished bespoke create form STAYS demolished (a resurrected form
 *    field or create button is a regression).
 * Both intake branches are pinned: the empty-portfolio state AND the populated
 * page each render their own copy of the embed + deep-link (StudioPage.tsx).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type {
  ChallengeAuthorProfile, FactoryCandidate, NeedsYouRow, PublicationState,
} from '../../../client/kicktodoStudioClient.js';

const AGENT = 'vendor.openwop-app.kicktodo.agents.challenge-author';

const studio = vi.hoisted(() => ({ candidates: [] as FactoryCandidate[] }));

vi.mock('../../../client/kicktodoStudioClient.js', () => {
  const author = {
    agentId: 'vendor.openwop-app.kicktodo.agents.challenge-author',
    rosterId: 'host:challenge-author',
    label: 'Challenge Author',
    workflows: [{ workflowId: 'openwop-app.kicktodo.challenge-factory', available: true, nodeCount: 9 }],
  } satisfies ChallengeAuthorProfile;
  return {
    listCandidates: vi.fn(async (): Promise<FactoryCandidate[]> => studio.candidates),
    getPublication: vi.fn(async (): Promise<PublicationState | null> => null),
    getNeedsYou: vi.fn(async (): Promise<NeedsYouRow[]> => []),
    getChallengeAuthor: vi.fn(async (): Promise<ChallengeAuthorProfile | null> => author),
  };
});

const CANDIDATE = {
  id: 'cand:test-1', topic: 'Deep Reading Habit', audience: 'busy adults',
  transformation: 'a durable reading habit', durationDaysTarget: 14, dailyMinutesTarget: 20,
  riskTier: 'low', riskSignals: [], state: 'researched', createdAt: '2026-07-21T00:00:00Z',
} satisfies FactoryCandidate;

// The embed pulls the whole chat stack — stub it to its contract (agentId +
// renderEmptyState) so this test pins the WIRING, not the chat internals.
vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: ({ agentId, renderEmptyState }: {
    agentId: string;
    renderEmptyState?: (onPick: (text: string) => void) => ReactNode;
  }) => (
    <div data-testid="embedded-chat" data-agent-id={agentId}>
      {renderEmptyState?.(() => {})}
    </div>
  ),
}));

import { StudioPage } from '../StudioPage.js';
afterEach(() => { cleanup(); studio.candidates = []; });

describe('StudioPage', () => {
  it('embeds the ONE chat scoped to the Challenge Author, keeps the full-chat link, and no bespoke create form', async () => {
    render(<MemoryRouter><StudioPage /></MemoryRouter>);
    const embed = await waitFor(() => screen.getByTestId('embedded-chat'));
    expect(embed.getAttribute('data-agent-id')).toBe(AGENT);
    // The escape hatch: the full-chat deep-link survives with the same target.
    const link = screen.getByRole('link', { name: 'Open in full chat' });
    expect(link.getAttribute('href')).toBe(`/?agent=${AGENT}`);
    // The demolished form must stay demolished: no intake text inputs, no
    // form-submit button. (The welcome's example-intent CARDS may say
    // "Create a…" — they seed the composer, they are not a form.)
    expect(screen.queryByLabelText('Topic')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /create candidate/i })).toBeNull();
  });

  it('the welcome lists the roster-truth workflow portfolio', async () => {
    render(<MemoryRouter><StudioPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Challenge Factory')).toBeTruthy());
    expect(screen.getByText('9 steps')).toBeTruthy();
  });

  it('with candidates, the intake still embeds the ONE chat scoped to the Challenge Author and keeps the full-chat link', async () => {
    studio.candidates = [CANDIDATE];
    render(<MemoryRouter><StudioPage /></MemoryRouter>);
    // Positive control: the POPULATED branch rendered (the portfolio row).
    await waitFor(() => expect(screen.getByRole('link', { name: CANDIDATE.topic })).toBeTruthy());
    const embeds = screen.getAllByTestId('embedded-chat');
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.getAttribute('data-agent-id')).toBe(AGENT);
    expect(screen.getByRole('link', { name: 'Open in full chat' }).getAttribute('href')).toBe(`/?agent=${AGENT}`);
  });
});
