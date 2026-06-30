/**
 * Agent @-mention dedup (fix: the picker showed @devon … @devon-6, one row per
 * duplicate roster/registry twin of the same persona).
 */
import { describe, expect, it } from 'vitest';
import { projectAgents, slugToName } from '../agentMentions.js';
import type { AgentEntry } from '../../../client/agentsClient.js';

function agent(partial: Partial<AgentEntry>): AgentEntry {
  return {
    agentId: 'x',
    persona: 'X',
    label: 'X',
    description: 'd',
    packName: 'p',
    packVersion: '1.0.0',
    modelClass: 'chat',
    ...partial,
  } as AgentEntry;
}

describe('projectAgents — dedup identical agents', () => {
  it('collapses a chat agent + its roster twins (same persona/label/desc/class) to ONE @mention', () => {
    const entries = projectAgents([
      agent({ agentId: 'host:devon-1', persona: 'Devon', label: 'Engineering Ops Coordinator', description: 'Pragmatic.', modelClass: 'chat' }),
      agent({ agentId: 'user.t.devon', persona: 'Devon', label: 'Engineering Ops Coordinator', description: 'Pragmatic.', modelClass: 'chat' }),
      agent({ agentId: 'host:devon-2', persona: 'Devon', label: 'Engineering Ops Coordinator', description: 'Pragmatic.', modelClass: 'chat' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.slug).toBe('devon'); // no -2/-3 suffix
    // The canonical chat agent (user.*) is kept as the dispatch identity.
    expect(entries[0]!.agentId).toBe('user.t.devon');
  });

  it('keeps GENUINELY different same-persona agents distinct, with the -2 suffix', () => {
    const entries = projectAgents([
      agent({ agentId: 'packA.cr', persona: 'Code Reviewer', description: 'Strict reviewer.', packName: 'packA' }),
      agent({ agentId: 'packB.cr', persona: 'Code Reviewer', description: 'Lenient reviewer.', packName: 'packB' }),
    ]);
    expect(entries.map((e) => e.slug)).toEqual(['code-reviewer', 'code-reviewer-2']);
  });

  it('leaves distinct personas untouched', () => {
    const entries = projectAgents([
      agent({ agentId: 'user.t.devon', persona: 'Devon' }),
      agent({ agentId: 'user.t.nora', persona: 'Nora' }),
    ]);
    expect(entries.map((e) => e.slug).sort()).toEqual(['devon', 'nora']);
  });
});

describe('slugToName — humanize a handle for attribution', () => {
  it('title-cases a kebab handle', () => {
    expect(slugToName('andru-carnagie')).toBe('Andru Carnagie');
    expect(slugToName('leo-da-vincio')).toBe('Leo Da Vincio');
    expect(slugToName('nora')).toBe('Nora');
  });

  it('extracts the trailing handle from a fully-qualified agentId', () => {
    expect(slugToName('user.user:c5118.advisor-leo-da-vincio')).toBe('Leo Da Vincio');
  });

  it('returns the input when there is nothing to humanize', () => {
    expect(slugToName('')).toBe('');
  });
});
