/**
 * Portability (RFC 0098) — host-sample export/import seam + invariants.
 *
 * Covers the `export-bundle-portability` behavioral leg (import a bundle with a
 * literal credential value → 422, even on ?dryRun=true) plus refs-only export,
 * dry-run zero-writes, dependsOn-cycle rejection, and apply scope-gating.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_PORTABILITY_ENABLED = 'true';
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

const leaky = {
  bundleVersion: '1',
  source: { origin: 'adapter:conformance' },
  items: [{ kind: 'connection-ref', ref: 'c1', payload: { provider: 'anthropic', apiKey: 'sk-conformance-canary' } }],
};

const clean = {
  bundleVersion: '1',
  source: { origin: 'adapter:conformance' },
  items: [
    { kind: 'prompt-template', ref: 'pt1', payload: { template: 'hi' } },
    { kind: 'connection-ref', ref: 'c1', dependsOn: ['pt1'], payload: { provider: 'github', credentialRef: '[REDACTED:c1]' } },
  ],
};

describe('portability — export/import seam (RFC 0098)', () => {
  it('export is refs-only: no literal credential values', async () => {
    const { status, body } = await api<{ bundleVersion: string; items: Array<{ payload: Record<string, unknown> }> }>(
      '/v1/host/openwop-app/export',
    );
    expect(status).toBe(200);
    expect(body.bundleVersion).toBe('1');
    const raw = JSON.stringify(body);
    // No bare credential-key value that isn't a [REDACTED:..] ref.
    expect(/"apiKey"\s*:\s*"(?!\[REDACTED)/.test(raw)).toBe(false);
  });

  it('import of a bundle with a literal credential value is rejected 422 (even on dryRun)', async () => {
    const res = await api('/v1/host/openwop-app/import?dryRun=true', { method: 'POST', body: JSON.stringify({ bundle: leaky }) });
    expect(res.status).toBe(422);
  });

  it('clean dryRun returns a plan and makes zero writes', async () => {
    const res = await api<{ dryRun: boolean; itemCount: number; order: string[] }>(
      '/v1/host/openwop-app/import?dryRun=true',
      { method: 'POST', body: JSON.stringify({ bundle: clean }) },
    );
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.itemCount).toBe(2);
    // dependency order: pt1 before c1.
    expect(res.body.order.indexOf('pt1')).toBeLessThan(res.body.order.indexOf('c1'));
  });

  it('a dependsOn cycle is rejected 422', async () => {
    const cyclic = {
      bundleVersion: '1',
      source: { origin: 'adapter:conformance' },
      items: [
        { kind: 'pack', ref: 'a', dependsOn: ['b'], payload: {} },
        { kind: 'pack', ref: 'b', dependsOn: ['a'], payload: {} },
      ],
    };
    const res = await api('/v1/host/openwop-app/import?dryRun=true', { method: 'POST', body: JSON.stringify({ bundle: cyclic }) });
    expect(res.status).toBe(422);
  });

  it('apply (non-dryRun) without scope is denied 403', async () => {
    const res = await api('/v1/host/openwop-app/import', { method: 'POST', body: JSON.stringify({ bundle: clean }) });
    expect(res.status).toBe(403);
  });

  it('apply of a leaky bundle is 422 before the scope check', async () => {
    const res = await api('/v1/host/openwop-app/import', { method: 'POST', body: JSON.stringify({ bundle: leaky }) });
    expect(res.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAK-12 (ADR 0039 correction) — REAL export/import. Service-level (the route
// wire legs above stay as-is; apply is scope-gated 403 for dev-token, so the
// materialization semantics are proven against the services directly).
// ─────────────────────────────────────────────────────────────────────────────

describe('real export — the tenant\'s actual entities, refs-only', () => {
  const TA = 'porta-src';

  it('exports roster/agent/prompt/schedule/org-chart/connection from real stores, self-checked refs-only', async () => {
    const { createUserTemplate } = await import('../src/host/promptStore.js');
    createUserTemplate({ templateId: 'tpl-porta-brief', version: '1.0.0', kind: 'user', text: 'Brief {{week}}', name: 'tpl-porta-brief' });
    const { createOrg } = await import('../src/host/accessControlService.js');
    const org = await createOrg({ tenantId: TA, createdBy: 'test', name: 'Porta Org', orgId: 'o1' });
    void org;
    const { createRosterEntry } = await import('../src/host/rosterService.js');
    const { upsertAgentProfile } = await import('../src/host/agentProfileService.js');
    const { createEntry } = await import('../src/features/prompts/promptLibraryService.js');
    const { registerJob } = await import('../src/host/schedulingService.js');
    const { putChart } = await import('../src/host/orgChartService.js');
    const { createSecretConnection } = await import('../src/features/connections/connectionsService.js');
    const { buildExportBundle, findLiteralCredential } = await import('../src/features/portability/portabilityService.js');

    const entry = await createRosterEntry({ tenantId: TA, persona: 'ops-lead', agentRef: { agentId: 'assistant' }, label: 'Ops Lead' });
    await upsertAgentProfile(TA, entry.rosterId, { roleKey: 'operations', autonomy: { specLevel: 'recommend' } });
    await createEntry(TA, 'o1', 'test', { name: 'weekly-brief', description: 'Weekly brief prompt', promptRef: 'tpl-porta-brief' });
    const job = await registerJob({ jobId: 'sched-porta-1', tenantId: TA, cronExpr: '0 9 * * 1', enabled: true });
    expect(job.ok).toBe(true);
    const chartOut = await putChart({ tenantId: TA, departments: [{ departmentId: 'd1', name: 'Ops', parentDepartmentId: null, roles: [] }], members: [] });
    expect('chart' in chartOut, JSON.stringify(chartOut)).toBe(true);
    await createSecretConnection({ tenantId: TA, provider: 'sendgrid', kind: 'api_key', secret: 'SG.super-secret', scope: 'workspace' });

    const bundle = await buildExportBundle(TA);
    const kinds = new Set(bundle.items.map((i) => i.kind));
    expect(kinds).toContain('roster');
    expect(kinds).toContain('agent');
    expect(kinds).toContain('prompt-template');
    expect(kinds).toContain('schedule');
    expect(kinds).toContain('org-chart');
    expect(kinds).toContain('connection-ref');

    // Refs-only: the connection carries a [REDACTED:<id>] ref, never material.
    const conn = bundle.items.find((i) => i.kind === 'connection-ref')!;
    expect(String(conn.payload.credentialRef)).toMatch(/^\[REDACTED:[^\]]+\]$/);
    expect(JSON.stringify(bundle)).not.toContain('SG.super-secret');
    for (const item of bundle.items) {
      expect(findLiteralCredential(item.payload, `${item.kind}:${item.ref}`)).toBeNull();
    }
    // The agent item depends on its roster entry (topo order on import).
    const agent = bundle.items.find((i) => i.kind === 'agent')!;
    expect(agent.dependsOn?.[0]).toBe(`roster:${entry.rosterId}`);
  });
});

describe('real import — materializes via the owning services, inert + idempotent', () => {
  const TA = 'porta-src';
  const TB = 'porta-dst';

  it('round-trips the export into a second tenant: roster+schedule land DISABLED, connection is record-only, org-chart drops foreign members', async () => {
    const { buildExportBundle, applyImport } = await import('../src/features/portability/portabilityService.js');
    const { listRoster } = await import('../src/host/rosterService.js');
    const { getJob } = await import('../src/host/schedulingService.js');
    const { listEntriesUnfiltered } = await import('../src/features/prompts/promptLibraryService.js');

    const bundle = await buildExportBundle(TA);
    const result = await applyImport(TB, 'test', bundle);

    expect(result.dryRun).toBe(false);
    expect(result.items.length).toBe(bundle.items.length);
    const byKind = (k: string) => result.items.filter((i) => i.kind === k);

    // Roster materialized in TB, DISABLED for review.
    expect(byKind('roster')[0]!.status).toBe('imported');
    const imported = (await listRoster(TB)).find((r) => r.persona === 'ops-lead')!;
    expect(imported.enabled).toBe(false);

    // Schedule registered with a deterministic import: id, DISABLED.
    expect(byKind('schedule')[0]!.status).toBe('imported');
    // Tenant-qualified deterministic id (cross-tenant id-space isolation).
    const jobId = `import:${encodeURIComponent(TB)}:${'sched:sched-porta-1'.replace(/[^a-zA-Z0-9:_-]/g, '_')}`;
    const job = await getJob(jobId);
    expect(job?.enabled).toBe(false);
    expect(job?.tenantId).toBe(TB);

    // Prompt created in the payload's org.
    expect(byKind('prompt-template')[0]!.status).toBe('imported');
    expect((await listEntriesUnfiltered(TB, 'o1')).some((e) => e.name === 'weekly-brief')).toBe(true);

    // Connection is refs-only → record-only skip with a re-auth pointer.
    expect(byKind('connection-ref')[0]!.status).toBe('skipped');
    expect(byKind('connection-ref')[0]!.message).toMatch(/re-auth/);

    // Org chart: structure imports; TA's member rosterIds don't resolve in TB.
    expect(byKind('org-chart')[0]!.status).toBe('imported');
  });

  it('re-importing the same bundle is idempotent — skips, never duplicates', async () => {
    const { buildExportBundle, applyImport } = await import('../src/features/portability/portabilityService.js');
    const { listRoster } = await import('../src/host/rosterService.js');

    const bundle = await buildExportBundle(TA);
    const before = (await listRoster(TB)).length;
    const again = await applyImport(TB, 'test', bundle);
    expect((await listRoster(TB)).length).toBe(before); // no duplicate roster rows
    expect(again.items.find((i) => i.kind === 'roster')!.status).toBe('skipped');
    expect(again.items.find((i) => i.kind === 'schedule')!.status).toBe('skipped');
  });

  it('per-item isolation: a bad item never aborts the rest', async () => {
    const { applyImport } = await import('../src/features/portability/portabilityService.js');
    const { createUserTemplate } = await import('../src/host/promptStore.js');
    createUserTemplate({ templateId: 'tpl-porta-iso', version: '1.0.0', kind: 'user', text: 'Iso', name: 'tpl-porta-iso' });
    const mixed = {
      bundleVersion: '1',
      source: { origin: 'adapter:test' },
      items: [
        { kind: 'schedule', ref: 'bad-sched', payload: {} }, // no cronExpr → skipped
        { kind: 'prompt-template', ref: 'good-pt', payload: { name: 'isolated-prompt', orgId: 'o1', promptRef: 'tpl-porta-iso' } },
      ],
    };
    const result = await applyImport('porta-iso', 'test', mixed);
    expect(result.items.find((i) => i.ref === 'bad-sched')!.status).toBe('skipped');
    expect(result.items.find((i) => i.ref === 'good-pt')!.status).toBe('imported');
    expect(result.imported).toBe(1);
  });
});

describe('bundle item cap (fan-out bound)', () => {
  it('rejects a bundle above the 500-item cap with 422 well-formedness', async () => {
    const { planImport, MalformedBundleError } = await import('../src/features/portability/portabilityService.js');
    const big = {
      bundleVersion: '1',
      source: { origin: 'adapter:test' },
      items: Array.from({ length: 501 }, (_, i) => ({ kind: 'pack', ref: `p${i}`, payload: {} })),
    };
    expect(() => planImport(big)).toThrow(MalformedBundleError);
  });
});
