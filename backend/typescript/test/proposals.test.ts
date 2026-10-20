/**
 * Reviewable-learning proposals (RFC 0096) — host-sample seam.
 *
 * Covers apply without scope → 403, and revise never activating. ADR 0938: the
 * list no longer seeds a demo draft (it wrote a fabricated row into every
 * workspace), so this file seeds its own row; the invariants that used to live
 * here (a hash returned as an "installed" ref) are replaced by the installer
 * tests in `proposals-service.test.ts` and the probes in
 * `proposals-r2-probes.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { putProposal } from '../src/features/proposals/proposalsService.js';
import type { Proposal } from '../src/features/proposals/types.js';

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
  const row: Proposal = {
    id: 'seeded-draft', kind: 'prompt-template', state: 'draft',
    artifact: { template: 'Summarize {{week}}.', variables: ['week'] },
    provenance: { sourceRunIds: ['r1'] }, duplicateOf: null,
    owner: { tenant: 'default' }, createdAt: new Date().toISOString(),
  };
  await putProposal(row);
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

describe('proposals — reviewable-learning seam (RFC 0096)', () => {
  it('GET /proposals lists the tenant\'s drafts and seeds nothing (ADR 0938 D6)', async () => {
    const { status, body } = await api<{ proposals: Array<{ id: string; state: string }> }>(
      '/host/openwop-app/proposals?state=draft',
    );
    expect(status).toBe(200);
    expect(body.proposals.map((p) => p.id)).toEqual(['seeded-draft']);
  });

  it('apply without the packs:publish scope is denied 403 and installs nothing', async () => {
    const list = await api<{ proposals: Array<{ id: string }> }>('/host/openwop-app/proposals?state=draft');
    const id = list.body.proposals[0]!.id;
    const res = await api(`/host/openwop-app/proposals/${id}/apply`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
    // Still a draft — nothing installed.
    const after = await api<{ state: string; activation?: unknown }>(`/host/openwop-app/proposals/${id}`);
    expect(after.body.state).toBe('draft');
    expect(after.body.activation).toBeUndefined();
  });

  it('revise MUST NOT activate (no state→applied)', async () => {
    const list = await api<{ proposals: Array<{ id: string }> }>('/host/openwop-app/proposals?state=draft');
    const id = list.body.proposals[0]!.id;
    const res = await api<{ state: string }>(`/host/openwop-app/proposals/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ rationale: 'sharper' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('revised');
  });
});
