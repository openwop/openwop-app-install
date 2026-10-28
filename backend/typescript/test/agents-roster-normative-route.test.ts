import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Ajv2020 from 'ajv/dist/2020.js';

import { createApp } from '../src/index.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { corpusSchema } from './support/corpusSchema.js';

/**
 * RFC 0086 (Accepted) / `agent-roster.md` §B — a host advertising
 * `agents.roster.supported` MUST serve `GET /agents/roster`.
 *
 * THE DEFECT THIS PINS: discovery advertised the capability, but the route was
 * never registered — `/agents/roster` fell into `/agents/:agentId` and answered
 * `404 "agent 'roster' is not installed on this host"` in production. Suite
 * 2.42.3+ caught it once its leg stopped being unfailable. The first assertion is
 * therefore the status code: a shadowed route is the regression to catch.
 *
 * TST-BNA-2. Red when: the route is not registered at `/agents/roster`, an
 * advisor entry is projected, or a host-ext field (e.g. `autonomyLevel`) leaks
 * onto the normative entry (also a closed-world schema violation).
 */
let server: Server;
let base: string;
let savedKeys: string | undefined;
const KEY_A = 'k-roster-a';
const KEY_B = 'k-roster-b';
// ADR 0812 P3c-0 — major 2 only; the major-1 leg went with major 1.
const hdr = (key: string) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2' });

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
  const created = await fetch(`${base}/host/openwop-app/roster`, {
    method: 'POST', headers: hdr(KEY_A),
    body: JSON.stringify({ persona: 'Ops Lead', agentRef: { agentId: 'core.openwop.agent-examples.chat' }, workflows: ['conformance-noop'], autonomyLevel: 'review' }),
  });
  if (created.status !== 201 && created.status !== 200) throw new Error(`roster create answered ${created.status}: ${await created.text()}`);
  await createRosterEntry({ tenantId: 'roster-tenant-a', persona: 'Ada Lovelace', agentRef: { agentId: 'core.openwop.agent-examples.chat' }, roleKey: 'advisor' });
  // Tenant B: its own member, which tenant A must never see.
  await createRosterEntry({ tenantId: 'roster-tenant-b', persona: 'Other Tenant Agent', agentRef: { agentId: 'core.openwop.agent-examples.chat' } });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (savedKeys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = savedKeys;
});

async function roster(key: string) {
  const res = await fetch(`${base}/agents/roster`, { headers: hdr(key) });
  return { status: res.status, body: await res.json() as { roster?: Array<Record<string, unknown>>; total?: number; error?: string } };
}

describe('GET /agents/roster — the normative roster read (RFC 0086 §B)', () => {
  it('is SERVED (not shadowed by /agents/:agentId)', async () => {
    const r = await roster(KEY_A);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.error, 'must not be the :agentId "not installed" miss').toBeUndefined();
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
    const res = await fetch(`${base}/agents/core.openwop.agent-examples.chat`, { headers: hdr(KEY_A) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agentId?: string }).agentId).toBe('core.openwop.agent-examples.chat');
  });
});
