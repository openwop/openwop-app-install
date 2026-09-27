/**
 * ADR 0665 D5 — the cast list says NAMES.
 *
 * Born red: `turnsToMessages` emitted `[${t.from}]`, and `t.from` is the raw agent
 * slug the exchange writes. Three artifacts promised otherwise — `FEATURES.md`, the
 * function's own docblock, and the synthesis prompt that asks the chair to "name
 * each dissent and who holds it". A chair asked to attribute dissent by name was
 * being handed slugs.
 *
 * The fallback is the load-bearing half: absent a name it must fall back to the
 * SLUG, never to a blank. An unnamed speaker in a council transcript is worse than
 * the slug it replaced.
 */
import { describe, expect, it } from 'vitest';
import { turnsToMessages } from '../src/host/exchange/dispatchTurn.js';
import { resolvePersonaNames, __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import type { ConversationTurn } from '../src/host/conversation.js';

const turn = (from: string, agentId: string, content = 'Ship on Tuesday.'): ConversationTurn => ({
  messageId: `m-${from}`, from, groupId: 'g1', content, ts: Date.now(),
  role: 'agent', turnIndex: 0, agent: { agentId },
} as ConversationTurn);

const relayed = (msgs: { role: string; content: unknown }[]): string =>
  String(msgs.filter((m) => m.role === 'assistant').pop()!.content);

describe('ADR 0665 D5 — the narrative cast', () => {
  it('casts the PERSONA NAME when one is resolved, in the prose AND in the fence label', () => {
    const text = relayed(turnsToMessages(
      [turn('user.t.ada', 'user.t.ada')],
      'scaffold', 'user.t.grace',
      new Map([['user.t.ada', 'Ada Lovelace']]),
    ));
    expect(text, 'the prose cast').toContain('[Ada Lovelace]:');
    expect(text, 'the fence label names the same speaker').toContain('another participant (Ada Lovelace)');
    expect(text, 'and the slug is gone from the cast').not.toContain('[user.t.ada]:');
  });

  it('falls back to the SLUG when the id is not in the map — never a blank cast', () => {
    // The failure mode this guards: an `??`/`||` slip, or a map miss, producing `[]:`.
    const text = relayed(turnsToMessages(
      [turn('user.t.ada', 'user.t.ada')],
      'scaffold', 'user.t.grace',
      new Map([['someone.else', 'Grace Hopper']]),
    ));
    expect(text).toContain('[user.t.ada]:');
    expect(text, 'a blank cast would be worse than the slug').not.toContain('[]:');
  });

  it('an EMPTY resolved name is treated as no name, not as a blank cast', () => {
    const text = relayed(turnsToMessages(
      [turn('user.t.ada', 'user.t.ada')],
      'scaffold', 'user.t.grace',
      new Map([['user.t.ada', '']]),
    ));
    expect(text).toContain('[user.t.ada]:');
    expect(text).not.toContain('[]:');
  });

  it('no map at all behaves exactly as before — the pre-D5 rendering, not a regression', () => {
    const text = relayed(turnsToMessages([turn('user.t.ada', 'user.t.ada')], 'scaffold', 'user.t.grace'));
    expect(text).toContain('[user.t.ada]:');
  });
});

describe('ADR 0665 D5 — resolvePersonaNames', () => {
  it('resolves a registry agent’s persona, and OMITS an id it cannot name', async () => {
    __clearAgentIdentityCache();
    getAgentRegistry().register({
      agentId: 'test.d5.ada', persona: 'Ada Lovelace', label: 'Analyst', modelClass: 'general',
      systemPrompt: 'You are Ada.', packName: 'test', packVersion: '0', toolAllowlist: [],
    } as never);
    const names = await resolvePersonaNames('_anon', ['test.d5.ada', 'test.d5.nobody']);
    expect(names.get('test.d5.ada')).toBe('Ada Lovelace');
    // Omission, not a blank entry — that is what lets the caller fall back to the slug.
    expect(names.has('test.d5.nobody')).toBe(false);
  });

  it('an empty id set does no work and returns an empty map (the 1:1 chat pays nothing)', async () => {
    expect((await resolvePersonaNames('_anon', [])).size).toBe(0);
    expect((await resolvePersonaNames('_anon', [''])).size).toBe(0);
  });
});
