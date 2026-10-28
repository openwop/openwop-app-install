/**
 * ADR 0986 — the leaderboard and arena UX (feature loop round 2, row 59). Each
 * `EV2-UX-*` case was RED on `f3a80dd9e`:
 *
 *  - EV2-UX-1  the Models console is the leaderboard's only nav entry, and the
 *              embedded page dropped its header and with it the only link to
 *              the arena — the arena was reachable by typing its URL.
 *  - EV2-UX-2  the arena showed which model wrote which reply while you voted,
 *              and the vote sent two model NAMES instead of the two runs.
 *  - EV2-10    (architect B2) both panes opened with no credential, so the host
 *              answered both with the managed tier.
 *  - EV2-UX-3  arena results and the ratings nobody could attribute never
 *              reached the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { HubProvider } from '../../../chrome/hubContext.js';
import type { SendResult } from '../../../chat/conversationTransport.js';
import type { ConversationTurn } from '../../../chat/conversationClient.js';

type Transport = typeof import('../../../chat/conversationTransport.js');
const openSession = vi.fn<Transport['openConversationSession']>();
const sendTurn = vi.fn<Transport['sendConversationTurn']>();
vi.mock('../../../chat/conversationTransport.js', async (importOriginal) => {
  const real = await importOriginal<Transport>();
  return {
    ...real,
    openConversationSession: (...a: Parameters<Transport['openConversationSession']>) => openSession(...a),
    sendConversationTurn: (...a: Parameters<Transport['sendConversationTurn']>) => sendTurn(...a),
    closeConversationSession: vi.fn().mockResolvedValue(undefined),
  };
});

const captureArenaMatch = vi.fn();
const fetchLeaderboard = vi.fn();
const fetchEvalsBoard = vi.fn();
vi.mock('../../../client/evalsClient.js', async (importOriginal) => ({
  EvalsHttpError: (await importOriginal<typeof import('../../../client/evalsClient.js')>()).EvalsHttpError,
  captureArenaMatch: (...a: unknown[]) => captureArenaMatch(...a),
  fetchLeaderboard: (...a: unknown[]) => fetchLeaderboard(...a),
  fetchEvalsBoard: (...a: unknown[]) => fetchEvalsBoard(...a),
  listOrgs: vi.fn().mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]),
}));
vi.mock('../../../byok/lib/byokClient.js', () => ({ listStoredRefs: () => Promise.resolve(['byok:openai', 'byok:google']) }));
// The shared composer's @-mention and / pickers read agents, boards and workflows;
// mocked so the arena tests make no live call (ADR 0661).
vi.mock('../../../client/agentsClient.js', () => ({ listAgents: () => Promise.resolve([]) }));
vi.mock('../../../features/advisory-board/advisoryBoardClient.js', () => ({ listBoards: () => Promise.resolve([]) }));
vi.mock('../../../workflows/workflowsClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../workflows/workflowsClient.js')>()),
  listWorkflowSummaries: () => Promise.resolve([]),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (feature: string) => makeFeatureAccess({ enabled: feature === 'evals', loading: false }),
}));
vi.mock('../../../chat/ModelSwitcher.js', () => ({
  ModelSwitcher: ({ onChange }: { onChange: (c: { provider: string; model: string }) => void }) => (
    <span>
      <button type="button" onClick={() => onChange({ provider: 'openai', model: 'gpt-test' })}>pick-gpt</button>
      <button type="button" onClick={() => onChange({ provider: 'google', model: 'gemini-test' })}>pick-gemini</button>
    </span>
  ),
}));

import { LeaderboardPage } from '../LeaderboardPage.js';
import { ArenaPage } from '../ArenaPage.js';

const turnFor = (text: string): SendResult => {
  const turns: ConversationTurn[] = [
    { messageId: `u-${text}`, from: 'user', role: 'user', content: text, ts: 1, turnIndex: 1 },
    { messageId: `a-${text}`, from: 'assistant', role: 'agent', content: `reply to ${text}`, ts: 2, turnIndex: 2 },
  ];
  return { turns, lastSeq: 2 };
};

const lbRow = { key: 'anthropic/opus', provider: 'anthropic', model: 'opus', up: 3, down: 1, neutral: 0, total: 4, raters: 2, winRate: 0.75, score: 0.3 };
const fullBoard = {
  leaderboard: [lbRow],
  arena: [{ model: 'opus', provider: 'anthropic', rating: 1561, wins: 4, losses: 1, ties: 0, matches: 5 }],
  coverage: { attributed: 4, unattributed: 6 },
};

beforeEach(() => {
  captureArenaMatch.mockReset();
  fetchLeaderboard.mockReset().mockResolvedValue([lbRow]);
  fetchEvalsBoard.mockReset().mockResolvedValue(fullBoard);
  openSession.mockReset();
  sendTurn.mockReset();
  let n = 0;
  openSession.mockImplementation(() => Promise.resolve({ runId: `run-${++n}`, nodeId: 'gate' }));
  sendTurn.mockImplementation((_r, _n, input) => Promise.resolve(turnFor(typeof input.content === 'string' ? input.content : '')));
});
afterEach(cleanup);

describe('ADR 0986 — leaderboard', () => {
  it('EV2-UX-1: inside the Models console the page still links to the arena', async () => {
    render(<MemoryRouter><HubProvider><LeaderboardPage /></HubProvider></MemoryRouter>);
    await screen.findAllByText('opus');
    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/leaderboard/arena');
    expect(link).toBeTruthy();
  });

  it('EV2-UX-3: shows the arena ranking and says how many ratings could not be attributed', async () => {
    render(<MemoryRouter><LeaderboardPage /></MemoryRouter>);
    expect(await screen.findByText('1,561')).toBeTruthy();
    expect(screen.getByText(/6 ratings/)).toBeTruthy();
  });
});

describe('ADR 0986 — arena', () => {
  it('EV2-UX-2: hides which model wrote which reply until the vote, and votes on the two runs', async () => {
    captureArenaMatch.mockResolvedValue({ match: { modelA: 'gpt-test', modelB: 'gemini-test' }, ratingA: 1516, ratingB: 1484 });
    render(<MemoryRouter><ArenaPage /></MemoryRouter>);
    await new Promise((r) => setImmediate(r)); // the stored-credential read
    fireEvent.click(screen.getAllByText('pick-gpt')[0]!);
    fireEvent.click(screen.getAllByText('pick-gemini')[1]!);
    const composer = screen.getByPlaceholderText(/ask both models/i);
    fireEvent.change(composer, { target: { value: 'which is better?' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(screen.getAllByText(/reply to which is better\?/)).toHaveLength(2));
    for (const label of ['Model A', 'Model B']) {
      const pane = screen.getByRole('region', { name: label });
      expect(within(pane).queryByText(/gpt-test|gemini-test/)).toBeNull();
    }
    fireEvent.click(screen.getByText(/a is better/i));
    await waitFor(() => expect(captureArenaMatch).toHaveBeenCalledTimes(1));
    const [, body] = captureArenaMatch.mock.calls[0] as [string, { runIdA?: string; runIdB?: string; winner: string }];
    expect(new Set([body.runIdA, body.runIdB])).toEqual(new Set(['run-1', 'run-2']));
    expect(body.winner).toBe('A');
    // EV2-10 (architect B2): each side dispatched with the caller's credential, not the managed default.
    expect(openSession.mock.calls.map((c) => c[0]?.credentialRef).sort()).toEqual(['byok:google', 'byok:openai']);
  });
});
