/**
 * ADR 0508 fold-in (B3) — the migration that re-tenants the CRM rows the
 * shared-workspace defect misfiled.
 *
 * ADR 0508 argued "no migration needed" on the premise that the 404 prevented a
 * handler from writing `user.tenantId` while authorized in a `ws:` workspace. Phase 2
 * REMOVED that 404 and CRM's 95 gate-bound handlers kept re-deriving the home tenant
 * for the whole window between the phases, so rows exist in exactly the state the
 * premise called impossible: `tenantId` = the caller's personal tenant, `orgId` owned
 * by the workspace. After the CRM fix they are unreachable by reads AND by every
 * reclaim path (teardown, retention, erasure), because all three enumerate per
 * tenant.
 *
 * These cases assert the migration's DISCRIMINATION, not that it runs. The decoy is
 * the point: a legitimately home-tenanted row must not move, or a repair for one
 * partition becomes a cross-tenant write into another.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __hostExtStorage, DurableCollection } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import { retenantMisfiledCrmRows } from '../src/features/crm/orgScopeRetenant.js';

const HOME = 'user:home-of-the-caller';
const WS = 'ws:the-shared-workspace';
let server: http.Server;
let storage: Storage;

/** Minimal shapes — the migration is namespace-driven and reads only
 *  `tenantId`/`orgId`, so a full entity fixture would test nothing extra. */
interface OrgRow { orgId: string; tenantId: string; name: string }
interface TaskRow { taskId: string; tenantId: string; orgId: string; title: string }

const orgs = new DurableCollection<OrgRow>('access-orgs', (o) => o.orgId, undefined, (o) => o.tenantId);
const tasks = new DurableCollection<TaskRow>('crm:task', (t) => t.taskId, undefined, (t) => t.tenantId);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  storage = __hostExtStorage()!;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(async () => { await tasks.__clear(); await orgs.__clear(); });

async function seedOrgs(): Promise<{ wsOrg: string; homeOrg: string }> {
  await orgs.put({ orgId: 'org:shared', tenantId: WS, name: 'Shared workspace org' });
  await orgs.put({ orgId: 'org:personal', tenantId: HOME, name: 'My own org' });
  return { wsOrg: 'org:shared', homeOrg: 'org:personal' };
}

