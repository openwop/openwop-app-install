/**
 * ArenaPage (ADR 0123 Phase 4c, ADR 0986 D7) — the blind, run-bound head-to-head:
 *  - each pane is a NORMAL conversation run pinned to its contestant's model AND the
 *    credential the caller holds for that provider (architect B2: without one, the
 *    host answered both panes with the managed tier);
 *  - a contestant with no credential is refused with the keys hint, and nothing runs;
 *  - sides are assigned at random and hidden until the vote; the vote posts the two
 *    RUN ids and the server's reply names the models (the reveal);
 *  - a failed pane renders the keys hint and blocks voting;
 *  - replies ride the SHARED `MessageBubble`, the prompt the SHARED `ChatInput`.
 *
 * Witnessed: dropping the credential at session-open, ignoring a missing key,
 * printing the contestant in the pane header, posting model names instead of run
 * ids, swapping the run ids, and dropping the pane-error gate each red a case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent, screen, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import type { SendResult } from '../../../chat/conversationTransport.js';
import type { ConversationTurn } from '../../../chat/conversationClient.js';

type Transport = typeof import('../../../chat/conversationTransport.js');
type EvalsClient = typeof import('../../../client/evalsClient.js');
const openSession = vi.fn<Transport['openConversationSession']>();
const sendTurn = vi.fn<Transport['sendConversationTurn']>();
const closeSession = vi.fn<Transport['closeConversationSession']>().mockResolvedValue(undefined);
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../chat/conversationTransport.js', async (importOriginal) => {
  const real = await importOriginal<Transport>();
  return {
    ...real,
    openConversationSession: (...a: Parameters<Transport['openConversationSession']>) => openSession(...a),
    sendConversationTurn: (...a: Parameters<Transport['sendConversationTurn']>) => sendTurn(...a),
    closeConversationSession: (...a: Parameters<Transport['closeConversationSession']>) => closeSession(...a),
  };
});

const captureArenaMatch = vi.fn<EvalsClient['captureArenaMatch']>();
vi.mock('../../../client/evalsClient.js', async (importOriginal) => ({
  // The real EvalsHttpError, so a refusal reason reaches the page as it would.
  EvalsHttpError: (await importOriginal<EvalsClient>()).EvalsHttpError,
  captureArenaMatch: (...a: Parameters<EvalsClient['captureArenaMatch']>) => captureArenaMatch(...a),
  listOrgs: vi.fn().mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]),
}));
let storedRefs: string[] = ['byok:openai', 'byok:google'];
vi.mock('../../../byok/lib/byokClient.js', () => ({ listStoredRefs: () => Promise.resolve(storedRefs) }));

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
import { EvalsHttpError } from '../../../client/evalsClient.js';

const turnFor = (text: string): SendResult => {
  const turns: ConversationTurn[] = [
    { messageId: `u-${text}`, from: 'user', role: 'user', content: text, ts: 1, turnIndex: 1 },
    { messageId: `a-${text}`, from: 'assistant', role: 'agent', content: `reply to ${text}`, ts: 2, turnIndex: 2 },
  ];
  return { turns, lastSeq: 2 };
};

let random: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  storedRefs = ['byok:openai', 'byok:google'];
  openSession.mockReset();
  sendTurn.mockReset();
  captureArenaMatch.mockReset();
  closeSession.mockClear();
  let n = 0;
  openSession.mockImplementation(() => Promise.resolve({ runId: `run-${++n}`, nodeId: 'gate' }));
  sendTurn.mockImplementation((_r, _n2, input) => Promise.resolve(turnFor(typeof input.content === 'string' ? input.content : '')));
  random = vi.spyOn(Math, 'random').mockReturnValue(0.9); // ≥ 0.5 ⇒ contestant 2 is side A
});
afterEach(() => { random.mockRestore(); cleanup(); });

async function send(text: string): Promise<void> {
  const composer = screen.getByPlaceholderText(/ask both models/i);
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.keyDown(composer, { key: 'Enter' });
}

async function driveMatch(): Promise<void> {
  render(<MemoryRouter><ArenaPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByText('pick-gpt')).toHaveLength(2)); // stored refs read
  await new Promise((r) => setImmediate(r));
  fireEvent.click(screen.getAllByText('pick-gpt')[0]!);
  fireEvent.click(screen.getAllByText('pick-gemini')[1]!);
  await send('which is better?');
  await waitFor(() => expect(screen.getAllByText(/reply to which is better\?/)).toHaveLength(2));
}

describe('ArenaPage', () => {
  it('opens each side with its model AND the caller\'s credential for that provider, sides assigned at random', async () => {
    await driveMatch();
    expect(openSession).toHaveBeenCalledTimes(2);
    // Math.random() = 0.9 ⇒ contestant 2 (gemini) became side A, opened first.
    expect(openSession.mock.calls[0]![0]).toEqual({ provider: 'google', model: 'gemini-test', credentialRef: 'byok:google' });
    expect(openSession.mock.calls[1]![0]).toEqual({ provider: 'openai', model: 'gpt-test', credentialRef: 'byok:openai' });
  });

  it('refuses a contestant the caller holds no credential for, and runs nothing', async () => {
    storedRefs = ['byok:openai'];
    render(<MemoryRouter><ArenaPage /></MemoryRouter>);
    await new Promise((r) => setImmediate(r));
    fireEvent.click(screen.getAllByText('pick-gpt')[0]!);
    fireEvent.click(screen.getAllByText('pick-gemini')[1]!);
    await send('hi');
    expect(await screen.findByText(/don’t have a key for google/i)).toBeTruthy();
    expect(openSession).not.toHaveBeenCalled();
  });

  it('hides which model is which until the vote, posts the run ids, and reveals from the server', async () => {
    captureArenaMatch.mockResolvedValue({ match: { modelA: 'gemini-test', modelB: 'gpt-test', winner: 'B' }, ratingA: 1484, ratingB: 1516 });
    await driveMatch();
    for (const label of ['Model A', 'Model B']) {
      const pane = screen.getByRole('region', { name: label });
      expect(within(pane).queryByText(/gpt-test|gemini-test/)).toBeNull();
      expect(within(pane).getByText('Hidden until you vote')).toBeTruthy();
    }
    fireEvent.click(screen.getByText(/b is better/i));
    await waitFor(() => expect(captureArenaMatch).toHaveBeenCalledWith('org-1', { runIdA: 'run-1', runIdB: 'run-2', winner: 'B' }));
    expect(await screen.findByText(/Recorded: gpt-test.*1,516/)).toBeTruthy();
    // The verdict ends the match: a further send goes nowhere until "New match".
    expect(screen.getByText(/This match is decided/)).toBeTruthy();
    const sent = sendTurn.mock.calls.length;
    await send('one more?');
    expect(sendTurn.mock.calls.length).toBe(sent);
    expect(within(screen.getByRole('region', { name: 'Model A' })).getByText('gemini-test')).toBeTruthy();
  });

  it('a repeat vote on the same pair says so', async () => {
    captureArenaMatch.mockResolvedValue({ match: { modelA: 'gemini-test', modelB: 'gpt-test', winner: 'A' }, ratingA: 1516, ratingB: 1484, replayed: true });
    await driveMatch();
    fireEvent.click(screen.getByText(/b is better/i));
    expect(await screen.findByText(/Your earlier vote on this pair stands/)).toBeTruthy();
  });

  it('a refused verdict says why, instead of "retry"', async () => {
    captureArenaMatch.mockRejectedValue(new EvalsHttpError('conflict: x', 409, 'arena_prompt_mismatch'));
    await driveMatch();
    fireEvent.click(screen.getByText(/b is better/i));
    expect(await screen.findByText(/didn’t answer the same prompts/)).toBeTruthy();
    expect(screen.queryByText(/vote again to retry/i)).toBeNull();
    // …and the refusal ends the match: the buttons can't repeat it.
    expect(screen.queryByText(/b is better/i)).toBeNull();
  });

  it('the per-model vote cap is a refusal with its own sentence, not "retry"', async () => {
    captureArenaMatch.mockRejectedValue(new EvalsHttpError('rate_limited: x', 429, 'arena_rater_cap'));
    await driveMatch();
    fireEvent.click(screen.getByText(/b is better/i));
    expect(await screen.findByText(/limit of arena votes/)).toBeTruthy();
    expect(screen.queryByText(/vote again to retry/i)).toBeNull();
  });

  it('refuses two picks of the same model before anything runs', async () => {
    render(<MemoryRouter><ArenaPage /></MemoryRouter>);
    await new Promise((r) => setImmediate(r));
    fireEvent.click(screen.getAllByText('pick-gpt')[0]!);
    fireEvent.click(screen.getAllByText('pick-gpt')[1]!);
    await send('hi');
    expect(await screen.findByText(/Pick two different models/)).toBeTruthy();
    expect(openSession).not.toHaveBeenCalled();
  });

  it('closes both runs when you leave the page', async () => {
    await driveMatch();
    cleanup();
    await waitFor(() => expect(closeSession).toHaveBeenCalledTimes(2));
  });

  it('a failed pane renders the keys hint and blocks voting', async () => {
    sendTurn.mockImplementationOnce(() => Promise.reject(new Error('provider_auth 401')));
    render(<MemoryRouter><ArenaPage /></MemoryRouter>);
    await new Promise((r) => setImmediate(r));
    fireEvent.click(screen.getAllByText('pick-gpt')[0]!);
    fireEvent.click(screen.getAllByText('pick-gemini')[1]!);
    await send('hi');
    await screen.findByText(/couldn’t reply/i);
    expect(screen.queryByText(/b is better/i)).toBeNull();
  });

  it('a LATER failed turn ends the match: no vote bar, no further sends, and the page says why', async () => {
    await driveMatch();
    expect(screen.getByText(/b is better/i), 'precondition: the bar shows after a clean round').toBeTruthy();
    sendTurn.mockImplementationOnce(() => Promise.reject(new Error('provider_auth 401')));
    await send('and now?');
    await screen.findByText(/couldn’t reply/i);
    await screen.findByText(/reply to and now\?/);
    expect(screen.queryByText(/b is better/i)).toBeNull();
    expect(screen.getByText(/can’t be judged/)).toBeTruthy();
    const sent = sendTurn.mock.calls.length;
    await send('retry?');
    expect(sendTurn.mock.calls.length).toBe(sent);
  });

  it('renders replies through the SHARED chat bubble and drives the prompt with the SHARED composer', async () => {
    await driveMatch();
    expect(document.querySelectorAll('.msgbubble-row')).toHaveLength(4);
    expect(document.querySelector('input[type="text"]')).toBeNull();
    expect(document.querySelector('.chatinput-textarea')).not.toBeNull();
  });
});
