/**
 * ADR 1014 P4 (D5) — an eval that names the version it tests is evidence for that
 * version only.
 *
 * Driven through the real deployments service against the reserved scripted
 * agent, whose fixed policy requires an eval to promote. Eval runs are seeded as
 * completed, passed agent evals.
 *
 * Red when: a passed eval that NAMED another version, or one the deployment SERVED
 * another version to (M6), promotes this one; or an eval
 * that named no version stops promoting (that is the certified conformance path,
 * `v2-deployment-eval-gate`, which cites an un-versioned eval).
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SUITE_KIND } from '../src/host/evals/agentEvalRun.js';

const SCRIPTED = 'core.conformance.agents.scripted';
let server: http.Server;
let svc: typeof import('../src/features/agent-deployments/service.js');
let storage: import('../src/storage/storage.js').Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AGENT_DEPLOYMENT = 'on';
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  svc = await import('../src/features/agent-deployments/service.js');
  storage = (await import('../src/host/hostExtPersistence.js')).hostExtStorage();
}, 60_000);
afterAll(async () => {
  delete process.env.OPENWOP_AGENT_DEPLOYMENT;
  await new Promise<void>((res) => server.close(() => res()));
});

async function passedEval(tenant: string, version?: string, how: 'agentVersionPinned' | 'agentVersionServed' = 'agentVersionPinned'): Promise<string> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  await storage.insertRun({
    runId, workflowId: 'eval.test', tenantId: tenant, status: 'completed', inputs: {}, configurable: {}, createdAt: now, updatedAt: now,
    metadata: {
      eval: { kind: AGENT_SUITE_KIND, agentId: SCRIPTED, suiteRef: 's', suiteSource: 'fixture', rfc0244Wire: false, ...(version ? { agentVersion: version, [how]: true } : {}) },
      evalSummary: { passed: true },
    },
  });
  return runId;
}

const promote = (tenant: string, evalRunId: string) =>
  svc.applyTransition(tenant, SCRIPTED, { version: '1.0.0', transition: 'promote', evalRunId }, { storage, principal: 'test' });

describe('ADR 1014 D5 — the eval gate holds a versioned eval to its version', () => {
  it('an eval that named 9.9.9 cannot promote 1.0.0', async () => {
    const tenant = `t-${randomUUID()}`;
    await svc.listDeployments(tenant, SCRIPTED); // seeds 1.0.0 draft
    const err = await promote(tenant, await passedEval(tenant, '9.9.9')).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('eval_gate_unmet');
    expect((err as { details?: { reason?: string } }).details?.reason).toBe('eval_of_another_version');
  });

  it('an eval the deployment served 9.9.9 to cannot promote 1.0.0 (M6)', async () => {
    const tenant = `t-${randomUUID()}`;
    await svc.listDeployments(tenant, SCRIPTED);
    const err = await promote(tenant, await passedEval(tenant, '9.9.9', 'agentVersionServed')).catch((e: unknown) => e);
    expect((err as { details?: { reason?: string } }).details?.reason).toBe('eval_of_another_version');
  });

  it('an eval that named 1.0.0 promotes 1.0.0', async () => {
    const tenant = `t-${randomUUID()}`;
    await svc.listDeployments(tenant, SCRIPTED);
    const out = await promote(tenant, await passedEval(tenant, '1.0.0'));
    expect(out.record.state).toBe('test');
  });

  it('an eval that named no version still promotes (the certified conformance path)', async () => {
    const tenant = `t-${randomUUID()}`;
    await svc.listDeployments(tenant, SCRIPTED);
    const out = await promote(tenant, await passedEval(tenant));
    expect(out.record.state).toBe('test');
  });
});
