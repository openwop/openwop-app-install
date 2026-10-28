/**
 * Reviewable-learning proposals (RFC 0096) over HTTP, through the BEARER lane.
 *
 * Why this file exists beside `proposals-r2-probes.test.ts` (cookie sessions):
 * the caller here is the `dev-token` bearer principal (`bearer:dev-toke`,
 * auth.ts) granted EDITOR in `default`, so it holds `workspace:read` +
 * `workspace:write` and NOT `packs:publish`. That makes it the only witness of
 * the apply route's `packs:publish` gate (`assertCanApply`, ADR 0736 / ADR 0938
 * D1): r2's stranger is refused earlier by the read gate and r2's admin holds
 * the scope.
 *   - apply without `packs:publish` → the exact 403 body, and NOTHING installs —
 *     a recording installer is registered for the case, so a sabotaged gate would
 *     really apply (8fw5g6-pt-apply-scope).
 *   - the list filters by state and seeds nothing (ADR 0938 D6; the seeding half
 *     twins r2 PRB-8, 8fw5g6-pt-list-seeds / -pt-state-filter-r2).
 *   - revise never activates, read back from the store (8fw5g6-pt-revise-activates).
 * Every case seeds its own row (shuffle-safe; it used to share one row that case 3
 * revised out of case 1's `?state=draft` filter).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { getProposal, putProposal, registerProposalInstaller, __test, type ProposalView } from '../src/features/proposals/proposalsService.js';
import type { Proposal, ProposalState } from '../src/features/proposals/types.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  // ADR 0736 — revise/reject/archive now require `workspace:write`. The bearer
  // caller resolves to `bearer:dev-toke` (auth.ts:920) in the `default` tenant, so
  // it is granted EDITOR here: that confers `workspace:write` and NOT
  // `packs:publish`, which keeps BOTH tests meaningful — revise proceeds, and the
  // apply test still 403s for its own stated reason (the pack-publish class), not
  // because the caller is anonymous.
  await createMember({
    orgId: 'default', tenantId: 'default', displayName: 'Dev bearer',
    subject: 'bearer:dev-toke', roles: ['editor'],
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}

interface ErrBody { error: string; message: string; details?: Record<string, unknown> }

let n = 0;
/** Each case seeds its OWN row in `default` (the bearer caller's tenant). */
async function seed(state: ProposalState): Promise<string> {
  const id = `pt-${state}-${n++}`;
  const row: Proposal = {
    id, kind: 'prompt-template', state,
    artifact: { template: 'Summarize {{week}}.', variables: ['week'] },
    provenance: { sourceRunIds: ['r1'] }, duplicateOf: null,
    owner: { tenant: 'default' }, createdAt: new Date().toISOString(),
  };
  await putProposal(row);
  return id;
}

describe('proposals — reviewable-learning seam (RFC 0096)', () => {
  it('GET /proposals lists the tenant\'s drafts and seeds nothing (ADR 0938 D6)', async () => {
    const draftId = await seed('draft');
    const rejectedId = await seed('rejected');
    const { status, body } = await api<{ proposals: ProposalView[] }>('/host/openwop-app/proposals?state=draft');
    expect(status).toBe(200);
    const ids = body.proposals.map((p) => p.id);
    expect(ids).toContain(draftId);
    expect(ids, 'the state filter must exclude a non-draft row').not.toContain(rejectedId);
    expect(body.proposals.every((p) => p.state === 'draft')).toBe(true);
    // Seeds nothing: the unfiltered list holds exactly the rows this file wrote.
    const all = await api<{ proposals: ProposalView[] }>('/host/openwop-app/proposals');
    expect(all.body.proposals.every((p) => p.id.startsWith('pt-')), JSON.stringify(all.body.proposals.map((p) => p.id))).toBe(true);
  });

  it('apply without the packs:publish scope is denied 403 and installs nothing', async () => {
    const id = await seed('draft');
    const seen = await api<ProposalView>(`/host/openwop-app/proposals/${id}`);
    expect(seen.status).toBe(200);
    let installs = 0;
    registerProposalInstaller('prompt-template', { async install() { installs += 1; return { installedArtifactRef: 'tmpl:should-not-happen' }; } });
    try {
      // A valid binding, so a removed scope gate would reach the installer and apply.
      const res = await api<ErrBody>(`/host/openwop-app/proposals/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ revision: seen.body.revision, artifactDigest: seen.body.artifactDigest }),
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        error: 'forbidden_scope',
        message: 'Applying a proposal requires the `packs:publish` scope.',
        details: { requiredScope: 'packs:publish' },
      });
    } finally {
      __test.installers.clear();
    }
    expect(installs).toBe(0);
    const stored = await getProposal('default', id);
    expect(stored?.state).toBe('draft');
    expect(stored?.activation).toBeUndefined();
  });

  it('revise MUST NOT activate (no state→applied)', async () => {
    const id = await seed('draft');
    const res = await api<ProposalView>(`/host/openwop-app/proposals/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ rationale: 'sharper' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('revised');
    const stored = await getProposal('default', id);
    expect(stored?.state).toBe('revised');
    expect(stored?.rationale).toBe('sharper');
    expect(stored?.revision).toBe(1);
    expect(stored?.activation).toBeUndefined();
  });
});
