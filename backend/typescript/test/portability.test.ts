/**
 * Portability (RFC 0098) — host-sample export/import seam + invariants.
 *
 * Covers the `export-bundle-portability` behavioral leg (import a bundle with a
 * literal credential value → 422, even on ?dryRun=true) plus refs-only export
 * (and the export's own self-check), dry-run zero-writes, dependsOn-cycle
 * rejection, and apply scope-gating — each refusal asserted by its exact message,
 * so a 422/403 from a different check cannot stand in.
 *
 * Isolation: the source tenant `porta-src` is seeded ONCE in the file's
 * `beforeAll`; every import case writes to its OWN destination tenant, and the
 * idempotency case runs its own first import, so the file passes under
 * `--sequence.shuffle`.
 *
 * DOUBLE GUARDS (named, not gaps): re-importing a schedule, a roster member or a
 * prompt is skipped by TWO independent checks — a find-existing read and the
 * `claimImport` insert-if-absent claim. Each answers with its OWN message
 * ("already imported" / "already present" vs "claimed by a concurrent import" /
 * "was already imported"), so the re-import cases pin the find-existing message:
 * dropping that check alone is then red, and a break-both probe covers the pair.
 * (Wave 8f w1 asserted the status only, so `po-sched-existing-skip` was vacuous.)
 *
 * ADR 0993 D7 — a prompt lands only in an org the importer may WRITE in the
 * target tenant (the round trip's `o1` is the source tenant's org, so it is
 * skipped with that reason), and the export answers what the exporting subject
 * may read (the export cases pass the org owner `test` as the caller). The
 * prompt's own import and re-import are exercised in the per-item case, whose
 * tenant owns its org.
 *
 * Sabotages each case is red against (wave 106 probes w106g2-po-*): the import
 * credential scan, the export self-check, the redacted connection ref, the cycle
 * check, the item cap (both sides of 500), the `packs:publish` gate, applying
 * before the scope check, a dry run that applies, validate-before-scope, topo
 * order, roster/schedules imported enabled, the tenant-qualified jobId, the
 * deterministic jobId, each find-existing check and each double guard, the
 * prompt write-access check, the record-only connection, the org-chart member
 * filter, the export caller, and the per-item catch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createTenantTemplate } from '../src/host/tenantPromptTemplates.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createRosterEntry, listRoster } from '../src/host/rosterService.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import { createEntry, listEntriesUnfiltered } from '../src/features/prompts/promptLibraryService.js';
import { getJob, listJobs, registerJob } from '../src/host/schedulingService.js';
import { getChart, putChart } from '../src/host/orgChartService.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import {
  applyImport, buildExportBundle, CredentialMaterialError, findLiteralCredential, MalformedBundleError, planImport,
} from '../src/features/portability/portabilityService.js';
import type { ExportBundle, ImportPlan } from '../src/features/portability/types.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const TA = 'porta-src';
let rosterId = '';
const savedEnv = { dsn: process.env.OPENWOP_STORAGE_DSN, enabled: process.env.OPENWOP_PORTABILITY_ENABLED };

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

  // The source tenant every real-export / real-import case reads.
  // ADR 0993 D5 — a user template belongs to ONE tenant now.
  expect((await createTenantTemplate(TA, { templateId: 'tpl-porta-brief', version: '1.0.0', kind: 'user', text: 'Brief {{week}}', name: 'tpl-porta-brief' })).ok).toBe(true);
  // ADR 0993 D7 — the prompt export answers what the EXPORTER may read, so the
  // exporting subject is a real member of the org.
  await createOrg({ tenantId: TA, createdBy: 'test', name: 'Porta Org', orgId: 'o1', ownerSubject: 'test' });
  const entry = await createRosterEntry({ tenantId: TA, persona: 'ops-lead', agentRef: { agentId: 'assistant' }, label: 'Ops Lead' });
  rosterId = entry.rosterId;
  await upsertAgentProfile(TA, entry.rosterId, { roleKey: 'operations', autonomy: { specLevel: 'recommend' } });
  await createEntry(TA, 'o1', 'test', { name: 'weekly-brief', description: 'Weekly brief prompt', promptRef: 'tpl-porta-brief', visibility: 'org' });
  const job = await registerJob({ jobId: 'sched-porta-1', tenantId: TA, cronExpr: '0 9 * * 1', enabled: true });
  if (!job.ok) throw new Error(`seed schedule failed: ${job.error.message}`);
  // One member, so the cross-tenant import has a member whose rosterId cannot resolve.
  const chartOut = await putChart({
    tenantId: TA,
    departments: [{ departmentId: 'd1', name: 'Ops', parentDepartmentId: null, roles: [{ roleId: 'r1', name: 'Lead' }] }],
    members: [{ rosterId: entry.rosterId, departmentId: 'd1', roleId: 'r1', reportsTo: null }],
  });
  if (!('chart' in chartOut)) throw new Error(`seed chart failed: ${JSON.stringify(chartOut)}`);
  await createSecretConnection({ tenantId: TA, provider: 'sendgrid', kind: 'api_key', secret: 'SG.super-secret', scope: 'workspace' });
}, 120_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (savedEnv.dsn === undefined) delete process.env.OPENWOP_STORAGE_DSN; else process.env.OPENWOP_STORAGE_DSN = savedEnv.dsn;
  if (savedEnv.enabled === undefined) delete process.env.OPENWOP_PORTABILITY_ENABLED; else process.env.OPENWOP_PORTABILITY_ENABLED = savedEnv.enabled;
});

/** Response bodies are read as `unknown` and narrowed here, never cast. */
function isItem(v: unknown): v is ExportBundle['items'][number] {
  return typeof v === 'object' && v !== null && 'kind' in v && typeof v.kind === 'string' && 'ref' in v && typeof v.ref === 'string'
    && 'payload' in v && typeof v.payload === 'object' && v.payload !== null;
}
function assertBundle(v: unknown): asserts v is ExportBundle {
  const ok = typeof v === 'object' && v !== null && 'bundleVersion' in v && v.bundleVersion === '1'
    && 'source' in v && typeof v.source === 'object' && v.source !== null && 'origin' in v.source && typeof v.source.origin === 'string'
    && 'items' in v && Array.isArray(v.items) && v.items.every(isItem);
  if (!ok) throw new Error(`not an export bundle: ${JSON.stringify(v).slice(0, 300)}`);
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body: unknown = text.length ? JSON.parse(text) : null;
  return { status: res.status, body };
}
const post = (path: string, bundle: unknown) => api(path, { method: 'POST', body: JSON.stringify({ bundle }) });

