/**
 * Guards the contract the builder's Pair tab (ADR 0773) depends on: the
 * `vendor.openwop-app.workflow-author.agents` pack (ADR 0072) must load the Workflow
 * Architect agent under the EXACT agentId the frontend scopes to
 * (`builder/pair/PairPanel.tsx` → `WORKFLOW_ARCHITECT_AGENT_ID` → EmbeddedChatPanel
 * `agentId`), with its workflow-authoring system prompt resolved.
 *
 * If the ids drift, or the prompt stops resolving (the loader then SKIPS the
 * agent), useScopeToAgent silently falls back to the default assistant and the
 * embed runs WITHOUT the workflow-authoring system prompt — looking like the
 * generic chat. This test fails loudly instead. Loads the pack the way bootstrap
 * does (`loadAgentsFromManifest`); the route that lists loaded agents is generic
 * and covered by `test/agent-dispatch-route.test.ts` ("serves the NORMATIVE
 * inventory GET /agents"), so no app boot here.
 *
 * Sabotage-witnessed (grade-tests w18): renaming the frontend constant, the
 * manifest label, or pointing `systemPromptRef` at a missing file each turn a
 * case red (`w18g1-p-frontend`, `-p-label`, `-p-prompt`).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const ARCHITECT = 'vendor.openwop-app.workflow-author.agents.workflow-architect';

const architect = () =>
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'vendor.openwop-app.workflow-author.agents'))
    .find((agent) => agent.agentId === ARCHITECT);

describe('ADR 0072/0073 — the Workflow Architect agent the builder embed scopes to', () => {
  it('loads under the agentId the frontend hardcodes, with its label', () => {
    const panel = readFileSync(join(REPO_ROOT, 'frontend/react/src/builder/pair/PairPanel.tsx'), 'utf8');
    const frontendId = /WORKFLOW_ARCHITECT_AGENT_ID\s*=\s*'([^']+)'/.exec(panel)?.[1];
    expect(frontendId, 'PairPanel.tsx must export WORKFLOW_ARCHITECT_AGENT_ID').toBe(ARCHITECT);
    const agent = architect();
    expect(agent, `agent ${ARCHITECT} must load from its pack`).toBeDefined();
    expect(agent?.label).toBe('Workflow Architect');
  });

  it('resolves its workflow-authoring system prompt (not the default assistant)', () => {
    const prompt = architect()?.systemPrompt ?? '';
    expect(prompt).toContain('**persist**');
    expect(prompt).toContain('MUST be acyclic');
  });
});
