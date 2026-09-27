/**
 * ADR 0458 P1 — Challenge Author prompt↔allowlist parity (the promptCatalogParity
 * precedent, mirrored from `agent-prompt-tool-ids.test.ts` and
 * `kicktodo-artifact-parity.test.ts`).
 *
 * The Challenge Author is the one roster-bound named agent in the kicktodo agents
 * pack, and it names its tools to the model in prose. A prompt that names a tool
 * the model cannot call — or an allowlist that grants a tool the prompt never
 * teaches — is a drift/lie to the model. This pins BOTH directions to the two
 * ADR 0458 tool ids: the prompt names exactly those two `openwop:` ids and no
 * others, and the pack entry's `toolAllowlist` is exactly those two.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const AGENTS_PACK_DIR = join(REPO, 'packs/feature.kicktodo.agents');

const AGENT_ID = 'feature.kicktodo.agents.challenge-author';
const ALLOWED_TOOL_IDS = ['openwop:kicktodo.candidates', 'openwop:kicktodo.factory.run'];
const ID_RE = /openwop:[A-Za-z0-9._-]+/g;

const pack = JSON.parse(readFileSync(join(AGENTS_PACK_DIR, 'pack.json'), 'utf8')) as {
  agents: Array<{ agentId: string; systemPromptRef?: string; toolAllowlist?: string[] }>;
};
const entry = pack.agents.find((a) => a.agentId === AGENT_ID);

describe('Challenge Author prompt ↔ allowlist parity (ADR 0458 P1)', () => {
  it('the pack declares the Challenge Author agent with a systemPromptRef', () => {
    expect(entry, `${AGENT_ID} must be declared in the agents pack`).toBeDefined();
    expect(typeof entry!.systemPromptRef).toBe('string');
  });

  it("the entry's toolAllowlist is EXACTLY the two ADR 0458 tool ids", () => {
    expect(entry!.toolAllowlist).toEqual(ALLOWED_TOOL_IDS);
  });

  const prompt = readFileSync(join(AGENTS_PACK_DIR, entry!.systemPromptRef!), 'utf8');
  const mentioned = [...new Set(Array.from(prompt.matchAll(ID_RE), (m) => m[0]))].sort();

  it('the prompt names BOTH allowlisted tool ids verbatim', () => {
    for (const id of ALLOWED_TOOL_IDS) {
      expect(prompt.includes(id), `prompt must name ${id} verbatim`).toBe(true);
    }
  });

  it('the prompt names NO other openwop: tool id', () => {
    expect(mentioned).toEqual([...ALLOWED_TOOL_IDS].sort());
  });
});