/** The tenant the route requests act in, read off the export's origin rather than assumed. */
async function routeTenant(): Promise<string> {
  const { body } = await api('/host/openwop-app/export');
  assertBundle(body);
  return body.source.origin.replace('host:openwop-app:', '');
}

const leaky = {
  bundleVersion: '1',
  source: { origin: 'adapter:conformance' },
  items: [{ kind: 'connection-ref', ref: 'c1', payload: { provider: 'anthropic', apiKey: 'sk-conformance-canary' } }],
};
// The route's error envelope runs the free-text scrubber over `message`, which
// rewrites the trailing conformance-leg id as `<redacted:high-entropy>` — so the
// message is pinned up to that tail; `details.keyPath` pins the rest. The redaction is
// grade-code row PORT-REDACT-1 (a conformance-facing message mangled by the scrubber).
const LEAKY_MESSAGE = /^Import bundle carries a literal credential value at `connection-ref:c1\.payload\.apiKey` — bundles are refs-only \(/;

/** A clean bundle whose APPLY would write a schedule — so "zero writes" is observable. */
const clean = {
  bundleVersion: '1',
  source: { origin: 'adapter:conformance' },
  items: [
    { kind: 'connection-ref', ref: 'c1', dependsOn: ['s1'], payload: { provider: 'github', credentialRef: '[REDACTED:c1]' } },
    { kind: 'schedule', ref: 's1', payload: { cronExpr: '0 9 * * *' } },
  ],
};

describe('portability — export/import seam (RFC 0098)', () => {
  it('export is refs-only: no literal credential values', async () => {
    const { status, body } = await api('/host/openwop-app/export');
    expect(status).toBe(200);
    assertBundle(body);
    const tenant = body.source.origin.replace('host:openwop-app:', '');
    // Seed a REAL secret connection in the exporting tenant, then export again:
    // the bundle must carry a [REDACTED:<id>] ref and never the material.
    await createSecretConnection({ tenantId: tenant, provider: 'sendgrid', kind: 'api_key', secret: 'SG.route-export-secret', scope: 'workspace' });
    const again = await api('/host/openwop-app/export');
    expect(again.status).toBe(200);
    assertBundle(again.body);
    const conns = again.body.items.filter((i) => i.kind === 'connection-ref');
    expect(conns.length).toBe(1);
    expect(String(conns[0]!.payload.credentialRef)).toMatch(/^\[REDACTED:[^\]]+\]$/);
    expect(JSON.stringify(again.body)).not.toContain('SG.route-export-secret');

    // The export's OWN self-check: a literal credential that reaches a payload
    // (an agent profile's free-form configParameters) refuses the whole export.
    const leakTenant = 'porta-leak';
    const e = await createRosterEntry({ tenantId: leakTenant, persona: 'leaky', agentRef: { agentId: 'assistant' }, label: 'Leaky' });
    await upsertAgentProfile(leakTenant, e.rosterId, { roleKey: 'operations', autonomy: { specLevel: 'recommend' }, configParameters: { apiKey: 'sk-live-planted' } });
    const refused = buildExportBundle(leakTenant);
    await expect(refused).rejects.toBeInstanceOf(CredentialMaterialError);
    await expect(refused).rejects.toMatchObject({ keyPath: `agent:agent:${e.rosterId}.payload.configParameters.apiKey` });
  });

  it('import of a bundle with a literal credential value is rejected 422 (even on dryRun)', async () => {
    const res = await post('/host/openwop-app/import?dryRun=true', leaky);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'validation_error', message: expect.stringMatching(LEAKY_MESSAGE), details: { keyPath: 'connection-ref:c1.payload.apiKey' } });
  });

  it('clean dryRun returns a plan and makes zero writes', async () => {
    const tenant = await routeTenant();
    const before = await listJobs(tenant);
    const res = await post('/host/openwop-app/import?dryRun=true', clean);
    expect(res.status).toBe(200);
    const plan: ImportPlan = { dryRun: true, itemCount: 2, byKind: { 'connection-ref': 1, schedule: 1 }, order: ['s1', 'c1'] }; // dependency order
    expect(res.body).toEqual(plan);
    expect(await listJobs(tenant)).toEqual(before); // the schedule an apply WOULD register was not
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
    const res = await post('/host/openwop-app/import?dryRun=true', cyclic);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'validation_error', message: 'Import bundle has a dependsOn cycle: a → b → a.', details: { cycle: ['a', 'b', 'a'] } });
  });

  it('apply (non-dryRun) without scope is denied 403', async () => {
    const tenant = await routeTenant();
    const before = await listJobs(tenant);
    const res = await post('/host/openwop-app/import', clean);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'forbidden_scope', message: 'Applying an import bundle requires the `packs:publish` scope.', details: { requiredScope: 'packs:publish' } });
    expect(await listJobs(tenant)).toEqual(before); // and nothing was written
  });

  it('apply of a leaky bundle is 422 before the scope check', async () => {
    const res = await post('/host/openwop-app/import', leaky);
    expect(res.status).toBe(422); // the scope check would have answered 403
    expect(res.body).toMatchObject({ error: 'validation_error', message: expect.stringMatching(LEAKY_MESSAGE), details: { keyPath: 'connection-ref:c1.payload.apiKey' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAK-12 (ADR 0039 correction) — REAL export/import. Service-level (the route
// wire legs above stay as-is; apply is scope-gated 403 for dev-token, so the
// materialization semantics are proven against the services directly).
// ─────────────────────────────────────────────────────────────────────────────

describe('real export — the tenant\'s actual entities, refs-only', () => {
  it('exports roster/agent/prompt/schedule/org-chart/connection from real stores, self-checked refs-only', async () => {
    const bundle = await buildExportBundle(TA, undefined, 'test');
    expect([...new Set(bundle.items.map((i) => i.kind))].sort()).toEqual(['agent', 'connection-ref', 'org-chart', 'prompt-template', 'roster', 'schedule']);

    // Refs-only: the connection carries a [REDACTED:<id>] ref, never material.
    const conn = bundle.items.find((i) => i.kind === 'connection-ref')!;
    expect(String(conn.payload.credentialRef)).toMatch(/^\[REDACTED:[^\]]+\]$/);
    expect(JSON.stringify(bundle)).not.toContain('SG.super-secret');
    for (const item of bundle.items) {
      expect(findLiteralCredential(item.payload, `${item.kind}:${item.ref}`)).toBeNull();
    }
    // The agent item depends on its roster entry (topo order on import).
    const agent = bundle.items.find((i) => i.kind === 'agent')!;
    expect(agent.dependsOn).toEqual([`roster:${rosterId}`]);
  });
});

describe('real import — materializes via the owning services, inert + idempotent', () => {
  /** The tenant-qualified deterministic import id, derived by hand from the rule. */
  const importedJobId = (tenant: string) => `import:${encodeURIComponent(tenant)}:sched:sched-porta-1`;

  it('round-trips the export into a second tenant: roster+schedule land DISABLED, connection is record-only, org-chart drops foreign members', async () => {
    const TB = 'porta-dst-roundtrip';
    const bundle = await buildExportBundle(TA, undefined, 'test');
    const result = await applyImport(TB, 'test', bundle);

    expect(result.dryRun).toBe(false);
    expect(result.items.length).toBe(bundle.items.length);
    const byKind = (k: string) => result.items.filter((i) => i.kind === k);
    // topo order: the agent never lands before the roster entry it depends on
    expect(result.refs.indexOf(`roster:${rosterId}`)).toBeLessThan(result.refs.indexOf(`agent:${rosterId}`));

    // Roster materialized in TB, DISABLED for review.
    expect(byKind('roster')[0]!.status).toBe('imported');
    const imported = (await listRoster(TB)).find((r) => r.persona === 'ops-lead')!;
    expect(imported.enabled).toBe(false);

    // Schedule registered with a deterministic, tenant-qualified import: id, DISABLED.
    expect(byKind('schedule')[0]!.status).toBe('imported');
    const job = await getJob(importedJobId(TB));
    expect(job?.enabled).toBe(false);
    expect(job?.tenantId).toBe(TB);

    // ADR 0993 D7 — a prompt lands only in an org the importer may WRITE in the
    // target tenant. `o1` is TA's org (org ids are global), so the import says so
    // instead of writing a row into an org TB does not have, which no route could
    // ever reach (what it did before).
    expect(byKind('prompt-template')[0]!.status).toBe('skipped');
    expect(byKind('prompt-template')[0]!.message).toMatch(/write access to org o1/);
    expect(await listEntriesUnfiltered(TB, 'o1')).toEqual([]);

    // Connection is refs-only → record-only skip with a re-auth pointer.
    expect(byKind('connection-ref')[0]!.status).toBe('skipped');
    expect(byKind('connection-ref')[0]!.message).toMatch(/re-auth/);

    // Org chart: the member's roster entry landed first (topo order), so it resolves
    // in TB and is kept…
    expect(byKind('org-chart')[0]).toMatchObject({ status: 'imported', message: 'org chart imported' });
    expect((await getChart(TB))?.members.map((m) => m.rosterId)).toEqual([rosterId]);
    // …while a chart exported WITHOUT its roster lands with the foreign member dropped.
    const TC = 'porta-dst-chart-only';
    const chartOnly = await applyImport(TC, 'test', await buildExportBundle(TA, ['org-chart'], 'test'));
    expect(chartOnly.items).toEqual([{ ref: `orgchart:${TA}`, kind: 'org-chart', status: 'imported', message: 'org chart imported (1 member(s) dropped — no matching roster entry on this host)' }]);
    expect((await getChart(TC))?.members).toEqual([]);
  });

  it('re-importing the same bundle is idempotent — skips, never duplicates', async () => {
    const TB = 'porta-dst-idempotent';
    const bundle = await buildExportBundle(TA, undefined, 'test');
    const first = await applyImport(TB, 'test', bundle);
    expect(first.items.find((i) => i.kind === 'schedule')!.status).toBe('imported');
    const rosterBefore = (await listRoster(TB)).map((r) => r.rosterId);
    expect(rosterBefore).toHaveLength(1);
    const jobsBefore = (await listJobs(TB)).map((j) => j.jobId);
    expect(jobsBefore).toEqual([importedJobId(TB)]);

    const again = await applyImport(TB, 'test', bundle);
    expect((await listRoster(TB)).map((r) => r.rosterId)).toEqual(rosterBefore); // no duplicate roster rows
    expect((await listJobs(TB)).map((j) => j.jobId)).toEqual(jobsBefore); // COUNT the jobs: still one
    // The FIND-EXISTING message, not the claim's: each half of the double guard says its own.
    expect(again.items.find((i) => i.kind === 'roster')).toMatchObject({ status: 'skipped', message: `persona 'ops-lead' already present (${rosterBefore[0]})` });
    expect(again.items.find((i) => i.kind === 'schedule')).toMatchObject({ status: 'skipped', message: `schedule ${importedJobId(TB)} already imported` });
    // Only the replace-in-place kinds re-apply (an agent profile is an upsert, an
    // org chart a put); every create-kind is skipped (the prompt here for write
    // access to TA's org, as in the round trip; its own re-import is the per-item case).
    expect(again.items.filter((i) => i.status === 'imported').map((i) => i.kind).sort()).toEqual(['agent', 'org-chart']);
  });

  it('per-item isolation: a bad item never aborts the rest; the prompt it lands re-imports as a skip', async () => {
    expect((await createTenantTemplate('porta-iso', { templateId: 'tpl-porta-iso', version: '1.0.0', kind: 'user', text: 'Iso', name: 'tpl-porta-iso' })).ok).toBe(true);
    await createOrg({ tenantId: 'porta-iso', createdBy: 'test', name: 'Iso Org', orgId: 'o-iso', ownerSubject: 'test' });
    const mixed = {
      bundleVersion: '1',
      source: { origin: 'adapter:test' },
      items: [
        { kind: 'schedule', ref: 'bad-sched', payload: {} }, // no cronExpr → skipped
        // A department with no `roles` array makes the chart service THROW (not skip),
        // so the per-item catch is what keeps the next item alive.
        { kind: 'org-chart', ref: 'bad-chart', payload: { departments: [{ departmentId: 'dx' }] } },
        { kind: 'prompt-template', ref: 'good-pt', payload: { name: 'isolated-prompt', orgId: 'o-iso', promptRef: 'tpl-porta-iso' } },
      ],
    };
    const result = await applyImport('porta-iso', 'test', mixed);
    expect(result.refs).toEqual(['bad-sched', 'bad-chart', 'good-pt']); // the throwing item runs BEFORE the good one
    expect(result.items.find((i) => i.ref === 'bad-sched')).toMatchObject({ status: 'skipped', message: 'payload.cronExpr missing' });
    expect(result.items.find((i) => i.ref === 'bad-chart')!.status).toBe('failed');
    expect(result.items.find((i) => i.ref === 'good-pt')).toMatchObject({ status: 'imported', message: "prompt 'isolated-prompt' created in org o-iso" });
    expect(result.imported).toBe(1);
    // Read back: the row exists, once.
    expect((await listEntriesUnfiltered('porta-iso', 'o-iso')).map((e) => e.name)).toEqual(['isolated-prompt']);

    // Re-import: the prompt's find-existing check answers (its own message), no second row.
    const again = await applyImport('porta-iso', 'test', mixed);
    expect(again.items.find((i) => i.ref === 'good-pt')).toMatchObject({ status: 'skipped', message: "prompt 'isolated-prompt' already present in org o-iso" });
    expect((await listEntriesUnfiltered('porta-iso', 'o-iso')).map((e) => e.name)).toEqual(['isolated-prompt']);
  });
});

describe('bundle item cap (fan-out bound)', () => {
  it('rejects a bundle above the 500-item cap with 422 well-formedness', () => {
    const bundleOf = (n: number) => ({
      bundleVersion: '1',
      source: { origin: 'adapter:test' },
      items: Array.from({ length: n }, (_, i) => ({ kind: 'pack', ref: `p${i}`, payload: {} })),
    });
    expect(() => planImport(bundleOf(501))).toThrow(MalformedBundleError);
    expect(() => planImport(bundleOf(501))).toThrow('items exceeds the 500-item cap');
    // the boundary: exactly 500 is accepted
    expect(planImport(bundleOf(500)).itemCount).toBe(500);
  });
});
