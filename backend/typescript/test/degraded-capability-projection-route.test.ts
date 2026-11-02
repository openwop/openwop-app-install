/**
 * W-2 / RFC 0092 §B — the `agent-capability-degraded-projection` behavioral
 * contract over HTTP. Boots the real app with OPENWOP_DEGRADED_CAPABILITY_AGENT_ID
 * set, then asserts on GET /v1/agents (the canonical RFC 0072 §C `degraded[]`):
 *   - the named agent surfaces its unmet requiresCapabilities key in `degraded[]`
 *   - `degraded[]` (when present) is unique, non-empty strings
 *   - every degraded key is one the agent's requiresCapabilities actually names
 *     (the §B iff-contract)
 *   - an all-met agent omits the field
 * Black-box, no seam — mirrors the steward-authored openwop scenario so the
 * reference host passes it non-vacuously. Uses canonical `degraded[]` (NOT
 * `degradedCapabilities[]`).
 *
 * TST-CUC-4. The all-met leg uses a test agent whose `requiresCapabilities` names a
 * key the host DOES advertise (read from the host-surface registry, not from the
 * projection under test) — an agent with no requirements cannot tell "omitted
 * because met" from "nothing to check". Red when unmet keys are not projected,
 * when a met key is projected as degraded, or when an empty set is emitted as [].
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { listHostSurfaces } from '../src/bootstrap/hostSurfaceRegistry.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const DEGRADED_AGENT = 'core.openwop.demo.degraded';
const ALL_MET_AGENT = 'core.openwop.demo.all-met';
let MET_KEY = '';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Names + triggers the degraded-demo agent (registered at registerAgentRoutes).
  process.env.OPENWOP_DEGRADED_CAPABILITY_AGENT_ID = DEGRADED_AGENT;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const supported = listHostSurfaces().filter((s) => s.supported).map((s) => s.name);
  if (supported.length === 0) throw new Error('host advertises no surfaces — the all-met leg needs one');
  MET_KEY = supported[0]!;
  getAgentRegistry().register({
    agentId: ALL_MET_AGENT,
    persona: 'All-met Capability Demo',
    modelClass: 'general',
    systemPrompt: 'Test agent whose only required capability is advertised.',
    packName: 'core.openwop.demo',
    packVersion: '0',
    toolAllowlist: [],
    confidence: { defaultThreshold: 0.5 },
    requiresCapabilities: [MET_KEY],
  });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_DEGRADED_CAPABILITY_AGENT_ID;
});

interface Entry { agentId: string; degraded?: string[] }

describe('RFC 0092 §B — agent-capability-degraded projection', () => {
  it('surfaces the unmet key in the named agent\'s degraded[] (non-vacuous)', async () => {
    const list = await (await fetch(`${BASE}/agents`, { headers: H })).json() as { agents: Entry[] };
    const agent = list.agents.find((a) => a.agentId === DEGRADED_AGENT);
    expect(agent).toBeDefined();
    expect(Array.isArray(agent!.degraded)).toBe(true);
    expect(agent!.degraded!.length).toBeGreaterThan(0);
    // every degraded key is unique + non-empty
    const d = agent!.degraded!;
    expect(new Set(d).size).toBe(d.length);
    expect(d.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
  });

  it('every degraded key is a capability the host does NOT advertise', async () => {
    // The single demo key is a synthetic vendor capability no host surface provides.
    const one = await (await fetch(`${BASE}/agents/${encodeURIComponent(DEGRADED_AGENT)}`, { headers: H })).json() as Entry;
    expect(one.degraded).toEqual(['vendor.demo.unmet-capability']);
    // §B iff: every degraded key is one the agent's requiresCapabilities names
    // (the wire entry does not carry requiresCapabilities; read the registered manifest)
    const required = getAgentRegistry().get(DEGRADED_AGENT)?.requiresCapabilities ?? [];
    for (const k of one.degraded ?? []) expect(required).toContain(k);
  });

  it('an all-met agent omits degraded[] (§B iff-contract)', async () => {
    const list = await (await fetch(`${BASE}/agents`, { headers: H })).json() as { agents: Entry[] };
    const allMet = list.agents.find((a) => a.agentId === ALL_MET_AGENT);
    expect(allMet, 'the all-met test agent is listed').toBeDefined();
    expect(getAgentRegistry().get(ALL_MET_AGENT)?.requiresCapabilities).toEqual([MET_KEY]);
    // requirements present AND all advertised ⇒ the field is OMITTED (not [], not [key])
    expect('degraded' in allMet!).toBe(false);
  });
});
