/**
 * Follow-up Phase B — content/CDP delete-cascade closure.
 *  - deletePage now cascades its CMS children (pageversion / redirect / pageexperiment).
 *    Tested here via experiments (versions + redirects use the identical
 *    filter-by-page + delete pattern in the same function).
 *  - deleteCampaign fires an `onCampaignDeleted` seam (host/campaignLifecycle) that
 *    campaign-connectors (perf) + campaign-intel (pacing) subscribe to — so those sibling
 *    features prune their own per-campaign rows without a reverse-import. Tested here at
 *    the seam-contract level (the boundary-correct mechanism).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createPage, deletePage } from '../src/features/cms/cmsService.js';
import { createExperiment, listExperiments } from '../src/features/cms/pageExperimentsService.js';
import { onCampaignDeleted, fireCampaignDeleted, __resetCampaignLifecycleHooks } from '../src/host/campaignLifecycle.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('deletePage — cascades its CMS children', () => {
  it('removes the page`s experiments (and a sibling page`s are untouched)', async () => {
    const tenantId = `org:cdc-${Date.now()}`;
    const orgId = 'org-cdc';
    const variants = [{ key: 'a', weight: 50 }, { key: 'b', weight: 50 }];
    const pageA = await createPage({ tenantId, orgId, title: 'A', createdBy: 'u' });
    const pageB = await createPage({ tenantId, orgId, title: 'B', createdBy: 'u' });
    await createExperiment({ tenantId, orgId, pageId: pageA.pageId, name: 'expA', variants, createdBy: 'u' });
    await createExperiment({ tenantId, orgId, pageId: pageB.pageId, name: 'expB', variants, createdBy: 'u' });
    expect(await listExperiments(tenantId, orgId, pageA.pageId)).toHaveLength(1);

    expect(await deletePage(tenantId, orgId, pageA.pageId)).toBe(true);

    expect(await listExperiments(tenantId, orgId, pageA.pageId)).toHaveLength(0); // cascaded
    expect(await listExperiments(tenantId, orgId, pageB.pageId)).toHaveLength(1); // sibling untouched
  });
});

describe('campaign delete seam (host/campaignLifecycle)', () => {
  beforeEach(() => { __resetCampaignLifecycleHooks(); });

  it('fires every registered handler best-effort; a throwing handler never blocks the others', async () => {
    const ran: string[] = [];
    onCampaignDeleted('ok-1', async () => { ran.push('ok-1'); });
    onCampaignDeleted('boom', async () => { throw new Error('cleanup failed'); });
    onCampaignDeleted('ok-2', async () => { ran.push('ok-2'); });

    const count = await fireCampaignDeleted({ tenantId: 't', orgId: 'o', campaignId: 'c-1' });
    expect(count).toBe(2); // ok-1 + ok-2 ran; boom swallowed
    expect(ran.sort()).toEqual(['ok-1', 'ok-2']);
  });

  it('registrations are KEYED — a re-registered key overwrites (idempotent across boots)', async () => {
    let calls = 0;
    onCampaignDeleted('dupe', async () => { calls += 1; });
    onCampaignDeleted('dupe', async () => { calls += 1; }); // same key → replaces
    await fireCampaignDeleted({ tenantId: 't', orgId: 'o', campaignId: 'c-2' });
    expect(calls).toBe(1);
  });
});
