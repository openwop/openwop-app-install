/**
 * ADR 0140 (multi-tab chat deck) — initial participant restore, `restoreLineup`
 * (b2e7aefa9, 2026-11-08): saved agent membership is merged back into THIS
 * session after the catalog loads, without a second hydration model.
 *   - a late restore addressed to another session is rejected by the real
 *     state updater, and a fresh same-session restore after A-B-A still lands;
 *   - a restore never steals the selected voice or drops a local addition,
 *     de-duplicates persisted rows, and is a no-op (same session object) when
 *     nothing is new;
 *   - a pending local removal is not resurrected, but a deliberate re-add wins;
 *   - the wholesale `setLineup` keeps its replace-and-reset-to-default contract.
 *
 * Sabotage-witnessed (grade-tests w97, r1): dropping the session-id check, the
 * in-batch or the existing-row de-duplication, the voice carry-over, the no-op
 * return, or the removed-intent check, and making `setLineup` keep the voice or
 * merge instead of replace, each turn a case red. Recorded equivalent mutant:
 * dropping the re-add's `removedBeforeRestore` delete stays green, because
 * `activateAgent` itself puts the agent back in the lineup and the restore then
 * skips it as already present; the case asserts the re-add outcome either way.
 */
import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useActiveAgents } from '../useActiveAgents.js';
import { DEFAULT_ASSISTANT_ID } from '../constants.js';
import type { ActiveAgentRow } from '../types.js';
import type { AgentMentionEntry } from '../../lib/agentMentions.js';
import type { ChatSession } from '../../types.js';

// No mock of either mutation owner: the real hook writes through a real useState.
const DIRECTOR: ActiveAgentRow = { agentId: 'qa.director', persona: 'Director', slug: 'director', modelClass: 'chat', addedAt: '2026-11-08' };
const NORA: AgentMentionEntry = { agentId: 'qa.nora', displayName: 'Nora', persona: 'Nora', slug: 'nora', description: '', modelClass: 'chat', packName: 'qa', packVersion: '1.0.0' };
const fresh = (id: string): ChatSession => ({ id, title: id, messages: [], createdAt: '2026-11-08' });
function useSubject() {
  const [session, setSession] = useState(() => fresh('a'));
  return { session, setSession, agents: useActiveAgents(session, setSession) };
}
afterEach(cleanup);

describe('initial lineup restoration state ownership', () => {
  it('rejects a late restore for another session and permits a fresh same-session restore after A-B-A', () => {
    const h = renderHook(useSubject);
    const restoreA = h.result.current.agents.restoreLineup;
    act(() => h.result.current.setSession(fresh('b')));
    act(() => restoreA('a', [DIRECTOR]));
    expect(h.result.current.session.id).toBe('b');
    expect(h.result.current.agents.lineup.map((r) => r.agentId)).toEqual([DEFAULT_ASSISTANT_ID]);
    act(() => h.result.current.setSession(fresh('a')));
    act(() => h.result.current.agents.restoreLineup('a', [DIRECTOR]));
    expect(h.result.current.agents.lineup.map((r) => r.agentId)).toEqual([DEFAULT_ASSISTANT_ID, DIRECTOR.agentId]);
  });

  it('keeps local membership and selected voice when restoring duplicate persisted rows', () => {
    const h = renderHook(useSubject);
    act(() => h.result.current.agents.activateAgent(NORA));
    act(() => h.result.current.agents.restoreLineup('a', [DIRECTOR, DIRECTOR]));
    expect(h.result.current.agents.currentAgentId).toBe(NORA.agentId);
    expect(h.result.current.agents.lineup.map((r) => r.agentId)).toEqual([DEFAULT_ASSISTANT_ID, NORA.agentId, DIRECTOR.agentId]);
    const current = h.result.current.session;
    act(() => h.result.current.agents.restoreLineup('a', [DIRECTOR]));
    expect(h.result.current.session).toBe(current);
  });

  it('honors a pending local removal but permits a deliberate re-add', () => {
    const h = renderHook(useSubject);
    act(() => h.result.current.agents.restoreLineup('a', [DIRECTOR]));
    act(() => h.result.current.agents.remove(DIRECTOR.agentId));
    act(() => h.result.current.agents.restoreLineup('a', [DIRECTOR]));
    expect(h.result.current.agents.lineup.map((r) => r.agentId)).toEqual([DEFAULT_ASSISTANT_ID]);
    const entry: AgentMentionEntry = { ...NORA, agentId: DIRECTOR.agentId, displayName: DIRECTOR.persona, slug: DIRECTOR.slug };
    act(() => h.result.current.agents.activateAgent(entry));
    act(() => h.result.current.agents.restoreLineup('a', [DIRECTOR]));
    expect(h.result.current.agents.currentAgentId).toBe(DIRECTOR.agentId);
    expect(h.result.current.agents.lineup.map((r) => r.agentId)).toEqual([DEFAULT_ASSISTANT_ID, DIRECTOR.agentId]);
  });

  it('leaves existing wholesale setLineup callers with replace-and-default routing semantics', () => {
    const h = renderHook(useSubject);
    act(() => h.result.current.agents.activateAgent(NORA));
    act(() => h.result.current.agents.setLineup([DIRECTOR]));
    expect(h.result.current.agents.lineup.map((r) => r.agentId)).toEqual([DEFAULT_ASSISTANT_ID, DIRECTOR.agentId]);
    expect(h.result.current.agents.currentAgentId).toBe(DEFAULT_ASSISTANT_ID);
  });
});

