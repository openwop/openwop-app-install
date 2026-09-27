/**
 * chat-first-port D5 — the ONE real proposals producer (RFC 0096).
 *
 * Before this, `openwop:proposals.list` told the model to "check proposals before
 * proposing again" but NOTHING ever created one (only a demo seed) — the
 * instruction was vacuous. Now an ACCEPTED ambient-work-graph pattern (a recurring
 * tool sequence a human with workspace:write explicitly accepted for automation)
 * mints a durable `workflow-chain-pack` proposal. This covers:
 *   - the producer's shape + provenance + deterministic dedup (service level);
 *   - the end-to-end wiring through the ambient-work-graph accept route.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  createProposalFromAcceptedPattern,
  reviseProposal,
  listProposals,
} from '../src/features/proposals/proposalsService.js';
import { upsertSuggestion } from '../src/features/ambient-work-graph/suggestionStore.js';
import { suggestionIdFor } from '../src/features/ambient-work-graph/runSignature.js';

const T = 'proposals-producer';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('D5 — createProposalFromAcceptedPattern (the producer)', () => {
  const pattern = { suggestionId: 'sug-abc', toolSequence: ['a', 'b', 'c'], count: 4, exampleRunIds: ['r1', 'r2'], sampleGoal: 'Draft the weekly report' };

  it('mints a workflow-chain-pack draft carrying the pattern + its run provenance', async () => {
    const p = await createProposalFromAcceptedPattern(T, pattern, 'u-1');
    expect(p.kind).toBe('workflow-chain-pack');
    expect(p.state).toBe('draft');
    expect(p.id).toBe('wg:sug-abc');
    expect(p.artifact).toMatchObject({ toolSequence: ['a', 'b', 'c'], occurrences: 4 });
    expect(p.provenance.sourceRunIds).toEqual(['r1', 'r2']); // the accepted pattern's evidence runs
    expect(p.owner).toMatchObject({ tenant: T, principal: 'u-1' });
    expect(await listProposals(T, { kind: 'workflow-chain-pack' })).toHaveLength(1);
  });

  it('is deterministically idempotent — re-accepting never spams a second proposal, and preserves a revise', async () => {
    // The workspace revises the draft; a re-accept must NOT clobber it.
    const revised = await reviseProposal(T, 'wg:sug-abc', { title: 'My renamed workflow' });
    expect(revised?.state).toBe('revised');

    const again = await createProposalFromAcceptedPattern(T, pattern, 'u-1');
    expect(again.id).toBe('wg:sug-abc');
    expect(again.state).toBe('revised'); // untouched — returned the existing row
    expect(again.title).toBe('My renamed workflow');
    expect(await listProposals(T, { kind: 'workflow-chain-pack' })).toHaveLength(1); // still exactly one
  });

  it('is tenant-scoped — another tenant does not see it', async () => {
    expect(await listProposals('some-other-tenant', { kind: 'workflow-chain-pack' })).toHaveLength(0);
  });
});

describe('D5 — accepting an ambient-work-graph suggestion produces a proposal (end to end)', () => {
  function client() {
    let cookie = '';
    return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
      return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
    };
  }
  const enable = async (id: string): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };

  it('accept → the response carries a proposalId and GET /proposals shows the workflow-chain-pack draft', async () => {
    await enable('users'); await enable('orgs');
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'd5-owner@test.dev', tenantId: T });
    const org = await c('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId;

    // Seed a recurring pattern the human is about to accept.
    const signature = 'search|draft|send';
    const suggestionId = suggestionIdFor(T, signature);
    await upsertSuggestion({
      suggestionId, tenantId: T, signature,
      toolSequence: ['search', 'draft', 'send'], count: 3, exampleRunIds: ['run-1', 'run-2', 'run-3'],
      sampleGoal: 'Answer a support ticket', status: 'suggested',
      firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    });

    const accept = await c('POST', `/v1/host/openwop-app/work-graph/orgs/${encodeURIComponent(orgId)}/suggestions/${suggestionId}/accept`);
    expect(accept.status).toBe(200);
    expect(accept.body.proposalId).toBe(`wg:${suggestionId}`);
    expect(accept.body.draftSeed).toBeTruthy(); // the existing FE lane is untouched

    const proposals = await c('GET', '/v1/host/openwop-app/proposals?kind=workflow-chain-pack');
    expect(proposals.status).toBe(200);
    const mine = (proposals.body.proposals as { id: string; kind: string; provenance: { sourceRunIds: string[] } }[]).find((p) => p.id === `wg:${suggestionId}`);
    expect(mine).toBeTruthy();
    expect(mine?.kind).toBe('workflow-chain-pack');
    expect(mine?.provenance.sourceRunIds).toEqual(['run-1', 'run-2', 'run-3']);
  });
});
