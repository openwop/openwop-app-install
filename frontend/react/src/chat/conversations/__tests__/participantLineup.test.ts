import { describe, it, expect } from 'vitest';
import { participantsToLineup, type AgentResolver } from '../participantLineup.js';
import type { ConversationParticipant } from '../../../client/chatSessionsClient.js';

function p(subjectRef: string, role: 'owner' | 'member' = 'member'): ConversationParticipant {
  return { subjectRef, role, addedAt: '2026-01-01T00:00:00Z' };
}

// Resolver that knows ada + felix, but not "ghost".
const resolve: AgentResolver = (id) => {
  const known: Record<string, { persona: string; slug: string; modelClass: string }> = {
    'user.t.ada': { persona: 'Ada', slug: 'ada', modelClass: 'chat' },
    'user.t.felix': { persona: 'Felix', slug: 'felix', modelClass: 'reasoning' },
  };
  return known[id] ?? null;
};

describe('participantsToLineup', () => {
  it('projects agent participants to rows in order, skipping the owner', () => {
    const rows = participantsToLineup(
      [p('user:u1', 'owner'), p('agent:user.t.ada'), p('agent:user.t.felix')],
      resolve,
    );
    expect(rows.map((r) => r.agentId)).toEqual(['user.t.ada', 'user.t.felix']);
    expect(rows[0]).toMatchObject({ persona: 'Ada', slug: 'ada', modelClass: 'chat', addedAt: '2026-01-01T00:00:00Z' });
  });

  it('drops an unresolvable agent ref (catalog miss) rather than surfacing a bare id', () => {
    const rows = participantsToLineup([p('agent:ghost'), p('agent:user.t.ada')], resolve);
    expect(rows.map((r) => r.agentId)).toEqual(['user.t.ada']);
  });

  it('de-duplicates a repeated agent ref', () => {
    const rows = participantsToLineup([p('agent:user.t.ada'), p('agent:user.t.ada')], resolve);
    expect(rows).toHaveLength(1);
  });

  it('returns an empty lineup for an owner-only (1:1-with-self / legacy) conversation', () => {
    expect(participantsToLineup([p('user:u1', 'owner')], resolve)).toEqual([]);
    expect(participantsToLineup([], resolve)).toEqual([]);
  });
});
