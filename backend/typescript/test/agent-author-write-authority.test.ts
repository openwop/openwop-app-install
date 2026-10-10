/**
 * ADR 0775 D7 — agent-author honours its toggle and the roster write authority.
 *
 * Architect B1: once `POST /roster` required `workspace:write` (D1), a viewer
 * the route refuses could still create a roster agent by asking the Agent
 * Author in chat (the persist tool checked only that SOME human was acting), and
 * the node surface's `persistDraft` checked nothing, so a headless run could
 * create one. And the four chat tools ignored their default-OFF toggle
 * (`ARWF-9`). These call the REGISTERED tools and the surface the node pack calls.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { registerAgentAuthorAgentTools, AGENT_AUTHOR_PERSIST_TOOL_ID, AGENT_AUTHOR_GET_TOOL_ID } from '../src/features/agent-author/agentTools.js';
import { buildAgentAuthorSurface } from '../src/features/agent-author/surface.js';
import { agentAuthorFeature } from '../src/features/agent-author/feature.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { listRoster } from '../src/host/rosterService.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';

const WS = 'ws:agent-author-authz';
const OWNER = 'user:aa-owner';
const VIEWER = 'user:aa-viewer';
const PACK_AGENT = 'test.author-backing';

const draft = (persona: string) => ({ persona, agentId: PACK_AGENT, autonomyLevel: 'review' as const, workflows: [] as string[] });
const run = async (toolId: string, input: unknown, scope: Partial<BundleScope>) => {
  const tool = builtinAgentTool(toolId);
  if (!tool) throw new Error(`tool ${toolId} not registered`);
  const out = await tool.run(input as Record<string, unknown>, { tenantId: WS, ...scope } as BundleScope);
  return { ...out, parsed: JSON.parse(String(out.content)) as Record<string, unknown> };
};
const toggle = async (status: 'on' | 'off') => saveConfig({ ...agentAuthorFeature.toggleDefault!, status }, 'test');

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault(agentAuthorFeature.toggleDefault!);
  registerAgentAuthorAgentTools();
  getAgentRegistry().register({ agentId: PACK_AGENT, persona: 'Backing', modelClass: 'general', systemPrompt: 'x', packName: 'test', packVersion: '0', toolAllowlist: [] });
  const org = await createOrg({ tenantId: WS, orgId: WS, createdBy: OWNER, name: 'AA', ownerSubject: OWNER, ownerDisplayName: 'Owner' });
  await createMember({ orgId: org.orgId, tenantId: WS, displayName: 'Viewer', subject: VIEWER, roles: ['viewer'] });
});
afterAll(() => {
  getAgentRegistry()._resetForTest();
  __resetHostExtPersistence();
});

describe('ADR 0775 D7 — the persist tool uses the route’s write authority', () => {
  it('a viewer is refused and nothing is created; the owner creates', async () => {
    await toggle('on');
    const refused = await run(AGENT_AUTHOR_PERSIST_TOOL_ID, { draft: draft('Viewer Built') }, { actingUserId: VIEWER });
    expect(refused.isError).toBe(true);
    expect(refused.parsed.error).toBe('forbidden_scope');
    expect((await listRoster(WS)).map((e) => e.persona)).not.toContain('Viewer Built');

    const made = await run(AGENT_AUTHOR_PERSIST_TOOL_ID, { draft: draft('Owner Built') }, { actingUserId: OWNER });
    expect(made.isError, JSON.stringify(made.parsed)).toBeFalsy();
    expect((await listRoster(WS)).map((e) => e.persona)).toContain('Owner Built');
  });

  it('the node surface refuses a headless persist and a viewer', async () => {
    await toggle('on');
    await expect(buildAgentAuthorSurface({ tenantId: WS } as BundleScope).persistDraft!({ draft: draft('Headless Built') })).rejects.toThrow(/signed-in user/);
    await expect(buildAgentAuthorSurface({ tenantId: WS, actingUserId: VIEWER } as BundleScope).persistDraft!({ draft: draft('Surface Viewer') })).rejects.toThrow(/workspace:write/);
    expect((await listRoster(WS)).map((e) => e.persona)).not.toEqual(expect.arrayContaining(['Headless Built', 'Surface Viewer']));
  });
});

describe('ADR 0775 D7 — the tools honour the default-OFF toggle', () => {
  it('toggle off ⇒ typed feature_disabled, nothing created; toggle on ⇒ the catalog reads', async () => {
    await toggle('off');
    const get = await run(AGENT_AUTHOR_GET_TOOL_ID, {}, { actingUserId: OWNER });
    expect(get.parsed.error).toBe('feature_disabled');
    const persist = await run(AGENT_AUTHOR_PERSIST_TOOL_ID, { draft: draft('While Off') }, { actingUserId: OWNER });
    expect(persist.parsed.error).toBe('feature_disabled');
    expect((await listRoster(WS)).map((e) => e.persona)).not.toContain('While Off');

    await toggle('on');
    const on = await run(AGENT_AUTHOR_GET_TOOL_ID, {}, { actingUserId: OWNER });
    expect(Array.isArray(on.parsed.agents), JSON.stringify(on.parsed)).toBe(true);
  });
});
