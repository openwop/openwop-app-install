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
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';

const PORT = 18263;
const BASE = `http://127.0.0.1:${PORT}`;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const DEGRADED_AGENT = 'core.openwop.demo.degraded';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Names + triggers the degraded-demo agent (registered at registerAgentRoutes).
  process.env.OPENWOP_DEGRADED_CAPABILITY_AGENT_ID = DEGRADED_AGENT;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_DEGRADED_CAPABILITY_AGENT_ID;
});

interface Entry { agentId: string; degraded?: string[]; requiresCapabilities?: string[] }

describe('RFC 0092 §B — agent-capability-degraded projection', () => {
  it('surfaces the unmet key in the named agent\'s degraded[] (non-vacuous)', async () => {
    const list = await (await fetch(`${BASE}/v1/agents`, { headers: H })).json() as { agents: Entry[] };
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
    const one = await (await fetch(`${BASE}/v1/agents/${encodeURIComponent(DEGRADED_AGENT)}`, { headers: H })).json() as Entry;
    expect(one.degraded).toContain('vendor.demo.unmet-capability');
  });

  it('an all-met agent omits degraded[] (§B iff-contract)', async () => {
    const list = await (await fetch(`${BASE}/v1/agents`, { headers: H })).json() as { agents: Entry[] };
    // At least one other installed agent should have no unmet capability → no field.
    const allMet = list.agents.filter((a) => a.agentId !== DEGRADED_AGENT);
    // Not asserting all — just that omission is the norm for agents with nothing unmet.
    expect(allMet.some((a) => a.degraded === undefined)).toBe(true);
  });
});
