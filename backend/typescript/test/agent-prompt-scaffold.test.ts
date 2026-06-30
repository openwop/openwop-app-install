/**
 * Persona-preservation scaffold (fix: agents confusing the user with a prior
 * agent and impersonating other agents in a shared chat thread).
 */
import { describe, expect, it } from 'vitest';
import { composeAgentSystemPrompt } from '../src/host/agentPromptScaffold.js';

const IRIS = 'You are Iris, the Chief of Staff. You hold a structured memory graph…';

describe('composeAgentSystemPrompt', () => {
  it('keeps the persona body, names the user, and ends with the identity re-anchor', () => {
    const out = composeAgentSystemPrompt({ persona: 'Iris', role: 'Chief of Staff', systemPrompt: IRIS, userName: 'David' });
    expect(out.startsWith(IRIS)).toBe(true);
    expect(out).toContain('human user named David');
    expect(out).toContain('Address them as David');
    // Recency: the strongest identity instruction is the LAST line.
    const lastLine = out.trimEnd().split('\n').pop()!;
    expect(lastLine).toContain('Stay in character as Iris, Chief of Staff');
    expect(lastLine).toContain("never adopt another agent's name, role, or capabilities");
    // Narrative-casting + handle framing present.
    expect(out).toContain('[Name]:');
    expect(out).toContain('"@name" is');
  });

  it('falls back to neutral second-person address for an anonymous user (no name invented)', () => {
    const out = composeAgentSystemPrompt({ persona: 'Devon', role: 'Engineering Ops Coordinator', systemPrompt: 'You are Devon…', userName: null });
    expect(out).toContain('Address them in the second person');
    expect(out).toContain('never invent or guess a name');
    expect(out).not.toContain('named ');
  });

  it('injects the strategy context block after the persona, before CONVERSATION CONTEXT (ADR 0079 Phase 5)', () => {
    const block = 'STRATEGIC CONTEXT (...):\n• Win FY26 [s-1] (annual, active)';
    const out = composeAgentSystemPrompt({ persona: 'Iris', systemPrompt: IRIS, userName: 'David', injectedContextBlock: block });
    expect(out.startsWith(IRIS)).toBe(true);
    expect(out).toContain(block);
    // Order: persona … strategy block … CONVERSATION CONTEXT … identity re-anchor.
    expect(out.indexOf(block)).toBeLessThan(out.indexOf('CONVERSATION CONTEXT:'));
    expect(out.indexOf(IRIS)).toBeLessThan(out.indexOf(block));
  });

  it('omits the strategy block entirely when absent/empty', () => {
    expect(composeAgentSystemPrompt({ persona: 'Iris', systemPrompt: IRIS, userName: 'David' })).not.toContain('STRATEGIC CONTEXT');
    expect(composeAgentSystemPrompt({ persona: 'Iris', systemPrompt: IRIS, userName: 'David', injectedContextBlock: '   ' })).not.toContain('STRATEGIC CONTEXT');
  });

  it('treats empty/whitespace userName as anonymous', () => {
    const out = composeAgentSystemPrompt({ persona: 'Devon', systemPrompt: 'x', userName: '   ' });
    expect(out).toContain('second person');
  });

  it('omits the role clause when no role is given', () => {
    const out = composeAgentSystemPrompt({ persona: 'Devon', systemPrompt: 'x', userName: 'Sam' });
    const lastLine = out.trimEnd().split('\n').pop()!;
    // "Devon." (immediate period) ⇒ no ", <role>" clause was inserted.
    expect(lastLine).toContain('Stay in character as Devon.');
  });
});