describe('B3 — re-tenanting the misfiled CRM rows', () => {
  it('moves a genuinely misfiled row, and leaves a legitimately home-tenanted DECOY alone', async () => {
    const { wsOrg, homeOrg } = await seedOrgs();
    // The defect's exact output: filed under the caller's HOME tenant, carrying an
    // orgId the SHARED workspace owns.
    await tasks.put({ taskId: 'task:misfiled', tenantId: HOME, orgId: wsOrg, title: 'Belongs to the workspace' });
    // The decoy: same home tenant, but its org is genuinely owned by that tenant.
    // Nothing about it is wrong and a sloppier match would move it into `ws:`.
    await tasks.put({ taskId: 'task:legit', tenantId: HOME, orgId: homeOrg, title: 'Genuinely mine' });

    const r = await retenantMisfiledCrmRows(storage);

    expect((await tasks.get('task:misfiled'))!.tenantId, 'the misfiled row moves to its org\'s owner').toBe(WS);
    expect((await tasks.get('task:legit'))!.tenantId, 'the decoy must NOT move — its org is genuinely its own').toBe(HOME);
    expect(r.rewritten).toBe(1);
    expect(r.skippedCorrect).toBeGreaterThanOrEqual(1);
    expect(r.byNamespace['crm:task']).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('the moved row becomes reachable in the WORKSPACE and unreachable in the home tenant', async () => {
    // The whole point: a value-only rewrite that left the old `hostextidx:` marker
    // behind would keep the home tenant reading the row through a stale marker —
    // the defect surviving its own repair. `listForTenantIndexed` does NOT re-filter
    // on the row's tenant, so this is a real hazard, not a hypothetical one.
    const { wsOrg } = await seedOrgs();
    await tasks.put({ taskId: 'task:misfiled', tenantId: HOME, orgId: wsOrg, title: 'x' });
    expect((await tasks.listForTenantIndexed(HOME)).map((t) => t.taskId), 'precondition').toContain('task:misfiled');

    await retenantMisfiledCrmRows(storage);

    expect((await tasks.listForTenantIndexed(WS)).map((t) => t.taskId), 'the workspace can now see its own row').toContain('task:misfiled');
    expect(
      (await tasks.listForTenantIndexed(HOME)).map((t) => t.taskId),
      'a surviving marker in the old slice would leave the row readable by the wrong tenant',
    ).not.toContain('task:misfiled');
  });

  it('refuses to move a row whose orgId names NO org — never a guess at a dangling ref', async () => {
    await seedOrgs();
    await tasks.put({ taskId: 'task:dangling', tenantId: HOME, orgId: 'org:deleted-long-ago', title: 'x' });

    const r = await retenantMisfiledCrmRows(storage);

    expect((await tasks.get('task:dangling'))!.tenantId).toBe(HOME);
    expect(r.rewritten).toBe(0);
    expect(r.skippedOrgMissing).toBe(1);
  });

  it('never moves a row that already sits in a `ws:` workspace tenant (the one-directional guard)', async () => {
    const { homeOrg } = await seedOrgs();
    // A pathological row: in the workspace, carrying an org the home tenant owns.
    // The defect only ever wrote in the HOME direction, and refusing the reverse is
    // what makes an accidental mass-move impossible.
    await tasks.put({ taskId: 'task:ws-side', tenantId: WS, orgId: homeOrg, title: 'x' });

    const r = await retenantMisfiledCrmRows(storage);

    expect((await tasks.get('task:ws-side'))!.tenantId).toBe(WS);
    expect(r.rewritten).toBe(0);
    expect(r.skippedWorkspaceTenant).toBe(1);
  });

  it('is idempotent — a second (or concurrent) execution is a no-op', async () => {
    const { wsOrg } = await seedOrgs();
    await tasks.put({ taskId: 'task:misfiled', tenantId: HOME, orgId: wsOrg, title: 'x' });

    const first = await retenantMisfiledCrmRows(storage);
    const second = await retenantMisfiledCrmRows(storage);
    // Concurrency: two instances boot at once on a rolling deploy and BOTH run this.
    const [a, b] = await Promise.all([retenantMisfiledCrmRows(storage), retenantMisfiledCrmRows(storage)]);

    expect(first.rewritten).toBe(1);
    expect(second.rewritten, 'a re-run must find nothing left to do').toBe(0);
    expect(a.rewritten + b.rewritten, 'concurrent re-runs must not double-move').toBe(0);
    expect((await tasks.get('task:misfiled'))!.tenantId).toBe(WS);
  });

  it('a fresh install (no orgs at all) is a clean no-op, not a sweep', async () => {
    await tasks.put({ taskId: 'task:orphan', tenantId: HOME, orgId: 'org:whatever', title: 'x' });
    const r = await retenantMisfiledCrmRows(storage);
    expect(r.rewritten).toBe(0);
    expect(r.examined, 'no adjudicator ⇒ nothing is even examined').toBe(0);
    expect((await tasks.get('task:orphan'))!.tenantId).toBe(HOME);
  });

  it('a tenant-scoped CRM row (no orgId) is never a candidate', async () => {
    await seedOrgs();
    const contacts = new DurableCollection<{ contactId: string; tenantId: string; name: string }>(
      'crm:contact', (c) => c.contactId, undefined, (c) => c.tenantId,
    );
    await contacts.put({ contactId: 'ct:1', tenantId: HOME, name: 'Ada' });
    const r = await retenantMisfiledCrmRows(storage);
    expect((await contacts.get('ct:1'))!.tenantId).toBe(HOME);
    expect(r.skippedNoOrg).toBeGreaterThanOrEqual(1);
    expect(r.rewritten).toBe(0);
    await contacts.__clear();
  });
});
