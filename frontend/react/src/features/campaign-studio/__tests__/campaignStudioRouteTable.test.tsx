/**
 * ADR 0941 D5 — the `/campaign-studio` route rule.
 *
 *   - `/campaign-studio` is the console hub; new surfaces sit two segments deep
 *     (`/plans/:canvasId`, `/campaigns/:campaignId`);
 *   - the ONLY one-segment child is the redirect for pre-0941 plan URLs, and it
 *     accepts a canvas-id shape or `new` and nothing else (so it can never
 *     swallow a reserved word like `campaigns` or a future child);
 *   - the redirect keeps the query (`?fromArtifact=` on `new`).
 *
 * Sabotage: re-adding the editor at `/campaign-studio/:canvasId` reds the
 * route-table case; loosening PLAN_ID_SHAPE to `.+` reds the reserved-word
 * case; dropping `${search}` reds the query case.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { FEATURES } from '../../../chrome/features.js';
import { PLAN_ID_SHAPE, PlanRedirect } from '../PlanRedirect.js';

afterEach(cleanup);

const children = FEATURES.map((r) => r.path).filter((p) => p.startsWith('/campaign-studio/'));
const oneSegment = children.filter((p) => p.split('/').filter(Boolean).length === 2);

describe('ADR 0941 D5 — /campaign-studio children', () => {
  it('the only one-segment child is the plan redirect; plans and campaigns are two segments deep', () => {
    expect(oneSegment).toEqual(['/campaign-studio/:canvasId']);
    expect(children).toEqual(expect.arrayContaining(['/campaign-studio/plans/:canvasId', '/campaign-studio/campaigns/:campaignId']));
    const redirect = FEATURES.find((r) => r.path === '/campaign-studio/:canvasId');
    expect(redirect?.ownerFeatureId).toBe('campaign-studio');
  });

  it('the redirect accepts only a canvas-id shape or `new`', () => {
    for (const ok of ['new', 'canvas-3f1c2a9e-1b2c-4d5e-8f90-123456789abc']) expect(PLAN_ID_SHAPE.test(ok), ok).toBe(true);
    for (const reserved of ['campaigns', 'clients', 'plans', 'autonomy', 'canvas-', 'canvas-a/b', '']) expect(PLAN_ID_SHAPE.test(reserved), reserved).toBe(false);
  });
});

function Where(): JSX.Element {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>;
}

function at(url: string): string {
  const { getByTestId } = render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/campaign-studio/:canvasId" element={<PlanRedirect />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  const where = getByTestId('where').textContent ?? '';
  cleanup();
  return where;
}

describe('ADR 0941 D5 — the plan redirect', () => {
  it('sends an old plan URL to /plans, keeping the query', () => {
    expect(at('/campaign-studio/canvas-abc123')).toBe('/campaign-studio/plans/canvas-abc123');
    expect(at('/campaign-studio/new?fromArtifact=run-1%3Anode-2')).toBe('/campaign-studio/plans/new?fromArtifact=run-1%3Anode-2');
  });
  it('sends anything else to the console hub', () => {
    expect(at('/campaign-studio/autonomy')).toBe('/campaign-studio');
  });
});
