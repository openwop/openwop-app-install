/**
 * ADR 1099 D5 (user decision 2026-11-25) — the Project Guide is not offered to
 * the firm's members.
 *
 * Its only tool is a client tool, which resolves only in a collaborator turn, so
 * in a member's chat it would be an agent with no tools whose prompt names one.
 *
 *  - `GET /agents` (the member inventory the chat picker reads) leaves it out;
 *  - it is still installed: `GET /agents/:id` resolves it, and so does the
 *    collaborator turn's `resolveServedAgent`;
 *  - the A2A surface does not list it (`a2aExposed: false` in its pack);
 *  - the rule is "every allowlisted tool is a client tool", nothing looser.
 *
 * Sabotage notes: dropping `!isCollaboratorOnlyAgent(a)` from `listVisibleAgents`
 * reds the first case; removing `a2aExposed: false` from the pack reds the third.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { isCollaboratorOnlyAgent } from '../src/host/agentVisibility.js';
import { a2aListedAgents } from '../src/host/a2aCard.js';
import { resolveServedAgent } from '../src/host/agentServing.js';
import { PROJECT_CLIENT_AGENT_ID } from '../src/features/projects/clientPortal.js';

const TENANT = 'adr1099-hide-tenant';
const KEY = 'adr1099-hide-key-0123456789abcdef';
let server: http.Server;
let ORIGIN = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_API_KEYS = `${KEY}:${TENANT}`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${KEY}`, 'openwop-version': '2' } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('ADR 1099 — the Project Guide is not offered to members', () => {
  it('GET /agents leaves it out, while other pack agents are listed', async () => {
    const r = await get('/agents');
    expect(r.status).toBe(200);
    const ids = (r.body.agents as Array<{ agentId: string }>).map((a) => a.agentId);
    expect(ids.length).toBeGreaterThan(50); // non-vacuous: the pack corpus is listed
    expect(ids).not.toContain(PROJECT_CLIENT_AGENT_ID);
  });

  it('it is still installed: resolvable by id and served to the collaborator turn', async () => {
    const r = await get(`/agents/${encodeURIComponent(PROJECT_CLIENT_AGENT_ID)}`);
    expect(r.status).toBe(200);
    expect((await resolveServedAgent(PROJECT_CLIENT_AGENT_ID, TENANT, 'test'))?.agentId).toBe(PROJECT_CLIENT_AGENT_ID);
  });

  it('the A2A surface does not list it', () => {
    expect(a2aListedAgents().map((a) => a.agentId)).not.toContain(PROJECT_CLIENT_AGENT_ID);
  });

  it('the rule is exact: every allowlisted tool is a client tool', () => {
    expect(isCollaboratorOnlyAgent({ toolAllowlist: ['openwop:client.project.overview'] })).toBe(true);
    expect(isCollaboratorOnlyAgent({ toolAllowlist: ['openwop:client.project.overview', 'openwop:projects.list'] })).toBe(false);
    expect(isCollaboratorOnlyAgent({ toolAllowlist: [] })).toBe(false);
    expect(isCollaboratorOnlyAgent({})).toBe(false);
  });
});
