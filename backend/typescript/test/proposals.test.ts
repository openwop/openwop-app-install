/**
 * Reviewable-learning proposals (RFC 0096) — host-sample seam + invariants.
 *
 * Covers the `proposal-reviewable-learning` behavioral leg (apply without scope
 * → 403) plus the two SECURITY invariants this host upholds:
 *   - `proposal-no-resynthesis` — apply installs the stored byte image verbatim;
 *     the installed ref is a deterministic function of `artifact` and applying
 *     twice yields an identical ref (no regeneration).
 *   - malformed-for-kind → 422 (the service rejects an empty artifact).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { applyProposal, putProposal, MalformedForKindError } from '../src/features/proposals/proposalsService.js';
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
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
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

describe('proposals — reviewable-learning seam (RFC 0096)', () => {
  it('GET /proposals seeds a non-vacuous demo draft', async () => {
    const { status, body } = await api<{ proposals: Array<{ id: string; state: string }> }>(
      '/v1/host/openwop-app/proposals?state=draft',
    );
    expect(status).toBe(200);
    expect(body.proposals.length).toBeGreaterThan(0);
    expect(body.proposals.every((p) => p.state === 'draft')).toBe(true);
  });

  it('apply without the packs:publish scope is denied 403 and installs nothing', async () => {
    const list = await api<{ proposals: Array<{ id: string }> }>('/v1/host/openwop-app/proposals?state=draft');
    const id = list.body.proposals[0]!.id;
    const res = await api(`/v1/host/openwop-app/proposals/${id}/apply`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
    // Still a draft — nothing installed.
    const after = await api<{ state: string; activation?: unknown }>(`/v1/host/openwop-app/proposals/${id}`);
    expect(after.body.state).toBe('draft');
    expect(after.body.activation).toBeUndefined();
  });

  it('revise MUST NOT activate (no state→applied)', async () => {
    const list = await api<{ proposals: Array<{ id: string }> }>('/v1/host/openwop-app/proposals?state=draft');
    const id = list.body.proposals[0]!.id;
    const res = await api<{ state: string }>(`/v1/host/openwop-app/proposals/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ rationale: 'sharper' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('revised');
  });
});

describe('proposals — invariants (service-level)', () => {
  const tenant = 'test-tenant-apply';
  const base: Proposal = {
    id: 'inv-1',
    kind: 'prompt-template',
    state: 'draft',
    artifact: { template: 'Do {{x}}', variables: ['x'] },
    provenance: { sourceRunIds: ['r1'] },
    owner: { tenant },
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  };

  it('proposal-no-resynthesis: apply installs the stored bytes verbatim, deterministically', async () => {
    await putProposal({ ...base });
    const first = await applyProposal(tenant, base.id);
    expect(first).not.toBeNull();
    expect(first!.proposal.state).toBe('applied');
    // The installed ref is a pure function of the stored artifact bytes.
    expect(first!.installedArtifactRef).toBe(first!.proposal.activation?.installedArtifactRef);
    // Re-applying the same stored bytes yields an identical ref (no regeneration).
    await putProposal({ ...base }); // reset to draft
    const second = await applyProposal(tenant, base.id);
    expect(second!.installedArtifactRef).toBe(first!.installedArtifactRef);
    // The artifact itself was never mutated by apply.
    expect(second!.proposal.artifact).toEqual(base.artifact);
  });

  it('malformed-for-kind: an empty artifact is rejected', async () => {
    await putProposal({ ...base, id: 'inv-empty', artifact: {} });
    await expect(applyProposal(tenant, 'inv-empty')).rejects.toBeInstanceOf(MalformedForKindError);
  });
});
