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
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

vi.mock('../../../client/kicktodoStudioClient.js', () => ({
  listCandidates: vi.fn(() => Promise.resolve([])),
  getPublication: vi.fn(() => Promise.resolve(null)),
  getNeedsYou: vi.fn(() => Promise.resolve([])),
  getChallengeAuthor: vi.fn(() => Promise.resolve({
    agentId: 'feature.kicktodo.agents.challenge-author',
    rosterId: 'host:challenge-author',
    label: 'Challenge Author',
    workflows: [{ workflowId: 'openwop-app.kicktodo.challenge-factory', available: true, nodeCount: 9 }],
  })),
}));

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
afterEach(cleanup);

describe('StudioPage', () => {
  it('embeds the ONE chat scoped to the Challenge Author, keeps the full-chat link, and no bespoke create form', async () => {
    render(<MemoryRouter><StudioPage /></MemoryRouter>);
    const embed = await waitFor(() => screen.getByTestId('embedded-chat'));
    expect(embed.getAttribute('data-agent-id')).toBe('feature.kicktodo.agents.challenge-author');
    // The escape hatch: the full-chat deep-link survives with the same target.
    const link = screen.getByRole('link', { name: 'Open in full chat' });
    expect(link.getAttribute('href')).toBe('/?agent=feature.kicktodo.agents.challenge-author');
    // The demolished form must stay demolished: no intake text inputs, no
    // form-submit button. (The welcome's example-intent CARDS may say
    // "Create a…" — they seed the composer, they are not a form.)
    expect(screen.queryByLabelText('Topic')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /create candidate/i })).toBeNull();
  });

  it('the welcome lists the roster-truth workflow portfolio', async () => {
    render(<MemoryRouter><StudioPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('Challenge Factory').length).toBeGreaterThan(0));
    expect(screen.getAllByText('9 steps').length).toBeGreaterThan(0);
  });
});
