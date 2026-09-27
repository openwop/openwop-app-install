import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Ajv2020 from 'ajv/dist/2020.js';

import { createApp } from '../src/index.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { corpusSchema } from './support/corpusSchema.js';

/**
 * RFC 0086 (Accepted) / `agent-roster.md` §B — a host advertising
 * `agents.roster.supported` MUST serve `GET /v1/agents/roster`.
 *
 * THE DEFECT THIS PINS: discovery advertised the capability, but the route was
 * never registered — `/agents/roster` fell into `/agents/:agentId` and answered
 * `404 "agent 'roster' is not installed on this host"` in production. Suite
 * 2.42.3+ caught it once its leg stopped being unfailable. The first assertion is
 * therefore the status code: a shadowed route is the regression to catch.
 */
let server: Server;
let base: string;
let savedKeys: string | undefined;
const KEY_A = 'k-roster-a';
const KEY_B = 'k-roster-b';
const hdr = (key: string, major: 1 | 2 = 1) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'OpenWOP-Version': String(major) });

beforeAll(async () => {
  savedKeys = process.env.OPENWOP_API_KEYS;
  process.env.OPENWOP_API_KEYS = `dev-token:*,${KEY_A}:roster-tenant-a,${KEY_B}:roster-tenant-b`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Tenant A: one standing member (with a host-ext autonomy field that MUST NOT
  // leak) and one advisor-subject entry that MUST NOT appear.
  const created = await fetch(`${base}/v1/host/openwop-app/roster`, {
    method: 'POST', headers: hdr(KEY_A),
    body: JSON.stringify({ persona: 'Ops Lead', agentRef: { agentId: 'core.openwop.agent-examples.chat' }, workflows: ['conformance-noop'], autonomyLevel: 'review' }),
  });
  if (created.status !== 201 && created.status !== 200) throw new Error(`roster create answered ${created.status}: ${await created.text()}`);
  await createRosterEntry({ tenantId: 'roster-tenant-a', persona: 'Ada Lovelace', agentRef: { agentId: 'core.openwop.agent-examples.chat' }, roleKey: 'advisor' } as Parameters<typeof createRosterEntry>[0]);
  // Tenant B: its own member, which tenant A must never see.
  await createRosterEntry({ tenantId: 'roster-tenant-b', persona: 'Other Tenant Agent', agentRef: { agentId: 'core.openwop.agent-examples.chat' } } as Parameters<typeof createRosterEntry>[0]);
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (savedKeys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = savedKeys;
});

async function roster(key: string, major: 1 | 2 = 1) {
  const path = major === 1 ? '/v1/agents/roster' : '/agents/roster';
  const res = await fetch(`${base}${path}`, { headers: hdr(key, major) });
  return { status: res.status, body: await res.json() as { roster?: Array<Record<string, unknown>>; total?: number; error?: string } };
}

describe('GET /v1/agents/roster — the normative roster read (RFC 0086 §B)', () => {
  it('is SERVED (not shadowed by /agents/:agentId) at both majors', async () => {
    for (const major of [1, 2] as const) {
      const r = await roster(KEY_A, major);
      expect(r.status, `major ${major}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.error, 'must not be the :agentId "not installed" miss').toBeUndefined();
    }
  });

  it('validates against the corpus agent-roster-response schema (closed-world entries)', async () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(corpusSchema('agent-roster-entry.schema.json'));
    const validate = ajv.compile(corpusSchema('agent-roster-response.schema.json'));
    const { body } = await roster(KEY_A);
    if (!validate(body)) throw new Error(`violated agent-roster-response.schema.json: ${ajv.errorsText(validate.errors)}`);
    expect(body.total).toBe(body.roster?.length);
  });

  it('carries the member, never host-ext fields, never advisors, never another tenant', async () => {
    const { body } = await roster(KEY_A);
    const personas = (body.roster ?? []).map((e) => e['persona']);
    expect(personas).toContain('Ops Lead');
    expect(personas, 'advisor-subject entries are Board-of-Advisors only').not.toContain('Ada Lovelace');
    expect(personas, 'tenant isolation').not.toContain('Other Tenant Agent');
    const member = (body.roster ?? []).find((e) => e['persona'] === 'Ops Lead')!;
    expect(member['rosterId']).toMatch(/^host:[a-z0-9][a-z0-9._-]*$/);
    expect(member['owner']).toEqual({ tenantId: 'roster-tenant-a' });
    expect(member['workflows']).toEqual(['conformance-noop']);
    for (const leaked of ['autonomyLevel', 'roleKey', 'tenantId', 'heartbeat', 'lastHeartbeatAt', 'createdAt']) {
      expect(member, `host-ext field ${leaked} must not reach the normative wire`).not.toHaveProperty(leaked);
    }
  });

  it('tenant B sees only its own roster', async () => {
    const { body } = await roster(KEY_B);
    expect((body.roster ?? []).map((e) => e['persona'])).toEqual(['Other Tenant Agent']);
  });

  it('/agents/:agentId still resolves real agents (the ordering fix did not break the id route)', async () => {
    const res = await fetch(`${base}/v1/agents/core.openwop.agent-examples.chat`, { headers: hdr(KEY_A) });
    expect(res.status).toBe(200);
  });
});
