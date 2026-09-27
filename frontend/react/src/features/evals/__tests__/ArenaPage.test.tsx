/**
 * ArenaPage (ADR 0123 Phase 4c) — the head-to-head contract:
 *  - both panes dispatch NORMAL conversation runs with the model pinned at
 *    session-open (one-chat compliance: the existing transport, no bespoke path);
 *  - the vote posts {modelA, modelB, winner} to the arena route and shows the
 *    returned Elo ratings;
 *  - a failed pane renders the designed keys-hint error (never throws);
 *  - the a9 port pin: replies render through the SHARED `MessageBubble` and the
 *    prompt is driven by the SHARED `ChatInput` — a re-hand-rolled arena bubble
 *    (inline MSG/USER_MSG styling) or a raw `<input type="text">` composer would
 *    fail the two regression tests at the bottom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const openSession = vi.fn();
const sendTurn = vi.fn();
const closeSession = vi.fn().mockResolvedValue(undefined);
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../chat/conversationTransport.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../chat/conversationTransport.js')>();
  return {
    ...real,
    openConversationSession: (cfg: unknown) => openSession(cfg),
    sendConversationTurn: (...a: unknown[]) => sendTurn(...a),
    closeConversationSession: (...a: unknown[]) => closeSession(...a),
  };
});

const captureArenaMatch = vi.fn();
vi.mock('../../../client/evalsClient.js', () => ({
  captureArenaMatch: (orgId: string, input: unknown) => captureArenaMatch(orgId, input),
  fetchArenaRating: vi.fn().mockResolvedValue(1500),
  listOrgs: vi.fn().mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]),
}));

// Arena is enabled; developer-tools OFF so the shared bubble stays minimal (no
// EnvelopeInspector) — mirrors the production default.
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (feature: string) => makeFeatureAccess({ enabled: feature === 'evals', loading: false }),
}));

// A minimal ModelSwitcher double: two fixed options.
vi.mock('../../../chat/ModelSwitcher.js', () => ({
  ModelSwitcher: ({ onChange }: { onChange: (c: { provider: string; model: string }) => void }) => (
    <span>
      <button type="button" onClick={() => onChange({ provider: 'openai', model: 'gpt-test' })}>pick-gpt</button>
      <button type="button" onClick={() => onChange({ provider: 'google', model: 'gemini-test' })}>pick-gemini</button>
    </span>
  ),
}));

import { ArenaPage } from '../ArenaPage.js';

const turnFor = (text: string) => ({
  turns: [
    { messageId: `u-${text}`, role: 'user', content: text, seq: 1 },
    { messageId: `a-${text}`, role: 'assistant', content: `reply to ${text}`, seq: 2 },
  ],
  lastSeq: 2,
});

beforeEach(() => {
  openSession.mockReset();
  sendTurn.mockReset();
  captureArenaMatch.mockReset();
  let n = 0;
  openSession.mockImplementation(() => Promise.resolve({ runId: `run-${++n}`, nodeId: 'gate' }));
  sendTurn.mockImplementation((_r: string, _n2: string, input: { content: string }) => Promise.resolve(turnFor(input.content)));
});

async function driveMatch() {
  const utils = render(<MemoryRouter><ArenaPage /></MemoryRouter>);
  const { getAllByText, getByPlaceholderText } = utils;
  // pick model A (first switcher) + model B (second switcher)
  fireEvent.click(getAllByText('pick-gpt')[0]!);
  fireEvent.click(getAllByText('pick-gemini')[1]!);
  // The shared composer (ChatInput) is a textarea; Enter (no modifier) submits.
  const composer = getByPlaceholderText(/ask both models/i);
  fireEvent.change(composer, { target: { value: 'which is better?' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(getAllByText(/reply to which is better\?/)).toHaveLength(2));
  return utils;
}

describe('ArenaPage', () => {
  it('dispatches TWO normal runs with the model pinned at session-open', async () => {
    await driveMatch();
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(openSession).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-test' });
    expect(openSession).toHaveBeenCalledWith({ provider: 'google', model: 'gemini-test' });
    expect(sendTurn).toHaveBeenCalledTimes(2);
  });

  it('the vote posts {modelA, modelB, winner} and shows the returned Elo', async () => {
    captureArenaMatch.mockResolvedValue({ ratingA: 1484, ratingB: 1516 });
    const { getByText, findByRole } = await driveMatch();
    fireEvent.click(getByText(/b is better/i));
    await waitFor(() => expect(captureArenaMatch).toHaveBeenCalledWith('org-1', { modelA: 'gpt-test', modelB: 'gemini-test', winner: 'B' }));
    const status = await findByRole('status');
    expect(status.textContent).toContain('1484');
    expect(status.textContent).toContain('1516');
  });

  it('a failed pane renders the keys-hint error, not a crash, and blocks voting', async () => {
    sendTurn.mockImplementationOnce(() => Promise.reject(new Error('provider_auth 401')));
    const { getAllByText, getByPlaceholderText, queryByText, findByText } = render(<MemoryRouter><ArenaPage /></MemoryRouter>);
    fireEvent.click(getAllByText('pick-gpt')[0]!);
    fireEvent.click(getAllByText('pick-gemini')[1]!);
    const composer = getByPlaceholderText(/ask both models/i);
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await findByText(/could not reply/i);
    expect(queryByText(/b is better/i)).toBeNull(); // vote bar requires both panes settled
  });

  // a9 port pins — the arena's feed + composer ride the ONE chat's presentation
  // layer, not a third hand-rolled copy of chat-bubble/composer styling.
  it('renders replies through the SHARED chat bubble (no hand-rolled arena bubbles)', async () => {
    const { container } = await driveMatch();
    // The shared MessageBubble emits `.msgbubble-row`; the demolished arena
    // bubbles used inline MSG/USER_MSG styles carrying none of these classes.
    expect(container.querySelectorAll('.msgbubble-row').length).toBeGreaterThanOrEqual(2);
  });

  it('drives the prompt with the SHARED composer (ChatInput), not a raw <input type="text">', () => {
    const { container } = render(<MemoryRouter><ArenaPage /></MemoryRouter>);
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(container.querySelector('.chatinput-textarea')).not.toBeNull();
  });
});
