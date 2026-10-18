/**
 * XCH-SIM-5 — a sim persona's prompt gives ONE output instruction. The three
 * prompts used to say "report in plain prose on your scratchpad" AND "return a
 * typed verdict object, and nothing else"; a model obeying the first returns
 * prose, the dispatcher rejects it (return_schema_violation) and the sim
 * degrades to `block`. Sabotage: restoring the prose line in any one prompt
 * reds this.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', '..', '..', 'packs/vendor.openwop-app.kicktodo.agents/prompts');

describe('sim persona prompts ask for exactly one output shape (XCH-SIM-5)', () => {
  for (const f of ['sim-newcomer.md', 'sim-time-poor.md', 'sim-skeptic.md']) {
    it(`${f} asks for the typed verdict and never for prose`, () => {
      const p = readFileSync(join(DIR, f), 'utf8');
      expect(p).toMatch(/return a typed verdict object, and nothing else/);
      expect(p).not.toMatch(/scratchpad/i);
      expect(p).not.toMatch(/in plain\s+prose/i);
    });
  }
});
