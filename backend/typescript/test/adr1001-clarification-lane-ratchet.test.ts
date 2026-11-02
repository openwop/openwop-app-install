/**
 * ADR 1001 D1 (review M9) — only the run lane can make an agent turn pause on a
 * clarification.
 *
 * Why it exists: `AgentDispatchRequest.clarification` turns on the envelope, and
 * a turn that asks returns `status: 'escalated'` with a `clarification` field
 * and NO answer. Only the agent-runner node can suspend on that; the host-ext
 * dispatch routes (`routes/agents.ts`), A2A and the chat lane would hand the
 * caller an empty escalation. So the option is set in exactly ONE place, the
 * node's clarifying dispatch, and this pins it there.
 *
 * Sabotage: adding `clarification: { roundsUsed: 0, … }` to any other dispatch
 * call site reds it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('ADR 1001 — the clarification option has one setter', () => {
  it('only host/agentClarificationTurn.ts sets AgentDispatchRequest.clarification (agentDispatch only forwards it)', () => {
    const setters = files(SRC)
      .filter((p) => /clarification:\s*\{\s*roundsUsed/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p).split('\\').join('/'));
    // agentDispatch.ts is the loop forwarding `req.clarification` onto the loop
    // options; it sets nothing of its own. Every other file is a new setter.
    expect(setters.sort()).toEqual(['host/agentClarificationTurn.ts', 'host/agentDispatch.ts']);
    const dispatch = readFileSync(join(SRC, 'host/agentDispatch.ts'), 'utf8');
    for (const m of dispatch.matchAll(/clarification:\s*\{\s*roundsUsed[^\n]*/g)) {
      expect(m[0]).toContain('req.clarification.roundsUsed');
    }
  });
});
