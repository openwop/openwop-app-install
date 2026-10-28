/**
 * ADR 0948 D2 test fixture — a PUBLISHED funnel with real offers, written through
 * the funnels service (the same validation the routes run). A public checkout or
 * one-click that names a funnel step now needs a real published step of that org,
 * so suites that used made-up ids (`fn-1`, `fn-oc`) build one here instead.
 */
import { createPage } from '../../src/features/cms/cmsService.js';
import { createFunnel, publishFunnel, type FunnelOffer, type FunnelStepKind } from '../../src/features/funnels/funnelsService.js';

export interface FixtureStep { kind: FunnelStepKind; offer?: FunnelOffer }

export async function publishedFunnel(
  tenantId: string, orgId: string, steps: FixtureStep[],
): Promise<{ funnelId: string; stepIds: string[] }> {
  const withPages = [];
  for (const [i, st] of steps.entries()) {
    const page = await createPage({ tenantId, orgId, title: `Fixture step ${i + 1}`, createdBy: 'test' });
    withPages.push({ kind: st.kind, pageId: page.pageId, ...(st.offer ? { offer: st.offer } : {}) });
  }
  const f = await createFunnel({ tenantId, orgId, createdBy: 'test', name: `Fixture funnel ${Date.now()}-${Math.random()}`, steps: withPages });
  const pub = await publishFunnel(tenantId, orgId, f.funnelId);
  if (pub?.status !== 'published') throw new Error('fixture funnel did not publish');
  return { funnelId: f.funnelId, stepIds: f.steps.map((s) => s.stepId) };
}
