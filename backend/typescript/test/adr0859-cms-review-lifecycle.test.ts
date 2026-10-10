/**
 * ADR 0859 — the CMS editorial approval gate's review lifecycle (feature loop round 2, row 34).
 *
 * Each `describe` is one decision. The first three legs were written FIRST and run against
 * `origin/main` @ `42f252ffc` before any fix (the log is in the PR):
 *
 *   - D1 (`CMSA2WF-1`, issue #4515) — `createDraftPage` naming another org's page id wrote
 *     over it: the idempotency read is org-filtered, so the row read as absent and the
 *     blind `put` replaced it.
 *   - D2 (`CMSA2WF-2`) — two submits racing on one page minted two review rows.
 *   - D6 (`CMSA2WF-4`) — 100 resolved approvals of ANY kind pruned the page's last decision.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import * as cmsService from '../src/features/cms/cmsService.js';
import { buildCmsSurface } from '../src/features/cms/surface.js';
import { queueContentApproval } from '../src/features/cms/contentApproval.js';
import { getSystemEntity, putSystemEntity } from '../src/features/entities/entitiesService.js';
import {
  createContentApproval,
  eraseApprovalSubject,
  ERASED_SUBJECT_SENTINEL,
  findLatestContentApprovalForPage,
  getApproval,
  listApprovals,
  resolveApproval,
} from '../src/host/approvalService.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

let n = 0;
const tenant = (): string => `org:adr0859-${Date.now()}-${n++}`;

describe('D1 — createPage never writes over a page another org owns (#4515)', () => {
  it('the run surface refuses an id org A holds, and A\'s page is untouched', async () => {
    const tenantId = tenant();
    const a = await cmsService.createPage({ tenantId, orgId: 'org-a', title: 'A launch', createdBy: 'u-a', sections: [{ type: 'hero', data: { heading: 'A content' } }] });
    await cmsService.transitionPage(tenantId, 'org-a', a.pageId, 'publish', 'u-a');

    const surface = buildCmsSurface({ tenantId });
    await expect(surface.createDraftPage!({ orgId: 'org-b', title: 'B takeover', pageId: a.pageId, sections: [{ type: 'hero', data: { heading: 'B content' } }] }))
      .rejects.toMatchObject({ code: 'conflict' });

    const still = await cmsService.getPage(tenantId, 'org-a', a.pageId);
    expect(still?.status).toBe('published');
    expect(still?.title).toBe('A launch');
    expect(await cmsService.getPage(tenantId, 'org-b', a.pageId)).toBeNull();
  });

  it('a same-org replay still converges on the existing page (positive control)', async () => {
    const tenantId = tenant();
    const surface = buildCmsSurface({ tenantId });
    const first = await surface.createDraftPage!({ orgId: 'org-a', title: 'Draft', pageId: 'page:replay-1' }) as { pageId: string };
    const again = await surface.createDraftPage!({ orgId: 'org-a', title: 'Draft (replay)', pageId: 'page:replay-1' }) as { pageId: string; title: string };
    expect(again.pageId).toBe(first.pageId);
    expect(again.title).toBe('Draft');
  });
});

describe('D1/D2 — a legacy kernel row with NO top-level orgId (12 such rows in prod, 2026-10-07)', () => {
  // Prod measured 12 cms.page kernel records whose top-level `orgId` is NULL while
  // `ext.page.orgId` is the (personal) tenant id. Nothing in ADR 0859 may read the
  // top-level column: the page's org is `ext.page.orgId` (`kernelToPage`). This pins it
  // — such a page still converges for its own org, refuses another, edits, enters
  // review exactly once, and publishes.
  it('converges, refuses another org, edits, reviews and publishes', async () => {
    const tenantId = tenant();
    const orgId = tenantId; // the personal-tenant shape: ext.page.orgId === tenant id
    const seed = await cmsService.createPage({ tenantId, orgId, title: 'Legacy', createdBy: 'u-a', sections: [{ type: 'hero', data: { heading: 'Old' } }] });
    const rec = await getSystemEntity(tenantId, cmsService.CMS_PAGE_TYPE, seed.pageId);
    expect(rec?.orgId, 'the fixture must start from a normal row').toBe(orgId);
    const legacyId = 'page:legacy-null-org';
    const ext = { ...(rec!.ext as Record<string, unknown>), page: { ...((rec!.ext as { page: Record<string, unknown> }).page), pageId: legacyId } };
    await putSystemEntity({ tenantId, typeName: cmsService.CMS_PAGE_TYPE, entityId: legacyId, values: rec!.values, ext, status: 'draft', actor: 'legacy' });
    expect((await getSystemEntity(tenantId, cmsService.CMS_PAGE_TYPE, legacyId))?.orgId, 'the row must really have no top-level orgId').toBeUndefined();

    const page = await cmsService.getPage(tenantId, orgId, legacyId);
    expect(page?.orgId).toBe(orgId);
    // D1: same org converges, another org is refused.
    expect((await cmsService.createPage({ tenantId, orgId, title: 'x', createdBy: 'u', pageId: legacyId })).pageId).toBe(legacyId);
    await expect(cmsService.createPage({ tenantId, orgId: 'org-other', title: 'x', createdBy: 'u', pageId: legacyId })).rejects.toMatchObject({ code: 'conflict' });
    // Edit (the page CAS compares the domain row, not the column).
    const edited = await cmsService.updatePage(tenantId, orgId, legacyId, { sections: [{ type: 'hero', data: { heading: 'New' } }] }, 'u-a', { expectedVersion: page!.version });
    expect(edited?.version).toBe(page!.version + 1);
    // Review: one row, at the cycle id.
    const submitted = await cmsService.transitionPage(tenantId, orgId, legacyId, 'submit', 'u-a');
    expect(submitted?.reviewCycle).toBe(1);
    await queueContentApproval(tenantId, orgId, submitted!, undefined, { notify: false });
    await queueContentApproval(tenantId, orgId, submitted!, undefined, { notify: false });
    const rows = (await listApprovals(tenantId, 'pending')).filter((r) => r.pageId === legacyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.approvalId.startsWith('appr:cms:')).toBe(true);
    // Publish.
    const published = await cmsService.transitionPage(tenantId, orgId, legacyId, 'approve', 'u-m', { expectedVersion: submitted!.version });
    expect(published?.status).toBe('published');
  });
});

describe('D2 — one review row per submission', () => {
  it('two racing queues on one submitted page leave exactly one pending row', async () => {
    const tenantId = tenant();
    const p = await cmsService.createPage({ tenantId, orgId: 'org-a', title: 'Race', createdBy: 'u-a' });
    const submitted = await cmsService.transitionPage(tenantId, 'org-a', p.pageId, 'submit', 'u-a');
    expect(submitted).toBeTruthy();
    await Promise.all([
      queueContentApproval(tenantId, 'org-a', submitted!, 'one', { notify: false }),
      queueContentApproval(tenantId, 'org-a', submitted!, 'two', { notify: false }),
    ]);
    const rows = (await listApprovals(tenantId, 'pending')).filter((r) => r.kind === 'content-publish' && r.pageId === p.pageId);
    expect(rows).toHaveLength(1);
  });

  it('a reject → resubmit is a NEW review with a new row (positive control: the id is per cycle, not per page)', async () => {
    const tenantId = tenant();
    const p = await cmsService.createPage({ tenantId, orgId: 'org-a', title: 'Cycles', createdBy: 'u-a' });
    const first = await cmsService.transitionPage(tenantId, 'org-a', p.pageId, 'submit', 'u-a');
    await queueContentApproval(tenantId, 'org-a', first!, undefined, { notify: false });
    const [r1] = (await listApprovals(tenantId, 'pending')).filter((r) => r.pageId === p.pageId);
    await resolveApproval(r1!.approvalId, { status: 'rejected', decidedBy: 'u-m' });
    await cmsService.transitionPage(tenantId, 'org-a', p.pageId, 'reject', 'u-m');
    const second = await cmsService.transitionPage(tenantId, 'org-a', p.pageId, 'submit', 'u-a');
    expect(second?.reviewCycle).toBe(2);
    await queueContentApproval(tenantId, 'org-a', second!, undefined, { notify: false });
    const [r2] = (await listApprovals(tenantId, 'pending')).filter((r) => r.pageId === p.pageId);
    expect(r2?.approvalId).toBeTruthy();
    expect(r2!.approvalId).not.toBe(r1!.approvalId);
  });
});

describe('D3/D4 — an actorless run records its cause apart from its submitter (code grade CMSA2CD-1)', () => {
  it('the causing member narrows (submitterCauses) and is never a submitter (notified)', async () => {
    const tenantId = tenant();
    const p = await cmsService.createPage({ tenantId, orgId: 'org-a', title: 'By a run', createdBy: 'u-a' });
    const caused = buildCmsSurface({ tenantId, orgScopeSubject: 'user:poster' } as Parameters<typeof buildCmsSurface>[0]);
    await caused.submitPage!({ orgId: 'org-a', pageId: p.pageId });
    const [row] = (await listApprovals(tenantId, 'pending')).filter((r) => r.pageId === p.pageId);
    expect(row?.submitterCauses).toEqual(['user:poster']);
    expect(row?.submitters).toBeUndefined();

    const p2 = await cmsService.createPage({ tenantId, orgId: 'org-a', title: 'By an actor', createdBy: 'u-a' });
    const acted = buildCmsSurface({ tenantId, actingUserId: 'user:actor', orgScopeSubject: 'user:poster' } as Parameters<typeof buildCmsSurface>[0]);
    await acted.submitPage!({ orgId: 'org-a', pageId: p2.pageId });
    const [row2] = (await listApprovals(tenantId, 'pending')).filter((r) => r.pageId === p2.pageId);
    expect(row2?.submitters).toEqual(['user:actor']);
    expect(row2?.submitterCauses).toBeUndefined();
  });
});

describe('D3/D4 — submitters are subject data, and erasure redacts them per element', () => {
  it('erasing one submitter replaces only that entry, causes included', async () => {
    const tenantId = tenant();
    const row = await createContentApproval({ tenantId, orgId: 'org-a', pageId: 'page:erase-1', pageTitle: 'E', proposal: 'p', submitters: ['user:ann', 'user:bob'], submitterCauses: ['user:ann'] });
    await eraseApprovalSubject(tenantId, 'user:ann');
    const after = await getApproval(row.approvalId);
    expect(after?.submitters).toEqual([ERASED_SUBJECT_SENTINEL, 'user:bob']);
    expect(after?.submitterCauses).toEqual([ERASED_SUBJECT_SENTINEL]);
  });
});

describe('D6 — the page\'s latest decision survives pruning', () => {
  it('100 newer resolved approvals of another kind do not erase the page\'s review', async () => {
    const tenantId = tenant();
    const p = await cmsService.createPage({ tenantId, orgId: 'org-a', title: 'Old review', createdBy: 'u-a' });
    const row = await createContentApproval({ tenantId, orgId: 'org-a', pageId: p.pageId, pageTitle: 'Old review', proposal: 'Publish' });
    await resolveApproval(row.approvalId, { status: 'rejected', decidedBy: 'u-m', note: 'Fix the hero' });
    for (let i = 0; i < 101; i += 1) {
      const other = await createContentApproval({ tenantId, orgId: 'org-a', pageId: `page:other-${i}`, pageTitle: `o${i}`, proposal: 'x' });
      await resolveApproval(other.approvalId, { status: 'approved', decidedBy: 'u-m' });
    }
    const latest = await findLatestContentApprovalForPage(tenantId, p.pageId);
    expect(latest?.note).toBe('Fix the hero');
  });

  it('pruning still deletes the rows past the cap that are NOT a page\'s newest (positive control)', async () => {
    const tenantId = tenant();
    const old = await createContentApproval({ tenantId, orgId: 'org-a', pageId: 'page:same', pageTitle: 's', proposal: 'x' });
    await resolveApproval(old.approvalId, { status: 'rejected', decidedBy: 'u-m' });
    const newer = await createContentApproval({ tenantId, orgId: 'org-a', pageId: 'page:same', pageTitle: 's', proposal: 'x' });
    await resolveApproval(newer.approvalId, { status: 'approved', decidedBy: 'u-m' });
    for (let i = 0; i < 101; i += 1) {
      const other = await createContentApproval({ tenantId, orgId: 'org-a', pageId: `page:o-${i}`, pageTitle: `o${i}`, proposal: 'x' });
      await resolveApproval(other.approvalId, { status: 'approved', decidedBy: 'u-m' });
    }
    expect(await getApproval(old.approvalId), 'the superseded review of the same page must still be pruned').toBeNull();
    expect((await getApproval(newer.approvalId))?.status).toBe('approved');
  });
});

describe('D5 — ADR 0594 D2 tripwire: no CMS lane can widen what an entity section shows', () => {
  // ADR 0594 accepted that an approved page's entity sections change after approval,
  // BECAUSE the referenced store's own admin-tier publication gate governs them. That is
  // only true while no CMS lane can open that gate. This pins it (ADR 0594 § Falsifiability 1).
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

  it('no CMS source writes an entity type, publicRead or neverPublic', () => {
    const offenders = walk(join(SRC, 'features/cms'))
      .filter((p) => /updateEntityType\(|publicRead\s*:|neverPublic/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(SRC.length));
    expect(offenders).toEqual([]);
  });

  it('the callers of updateEntityType are a closed set (the demo seed is a NAMED exemption)', () => {
    const callers = walk(SRC)
      .filter((p) => readFileSync(p, 'utf8').includes('updateEntityType('))
      .map((p) => p.slice(SRC.length))
      .sort();
    // `host/demoContentMarketingSeed.ts` flips `cms.page` publicRead for the demo tenant's
    // blog list — a host seed acting as the admin, not a CMS lane. A new caller must be
    // judged against ADR 0594 before it is added here.
    expect(callers).toEqual([
      'features/entities/entitiesService.ts',
      'features/entities/routes.ts',
      'features/job-search/boards/listing.ts',
      'features/kicktodo-community/creatorProfileProjection.ts',
      'features/kicktodo-community/reviewProjection.ts',
      'host/demoContentMarketingSeed.ts',
      'host/demoEntitiesSeed.ts',
    ]);
  });

  it('the entities type PATCH (the publicRead flip) stays admin-tier', () => {
    const routes = readFileSync(join(SRC, 'features/entities/routes.ts'), 'utf8');
    const at = routes.indexOf('app.patch(`${BASE}/types/:name`');
    expect(at).toBeGreaterThan(-1);
    expect(routes.slice(at, at + 300)).toContain("requireEntitiesScope(req, 'host:members:manage')");
  });
});
