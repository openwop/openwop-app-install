/**
 * XCH-SPEC-3 — every agent in the KickTodo agents pack names in its prompt
 * EXACTLY the tool ids its allowlist grants (the Challenge Author's parity test,
 * generalised to the specialists and sims). A prompt naming a tool the model
 * cannot call, or an allowlist granting a tool the prompt never teaches, is a
 * lie to the model.
 *
 * XCH-SPEC-2 — and any agent allowed `progress` (which needs an `enrollmentId`)
 * can also call `today`, the only tool that discovers one.
 *
 * Sabotage: dropping `openwop:kicktodo.today` from the safety reviewer's
 * allowlist reds the SPEC-2 case and the parity case for it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACK = join(import.meta.dirname, '..', '..', '..', 'packs/vendor.openwop-app.kicktodo.agents');
const pack = JSON.parse(readFileSync(join(PACK, 'pack.json'), 'utf8')) as {
  agents: Array<{ agentId: string; systemPromptRef?: string; toolAllowlist?: string[] }>;
};
const ID_RE = /openwop:[A-Za-z0-9._-]+/g;

describe('KickTodo agents: prompt ↔ allowlist parity (XCH-SPEC-3)', () => {
  for (const a of pack.agents) {
    it(`${a.agentId.split('.').pop()} names exactly its allowlisted tools`, () => {
      expect(typeof a.systemPromptRef).toBe('string');
      const prompt = readFileSync(join(PACK, a.systemPromptRef!), 'utf8');
      const named = [...new Set(Array.from(prompt.matchAll(ID_RE), (m) => m[0].replace(/[.,;:]+$/, '')))].sort();
      expect(named).toEqual([...(a.toolAllowlist ?? [])].sort());
    });
  }
});

describe('an agent that can read progress can discover an enrollment (XCH-SPEC-2)', () => {
  for (const a of pack.agents.filter((x) => (x.toolAllowlist ?? []).includes('openwop:kicktodo.progress'))) {
    it(`${a.agentId.split('.').pop()} also has openwop:kicktodo.today`, () => {
      expect(a.toolAllowlist).toContain('openwop:kicktodo.today');
    });
  }
});