// CC-CHAT-4 (prod, twice: DeckTalk + MyndHyve) — reopening an agent conversation from
// the sidebar listed the agent but the plain Assistant answered ("I have no tools").
// ADR 0140 correction 2026-11-14: restore fills an EMPTY voice with the agent that
// answered last, and never replaces a voice already chosen.
describe('CC-CHAT-4 — reopen continues with the agent that answered last', () => {
  const answeredBy = (agentId: string): ChatSession => ({
    ...fresh('a'),
    messages: [
      { id: 'u1', role: 'user', content: 'Generate the kernel' },
      { id: 'a1', role: 'assistant', content: 'Started the kernel run.', agentId },
    ] as ChatSession['messages'],
  });
  function useReopened(agentId: string) {
    const [session, setSession] = useState(() => answeredBy(agentId));
    return { session, setSession, agents: useActiveAgents(session, setSession) };
  }

  it('restoreLineup selects the restored member that answered last when no voice is chosen', () => {
    const h = renderHook(() => useReopened(DIRECTOR.agentId));
    act(() => h.result.current.agents.restoreLineup('a', [DIRECTOR], DIRECTOR.agentId));
    expect(h.result.current.agents.currentAgentId).toBe(DIRECTOR.agentId);
  });

  it('restoreLineup never replaces a voice already chosen', () => {
    const h = renderHook(() => useReopened(DIRECTOR.agentId));
    act(() => h.result.current.agents.activateAgent(NORA));
    act(() => h.result.current.agents.restoreLineup('a', [DIRECTOR], DIRECTOR.agentId));
    expect(h.result.current.agents.currentAgentId).toBe(NORA.agentId);
  });

  it('restoreLineup ignores a preferred agent that is not a restored member', () => {
    const h = renderHook(() => useReopened('qa.removed'));
    act(() => h.result.current.agents.restoreLineup('a', [DIRECTOR], 'qa.removed'));
    expect(h.result.current.agents.currentAgentId).toBe(DEFAULT_ASSISTANT_ID);
  });

  it('setLineup with continueLastAgent selects the member that answered the loaded turn', () => {
    const h = renderHook(() => useReopened(DIRECTOR.agentId));
    act(() => h.result.current.agents.setLineup([DIRECTOR], { continueLastAgent: true }));
    expect(h.result.current.agents.currentAgentId).toBe(DIRECTOR.agentId);
    act(() => h.result.current.agents.setLineup([DIRECTOR]));
    expect(h.result.current.agents.currentAgentId).toBe(DEFAULT_ASSISTANT_ID);
  });
});
