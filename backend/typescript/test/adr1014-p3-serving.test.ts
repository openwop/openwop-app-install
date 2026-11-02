/**
 * ADR 1014 P3 (D4) — what runs when nothing names a version, behind
 * `OPENWOP_AGENT_VERSIONS=on`.
 *
 * Red when: the flag off changes anything; the flag on runs the head for a pack
 * agent whose deployment serves another version on `stable`; a deployment with
 * nothing on `stable` falls back to the head instead of refusing; a newly installed version of a deployed
 * agent is not minted as a `draft` (or is minted for a tenant that does not
 * deploy it, or twice); or a new EXECUTION site reads an agent from the registry
 * without going through `resolveServedAgent` (the ratchet).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { registerAgentServingResolver, resolveServedAgent, resolveServedAgentDetailed, servingVersion, type ServingResolver } from '../src/host/agentServing.js';
import { AgentVersionUnavailableError, runAgentDispatchLive } from '../src/host/agentDispatch.js';

const AGENT = 'acme.agents.served.a';
const manifest = (version: string, persona: string, ownerTenant?: string): ResolvedAgentManifest => ({
  agentId: AGENT, persona, modelClass: 'no-such-model-class', systemPrompt: `I am ${version}.`, toolAllowlist: [],
  packName: 'acme.agents.served', packVersion: version, ...(ownerTenant ? { ownerTenant } : {}),
});
const deps = { callAI: async () => { throw new Error('no provider in this test'); }, modelOptions: { preferManaged: true } };

describe('ADR 1014 D4 — the serving seam', () => {
  let serving: string | null | undefined;
  const stub: ServingResolver = async () => serving;
  beforeEach(() => {
    const r = getAgentRegistry();
    r._resetForTest();
    r.register(manifest('2.0.0', 'Head'));
    r.registerVersion(manifest('1.0.0', 'Stable'));
    registerAgentServingResolver(stub);
  });
  afterEach(() => {
    delete process.env.OPENWOP_AGENT_VERSIONS;
    registerAgentServingResolver(undefined);
    getAgentRegistry()._resetForTest();
  });

  it('flag off: always the head, whatever a deployment serves', async () => {
    serving = '1.0.0';
    expect(await servingVersion('t', AGENT, 'k')).toBeUndefined();
    expect((await resolveServedAgent(AGENT, 't', 'k'))?.persona).toBe('Head');
    expect((await runAgentDispatchLive({ agentId: AGENT, tenantId: 't', task: 'x' }, deps)).persona).toBe('Head');
  });

  it('flag on: the version stable serves; no rows → the head; nothing on stable → refused, never the head', async () => {
    process.env.OPENWOP_AGENT_VERSIONS = 'on';
    serving = '1.0.0';
    expect((await resolveServedAgent(AGENT, 't', 'k'))?.persona).toBe('Stable');
    expect((await runAgentDispatchLive({ agentId: AGENT, tenantId: 't', task: 'x' }, deps)).persona).toBe('Stable');
    serving = undefined;
    expect((await runAgentDispatchLive({ agentId: AGENT, tenantId: 't', task: 'x' }, deps)).persona).toBe('Head');
    serving = null;
    expect(await resolveServedAgent(AGENT, 't', 'k')).toBeNull();
    await expect(runAgentDispatchLive({ agentId: AGENT, tenantId: 't', task: 'x' }, deps)).rejects.toBeInstanceOf(AgentVersionUnavailableError);
  });

  it('flag on: a refused serve says so, so chat fails closed instead of degrading to a default prompt (review M5)', async () => {
    process.env.OPENWOP_AGENT_VERSIONS = 'on';
    serving = null;
    expect(await resolveServedAgentDetailed(AGENT, 't', 'k')).toEqual({ agent: null, refused: true });
    serving = '9.9.9';
    expect((await resolveServedAgentDetailed(AGENT, 't', 'k')).refused).toBe(true);
    expect((await resolveServedAgentDetailed('acme.agents.unknown', 't', 'k')).refused, 'an unknown agent is a miss, not a refusal').toBe(false);
  });

  it('flag on: a named version still wins over serving', async () => {
    process.env.OPENWOP_AGENT_VERSIONS = 'on';
    serving = '1.0.0';
    expect((await runAgentDispatchLive({ agentId: AGENT, tenantId: 't', version: '2.0.0', task: 'x' }, deps)).persona).toBe('Head');
  });

  it('flag on: a user agent is served like a pack agent since P5 gave it revisions', async () => {
    process.env.OPENWOP_AGENT_VERSIONS = 'on';
    const r = getAgentRegistry();
    r._resetForTest();
    r.register(manifest('2', 'User head', 't'));
    r.registerVersion(manifest('1', 'User stable', 't'));
    serving = '1';
    expect((await resolveServedAgent(AGENT, 't', 'k'))?.persona).toBe('User stable');
    serving = undefined;
    expect((await resolveServedAgent(AGENT, 't', 'k'))?.persona).toBe('User head');
  });
});

describe('ADR 1014 D4 — the feature: serving from rows, and drafts minted on install', () => {
  let server: http.Server;
  type Row = Record<string, unknown> & { tenant: string; agentId: string; version: string };
  let rows: { put(r: Row): Promise<void>; get(id: string): Promise<Row | null> };
  let svc: typeof import('../src/features/agent-deployments/service.js');
  let serving: typeof import('../src/host/agentServing.js');

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AGENT_DEPLOYMENT = 'on';
    const { createApp } = await import('../src/index.js');
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
    void (server.address() as AddressInfo);
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    rows = new DurableCollection<Row>('agent-deployments', (r) => `${r.tenant}::${r.agentId}::${r.version}`, undefined, (r) => r.tenant);
    svc = await import('../src/features/agent-deployments/service.js');
    serving = await import('../src/host/agentServing.js');
  }, 60_000);
  afterAll(async () => {
    delete process.env.OPENWOP_AGENT_DEPLOYMENT;
    delete process.env.OPENWOP_AGENT_VERSIONS;
    await new Promise<void>((res) => server.close(() => res()));
  });
  const row = (tenant: string, version: string, state: string, channels?: string[]): Row => {
    const now = new Date().toISOString();
    return { tenant, agentId: AGENT, version, state, ...(channels ? { channels, activatedAt: now } : {}), revision: 1, updatedAt: now };
  };

  it('no rows → undefined (the head); stable active → that version; rows but nothing on stable → null', async () => {
    process.env.OPENWOP_AGENT_VERSIONS = 'on';
    try {
      expect(await serving.servingVersion('t-none', AGENT, 'k')).toBeUndefined();
      await rows.put(row('t-stable', '1.0.0', 'active', ['stable']));
      await rows.put(row('t-stable', '2.0.0', 'draft'));
      expect(await serving.servingVersion('t-stable', AGENT, 'k')).toBe('1.0.0');
      await rows.put(row('t-paused', '1.0.0', 'paused', ['stable']));
      expect(await serving.servingVersion('t-paused', AGENT, 'k')).toBeNull();
    } finally {
      delete process.env.OPENWOP_AGENT_VERSIONS;
    }
  });

  it('an installed version is minted as a draft only where the agent is deployed, once', async () => {
    await rows.put(row('t-deploys', '1.0.0', 'active', ['stable']));
    const minted = await svc.mintInstalledDrafts([AGENT, 'core.conformance.channel-agent'], '3.0.0');
    expect(minted).toBeGreaterThanOrEqual(1);
    expect((await rows.get(`t-deploys::${AGENT}::3.0.0`))?.state).toBe('draft');
    expect(await rows.get(`t-none::${AGENT}::3.0.0`)).toBeNull();
    expect(await svc.mintInstalledDrafts([AGENT], '3.0.0'), 'idempotent').toBe(0);
  });
});

describe('ADR 1014 D4 — the ratchet: every execution site reads through resolveServedAgent', () => {
  /** Files that read an agent manifest from the registry for METADATA only (identity,
   *  listing, membership, provenance, allowlist editing) or are the mechanism itself.
   *  Adding a file here is a review moment: if it EXECUTES the agent's prompt, it must
   *  call `resolveServedAgent` instead. */
  const METADATA_OR_MECHANISM = new Set([
    'features/agent-deployments/feature.ts',
    'features/agent-deployments/prefetch.ts',
    'features/campaign-ops/agentBindingService.ts',
    'features/campaign-ops/teamService.ts',
    'features/channels/feature.ts',
    'features/chat-widget/routes.ts', // ADR 1018: save-time check that the bound agent exists; the gateway serves it
    'features/connections/providerRegistry.ts',
    'features/kicktodo-core/agentTools.ts',
    'features/kicktodo-creator/challengeAuthorService.ts',
    'host/agentDispatch.ts',
    'host/agentIdentity.ts',
    'host/agentServing.ts',
    'host/agentChannelPin.ts', // ADR 1014 M6: the mechanism; it records the served version, the dispatch runs it
    'host/agentVisibility.ts',
    'host/evals/createEvalRun.ts', // ADR 1014 D5: checks a named version exists; the eval runs through the dispatcher
    'routes/agentAllowlists.ts',
    'routes/agents.ts',
    'routes/userAgents.ts',
  ]);
  const SERVED_SITES = ['host/chatContext.ts', 'features/voice/realtime/toolBridge.ts', 'features/chat-widget/publicGateway.ts', 'bootstrap/nodes.ts'];
  const SRC = join(__dirname, '..', 'src');
  const walk = (d: string): string[] => readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

  it('no file outside the list reads an agent from the registry directly', () => {
    const offenders = walk(SRC)
      .filter((p) => /getAgentRegistry\(\)\.(get|resolve)\(/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p))
      .filter((p) => !METADATA_OR_MECHANISM.has(p));
    expect(offenders).toEqual([]);
  });

  it('every known execution site reads through resolveServedAgent', () => {
    for (const site of SERVED_SITES) expect(readFileSync(join(SRC, site), 'utf8'), site).toMatch(/resolveServedAgent(Detailed)?\(/);
  });
});
