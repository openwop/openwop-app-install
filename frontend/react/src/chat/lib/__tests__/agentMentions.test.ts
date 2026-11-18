/**
 * Agent @-mention dedup (fix: the picker showed @devon … @devon-6, one row per
 * duplicate roster/registry twin of the same persona) and the attribution-label
 * humanizer (prod 2026-10-09: a lineup miss rendered "Vendor.openwop App…").
 *
 * Breaks it: dropping a field from `agentSignature` (two different reviewers
 * collapse), losing the `user.` preference (`@devon` dispatches to a roster twin),
 * or reading a dotted agentId whole in `slugToName`.
 */
import { describe, expect, it } from 'vitest';
import { projectAgents, slugToName } from '../agentMentions.js';
import type { AgentEntry } from '../../../client/agentsClient.js';

function agent(partial: Partial<AgentEntry>): AgentEntry {
  const base: AgentEntry = {
    agentId: 'x',
    persona: 'X',
    label: 'X',
    description: 'd',
    packName: 'p',
    packVersion: '1.0.0',
    modelClass: 'chat',
    toolAllowlist: [],
    hasHandoffSchemas: false,
  };
  return { ...base, ...partial };
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

  it('names a pack agentId by its last segment, never the dotted path', () => {
    expect(slugToName('vendor.openwop-app.assistant.agents.chief-of-staff')).toBe('Chief Of Staff');
  });

  it('returns the input when there is nothing to humanize', () => {
    expect(slugToName('')).toBe('');
  });
});

describe('issue 5800 — a role-token persona does not become the handle', () => {
  it('builds the handle from the label when persona is a bare upper-case role token', () => {
    const rows = projectAgents([
      agent({ agentId: 'p.extractor', persona: 'RESEARCH', label: 'Commitment Extractor', description: 'a' }),
      agent({ agentId: 'p.chief', persona: 'SUPERVISOR', label: 'Chief of Staff', description: 'b' }),
      agent({ agentId: 'p.r2', persona: 'RESEARCH', label: 'Market Scan', description: 'c' }),
    ]);
    expect(rows.map((r) => r.slug)).toEqual(['commitment-extractor', 'chief-of-staff', 'market-scan']);
  });

  it('keeps a real persona name as the handle, label or not, so existing handles do not move', () => {
    const rows = projectAgents([agent({ agentId: 'p.cr', persona: 'Code Reviewer', label: 'Reviewer', description: 'x' })]);
    expect(rows[0]!.slug).toBe('code-reviewer');
  });

  it('a role token with no label still slugs the token', () => {
    const rows = projectAgents([agent({ agentId: 'p.g', persona: 'GENERAL', label: '', description: 'y' })]);
    expect(rows[0]!.slug).toBe('general');
  });
});

describe('issue 5799 — smoke-fixture agents are not offered', () => {
  it('drops every agent of a fixture pack from the picker, and keeps the rest', () => {
    const rows = projectAgents([
      agent({ agentId: 'core.openwop.agent-examples.echo-agent', persona: 'Echo', packName: 'core.openwop.agent-examples', description: 'e' }),
      agent({ agentId: 'core.openwop.agent-examples.tool-caller', persona: 'Tool Caller', packName: 'core.openwop.agent-examples', description: 't' }),
      agent({ agentId: 'p.real', persona: 'Real Agent', packName: 'p', description: 'r' }),
    ]);
    expect(rows.map((r) => r.agentId)).toEqual(['p.real']);
  });
});
