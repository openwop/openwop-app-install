/**
 * XCH-SIM-5 — a sim persona's prompt gives ONE output instruction. The three
 * prompts used to say "report in plain prose on your scratchpad" AND "return a
 * typed verdict object, and nothing else"; a model obeying the first returns
 * prose, the dispatcher rejects it (return_schema_violation) and the sim
 * degrades to `block`.
 *
 * TST-DKA-1 (grade-tests wave 72). The prompts checked are DERIVED from the
 * pack's `.sim-` agents, so a fourth persona cannot ship unchecked; the floor
 * case pins which personas exist. Red when: the prose/scratchpad instruction
 * returns to any sim prompt (w72 probe sim-prose), or a sim persona is added,
 * removed or re-pointed without this file being reviewed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACK = join(import.meta.dirname, '..', '..', '..', 'packs/vendor.openwop-app.kicktodo.agents');
const pack = JSON.parse(readFileSync(join(PACK, 'pack.json'), 'utf8')) as {
  agents: Array<{ agentId: string; systemPromptRef?: string }>;
};
const SIM_PROMPTS = pack.agents
  .filter((a) => a.agentId.includes('.sim-'))
  .map((a) => a.systemPromptRef ?? `(no systemPromptRef: ${a.agentId})`)
  .sort();

describe('sim persona prompts ask for exactly one output shape (XCH-SIM-5)', () => {
  it('the pack ships exactly the three sim personas', () => {
    expect(SIM_PROMPTS).toEqual(['prompts/sim-newcomer.md', 'prompts/sim-skeptic.md', 'prompts/sim-time-poor.md']);
  });

  for (const ref of SIM_PROMPTS) {
    it(`${ref.replace('prompts/', '')} asks for the typed verdict and never for prose`, () => {
      const p = readFileSync(join(PACK, ref), 'utf8');
      expect(p).toMatch(/return a typed verdict object, and nothing else/);
      expect(p).not.toMatch(/scratchpad/i);
      expect(p).not.toMatch(/in plain\s+prose/i);
    });
  }
});
