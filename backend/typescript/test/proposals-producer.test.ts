/**
 * chat-first-port D5 — the ONE real proposals producer (RFC 0096, ADR 0938 A7).
 *
 * An ACCEPTED ambient-work-graph pattern (a recurring tool sequence a person
 * with workspace:write accepted for automation) mints a durable, INERT
 * `workflow-chain-pack` draft whose artifact is the tool-name skeleton plus its
 * occurrence count (NOT an RFC 0013 manifest — PROP2WF-9; nothing installs it).
 * Covers:
 *   - the producer's exact shape + provenance, read back from the store;
 *   - deterministic dedup: the id is derived from the suggestionId AND a
 *     re-accept returns the existing row (two copies — the `getProposal`
 *     pre-check and the insert-only CAS; 8fw5g6-prod-upsert-clobbers replaces
 *     the pre-check with an upsert, 8fw5g6-prod-id-nondeterministic breaks the id);
 *   - the AWG accept route → proposal wiring end to end, including the owner
 *     principal the erasure eraser relies on (`proposals-erasure.test.ts`).
 * Each case owns its tenant (shuffle-safe; cases 2 and 3 used to read the row
 * case 1 wrote, and the end-to-end case wrote into case 1's tenant).
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
  getProposal,
} from '../src/features/proposals/proposalsService.js';
import { upsertSuggestion } from '../src/features/ambient-work-graph/suggestionStore.js';
import { suggestionIdFor } from '../src/features/ambient-work-graph/runSignature.js';
import { opaquePrincipal } from '../src/host/runOwner.js';

const T_MINT = 'proposals-producer-mint';
const T_DEDUP = 'proposals-producer-dedup';
const T_E2E = 'proposals-producer-e2e';

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
    const p = await createProposalFromAcceptedPattern(T_MINT, pattern, 'u-1');
    expect(p.id).toBe('wg:sug-abc');
    const stored = await getProposal(T_MINT, 'wg:sug-abc'); // persisted, not just returned
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('workflow-chain-pack');
    expect(stored!.state).toBe('draft');
    expect(stored!.artifact).toEqual({ toolSequence: ['a', 'b', 'c'], occurrences: 4, sampleGoal: 'Draft the weekly report' });
    expect(stored!.provenance.sourceRunIds).toEqual(['r1', 'r2']); // the accepted pattern's evidence runs
    expect(stored!.owner).toEqual({ tenant: T_MINT, principal: 'u-1' });
    expect(stored!.activation).toBeUndefined(); // inert
    expect((await listProposals(T_MINT, { kind: 'workflow-chain-pack' })).map((x) => x.id)).toEqual(['wg:sug-abc']);
  });

  it('is deterministically idempotent — re-accepting never spams a second proposal, and preserves a revise', async () => {
    await createProposalFromAcceptedPattern(T_DEDUP, pattern, 'u-1');
    // The workspace revises the draft; a re-accept must NOT clobber it.
    const revised = await reviseProposal((await getProposal(T_DEDUP, 'wg:sug-abc'))!, { title: 'My renamed workflow' });
    expect(revised.state).toBe('revised');

    const again = await createProposalFromAcceptedPattern(T_DEDUP, pattern, 'u-1');
    expect(again.id).toBe('wg:sug-abc');
    expect(again.state).toBe('revised'); // untouched — returned the existing row
    expect(again.title).toBe('My renamed workflow');
    expect(again.revision).toBe(1);
    const stored = await getProposal(T_DEDUP, 'wg:sug-abc');
    expect(stored?.state).toBe('revised');
    expect(stored?.title).toBe('My renamed workflow');
    expect((await listProposals(T_DEDUP, { kind: 'workflow-chain-pack' })).map((x) => x.id)).toEqual(['wg:sug-abc']); // still exactly one
  });

  it('is tenant-scoped — another tenant does not see it', async () => {
    // Twin of proposals-service.test.ts › "listProposals returns only the tenant slice"
    // for the PRODUCER's write: it mints its own row (it used to rely on case 1's).
    const here = 'proposals-producer-scope-here';
    const there = 'proposals-producer-scope-there';
    await createProposalFromAcceptedPattern(here, { ...pattern, suggestionId: 'sug-scope' }, 'u-2');
    expect((await listProposals(here, { kind: 'workflow-chain-pack' })).map((x) => x.id)).toEqual(['wg:sug-scope']); // positive control
    expect(await listProposals(there, { kind: 'workflow-chain-pack' })).toEqual([]);
    expect(await getProposal(there, 'wg:sug-scope')).toBeNull();
  });
});

describe('D5 — accepting an ambient-work-graph suggestion produces a proposal (end to end)', () => {
  interface AcceptBody { proposalId?: string; draftSeed?: { name: string; toolSequence: string[] } }
  interface ProposalsBody { proposals: Array<{ id: string; kind: string; state: string; provenance: { sourceRunIds: string[] }; owner: { tenant: string; principal?: string } }> }
  interface LoginBody { user: { userId: string } }
  interface OrgBody { orgId: string }
  function client() {
    let cookie = '';
    return async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
      return { status: res.status, body: (await res.json()) as T };
    };
  }
  const enable = async (id: string): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };

  it('accept → the response carries a proposalId and GET /proposals shows the workflow-chain-pack draft', async () => {
    await enable('users'); await enable('orgs');
    const c = client();
    const who = await c<LoginBody>('POST', '/host/openwop-app/test/login', { email: 'd5-owner@test.dev', tenantId: T_E2E });
    // ADR 0930 D1 — a suggestion is its owner's; this caller's key is the opaque
    // principal of their session subject (`ownership.ts` `callerOwnerKey`).
    const ownerPrincipal = opaquePrincipal(who.body.user.userId);
    const org = await c<OrgBody>('POST', '/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId;

    // Seed a recurring pattern the human is about to accept.
    const signature = 'search|draft|send';
    const suggestionId = suggestionIdFor(T_E2E, ownerPrincipal, signature);
    await upsertSuggestion({
      suggestionId, tenantId: T_E2E, ownerPrincipal, signature,
      toolSequence: ['search', 'draft', 'send'], count: 3, exampleRunIds: ['run-1', 'run-2', 'run-3'],
      sampleGoal: 'Answer a support ticket', status: 'suggested',
      firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    });

    const accept = await c<AcceptBody>('POST', `/host/openwop-app/work-graph/orgs/${encodeURIComponent(orgId)}/suggestions/${suggestionId}/accept`);
    expect(accept.status).toBe(200);
    expect(accept.body.proposalId).toBe(`wg:${suggestionId}`);
    expect(accept.body.draftSeed?.name).toBe('Answer a support ticket'); // the existing FE lane is untouched

    const proposals = await c<ProposalsBody>('GET', '/host/openwop-app/proposals?kind=workflow-chain-pack');
    expect(proposals.status).toBe(200);
    const mine = proposals.body.proposals.find((p) => p.id === `wg:${suggestionId}`);
    expect(mine).toBeDefined();
    expect(mine?.kind).toBe('workflow-chain-pack');
    expect(mine?.state).toBe('draft');
    expect(mine?.provenance.sourceRunIds).toEqual(['run-1', 'run-2', 'run-3']);
    // The route passes the session's userId as owner.principal — the key a DSAR erases.
    expect(mine?.owner).toEqual({ tenant: T_E2E, principal: who.body.user.userId });
  });
});
