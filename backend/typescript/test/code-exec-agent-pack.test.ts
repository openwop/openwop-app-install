/**
 * ADR 0114 Phase 6 — the Code Interpreter agent pack.
 * The persona must LOAD (through the real agent loader) under its exact agentId, with its
 * `systemPromptRef` resolved into the system prompt and the code-exec node in its
 * toolAllowlist — so chat can scope to it and drive sandboxed execution.
 *
 * Breaks if the pack's agentId / label / toolAllowlist / prompt ref drifts, or the loader
 * stops resolving the ref: the Code Interpreter vanishes from chat or is toothless.
 * (The generic `/agents` route is covered by `agents.test.ts`; this file needs no app boot.)
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

// test dir = <repo>/backend/typescript/test → up 3 to the repo root (where packs/ live).
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const AGENT = 'vendor.openwop-app.code-exec.agents.default';

beforeAll(() => {
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'vendor.openwop-app.code-exec.agents'));
});
afterAll(() => getAgentRegistry()._resetForTest());

describe('ADR 0114 Phase 6 — Code Interpreter agent pack', () => {
  it('surfaces in the agent registry under its agentId, with its label', () => {
    const agent = getAgentRegistry().get(AGENT);
    expect(agent?.agentId, `agent ${AGENT} must load`).toBe(AGENT);
    expect(agent?.label).toBe('Code Interpreter');
  });

  it('declares the code-exec node in its toolAllowlist + a resolved prompt (loaded manifest)', () => {
    const agent = getAgentRegistry().get(AGENT)!;
    expect(agent.toolAllowlist).toEqual(['openwop:feature.code-exec.nodes.run']);
    expect(agent.systemPromptRef).toBe('prompts/code-interpreter.md');
    // the ref was RESOLVED by the loader into the prompt text, which names the persona
    expect(agent.systemPrompt).toContain('You are **Code Interpreter**');
  });
});
