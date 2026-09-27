/**
 * runAccess gates — the cross-tenant IDOR remediation (2026-07 vuln-scan).
 *
 * loadReadableRun (READ) enforces tenant ownership but HONORS a valid ?streamToken
 * capability (SSE read). loadOwnedRun (MUTATION / capability-token-yielding) enforces
 * ownership and must NOT honor streamToken — a read grant may never authorize a
 * cancel/fork/resume or hand out RFC 0093 resume tokens. Both 404 a non-owned run
 * (no existence leak); both let the wildcard operator principal act cross-tenant.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Request } from 'express';
import { loadReadableRun, loadOwnedRun } from '../runAccess.js';
import { mintRunStreamToken } from '../runStreamToken.js';
import { OpenwopError, type RunRecord } from '../../types.js';
import { openStorage } from '../../storage/index.js';
import type { Storage } from '../../storage/storage.js';

const RUN_ID = 'run-ownergate-1';
const OWNER = 'tenant-owner';
const OTHER = 'tenant-other';

let storage: Storage;

function makeRun(): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: RUN_ID,
    workflowId: 'wf-x',
    tenantId: OWNER,
    status: 'running',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** Minimal Request stand-in — the gates only read query/principal/tenantId. */
function req(opts: { tenantId?: string; wildcard?: boolean; streamToken?: string }): Request {
  return {
    query: opts.streamToken ? { streamToken: opts.streamToken } : {},
    principal: { principalId: 'p', tenants: opts.wildcard ? ['*'] : [opts.tenantId ?? OWNER], token: '' },
    tenantId: opts.tenantId ?? OWNER,
  } as unknown as Request;
}

async function expectNotFound(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: 'run_not_found' });
  await expect(p).rejects.toBeInstanceOf(OpenwopError);
}

beforeAll(async () => {
  storage = await openStorage('memory://');
  await storage.insertRun(makeRun());
});

describe('loadReadableRun (read gate)', () => {
  it('returns the run for the owning tenant', async () => {
    const run = await loadReadableRun(req({ tenantId: OWNER }), storage, RUN_ID);
    expect(run.runId).toBe(RUN_ID);
  });
  it('404s a cross-tenant caller (no existence leak)', async () => {
    await expectNotFound(loadReadableRun(req({ tenantId: OTHER }), storage, RUN_ID));
  });
  it('lets the wildcard operator read cross-tenant', async () => {
    const run = await loadReadableRun(req({ tenantId: OTHER, wildcard: true }), storage, RUN_ID);
    expect(run.runId).toBe(RUN_ID);
  });
  it('HONORS a valid streamToken for a cross-tenant read (SSE capability)', async () => {
    const token = mintRunStreamToken(RUN_ID);
    const run = await loadReadableRun(req({ tenantId: OTHER, streamToken: token }), storage, RUN_ID);
    expect(run.runId).toBe(RUN_ID);
  });
});

describe('loadOwnedRun (mutation gate)', () => {
  it('returns the run for the owning tenant', async () => {
    const run = await loadOwnedRun(req({ tenantId: OWNER }), storage, RUN_ID, 'runs:cancel');
    expect(run.runId).toBe(RUN_ID);
  });
  it('404s a cross-tenant caller', async () => {
    await expectNotFound(loadOwnedRun(req({ tenantId: OTHER }), storage, RUN_ID, 'runs:cancel'));
  });
  it('lets the wildcard operator mutate cross-tenant', async () => {
    const run = await loadOwnedRun(req({ tenantId: OTHER, wildcard: true }), storage, RUN_ID, 'runs:cancel');
    expect(run.runId).toBe(RUN_ID);
  });
  it('does NOT honor a streamToken for a mutation (read grant must not authorize a write)', async () => {
    const token = mintRunStreamToken(RUN_ID);
    await expectNotFound(loadOwnedRun(req({ tenantId: OTHER, streamToken: token }), storage, RUN_ID, 'runs:cancel'));
  });
  it('404s an absent run', async () => {
    await expectNotFound(loadOwnedRun(req({ tenantId: OWNER }), storage, 'no-such-run', 'runs:read'));
  });
});
