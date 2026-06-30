/**
 * ADR 0104 Phase 1 — the super-admin tool-allowlist override store + its
 * application at a model-offering chokepoint (compileAgentTools, the chat path).
 *
 * The override FULL-REPLACES the manifest allowlist for what the host offers the
 * model; it is fail-closed cross-tenant; it covers PACK agentIds (no `host:`
 * prefix — the Chief of Staff is the first consumer); clearing reverts to the
 * manifest. The override is still intersected with `availableTools`, so granting a
 * tool that isn't mounted is a no-op.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  resolveAgentToolAllowlistOverride,
  getAgentToolAllowlistOverride,
  listAgentToolAllowlistOverrides,
  upsertAgentToolAllowlistOverride,
  clearAgentToolAllowlistOverride,
  __resetAgentToolAllowlistOverrides,
} from '../src/host/agentToolAllowlistService.js';
import { compileAgentTools } from '../src/host/agentDispatch.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';

const storage = openSqliteStorage(':memory:');
beforeAll(() => initHostExtPersistence(storage));
afterAll(async () => { await storage.close(); });
beforeEach(async () => { await __resetAgentToolAllowlistOverrides(); });

// A PACK agentId (no `host:` prefix) — the case resolveAgentToolPermissions skips
// and this override MUST cover (granting the Chief of Staff a tool).
const PACK_AGENT = 'feature.assistant.agents.chief-of-staff';

describe('agentToolAllowlistService — override store (ADR 0104)', () => {
  it('absent override resolves to undefined (caller falls back to the manifest)', async () => {
    expect(await resolveAgentToolAllowlistOverride('t1', PACK_AGENT)).toBeUndefined();
  });

  it('upsert → resolve round-trips, full-replace, for a PACK agentId', async () => {
    await upsertAgentToolAllowlistOverride('t1', PACK_AGENT, { toolAllowlist: ['openwop:a', 'openwop:b'], updatedBy: 'admin' });
    expect(await resolveAgentToolAllowlistOverride('t1', PACK_AGENT)).toEqual(['openwop:a', 'openwop:b']);
    await upsertAgentToolAllowlistOverride('t1', PACK_AGENT, { toolAllowlist: ['openwop:c'], updatedBy: 'admin' });
    expect(await resolveAgentToolAllowlistOverride('t1', PACK_AGENT)).toEqual(['openwop:c']);
  });

  it('empty array means "no tools" — distinct from an absent override', async () => {
    await upsertAgentToolAllowlistOverride('t1', PACK_AGENT, { toolAllowlist: [], updatedBy: 'admin' });
    expect(await resolveAgentToolAllowlistOverride('t1', PACK_AGENT)).toEqual([]);
  });

  it('is fail-closed cross-tenant for a GLOBAL pack agent', async () => {
    await upsertAgentToolAllowlistOverride('t1', PACK_AGENT, { toolAllowlist: ['openwop:a'], updatedBy: 'admin' });
    expect(await resolveAgentToolAllowlistOverride('t2', PACK_AGENT)).toBeUndefined();
    expect(await getAgentToolAllowlistOverride('t2', PACK_AGENT)).toBeNull();
    expect(await listAgentToolAllowlistOverrides('t2')).toEqual([]);
    expect((await listAgentToolAllowlistOverrides('t1')).map((o) => o.agentId)).toEqual([PACK_AGENT]);
  });

  it('clear reverts to the manifest; clearing again returns false', async () => {
    await upsertAgentToolAllowlistOverride('t1', PACK_AGENT, { toolAllowlist: ['openwop:a'], updatedBy: 'admin' });
    expect(await clearAgentToolAllowlistOverride('t1', PACK_AGENT)).toBe(true);
    expect(await resolveAgentToolAllowlistOverride('t1', PACK_AGENT)).toBeUndefined();
    expect(await clearAgentToolAllowlistOverride('t1', PACK_AGENT)).toBe(false);
  });
});

describe('compileAgentTools — honors the allowlist override (ADR 0104)', () => {
  // Mirrors the manifest stub idiom in agent-tool-provider.test.ts.
  const agent = { agentId: PACK_AGENT, persona: 'SUPERVISOR', toolAllowlist: ['openwop:manifest-only'] } as unknown as ResolvedAgentManifest;
  const available = ['openwop:manifest-only', 'openwop:granted'];
  const resolveTool = (name: string): { name: string; description: string; inputSchema: Record<string, unknown> } => ({ name, description: name, inputSchema: { type: 'object' } });

  it('without an override, offers manifest ∩ available', () => {
    const tools = compileAgentTools(agent, available, resolveTool);
    expect(tools.map((t) => t.def.name)).toEqual(['openwop:manifest-only']);
  });

  it('with an override, FULL-REPLACES — offers override ∩ available (drops the manifest-only tool)', () => {
    const tools = compileAgentTools(agent, available, resolveTool, ['openwop:granted']);
    expect(tools.map((t) => t.def.name)).toEqual(['openwop:granted']);
  });

  it('granting a tool that is not mounted (not in available) is a no-op', () => {
    const tools = compileAgentTools(agent, available, resolveTool, ['openwop:not-mounted']);
    expect(tools).toEqual([]);
  });
});
