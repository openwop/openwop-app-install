/**
 * ADR 1100 D7 — alt-text spend meters to the person it is for. The service pins
 * `featureId: 'accessibility'` (source premise in `adr1100-accessibility.test.ts`);
 * this pins that each caller HANDS the person over, which a source check of the
 * service cannot see.
 *
 * Red when: the workflow surface stops passing the run's acting user; a run with
 * no acting user (a schedule) starts inventing one; the route stops passing the
 * signed-in caller.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const generateAltText = vi.hoisted(() => vi.fn(async (_t: string, _o: string, assetId: string) => ({ assetId, altText: 'A red bicycle' })));
vi.mock('../src/features/media/mediaService.js', () => ({ generateAltText }));

import { buildAccessibilitySurface } from '../src/features/accessibility/surface.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('ADR 1100 D7 — the person behind an alt-text proposal reaches the meter', () => {
  it('the workflow surface passes the run\'s acting user', async () => {
    const out = await buildAccessibilitySurface({ tenantId: 't1', runId: 'r1', actingUserId: 'user:ada' }).generateAltText!({ orgId: 'o1', assetId: 'a1' });
    expect(out).toEqual({ assetId: 'a1', altText: 'A red bicycle' });
    expect(generateAltText).toHaveBeenLastCalledWith('t1', 'o1', 'a1', { actingSubject: 'user:ada' });
  });

  it('a run with no acting user names nobody', async () => {
    await buildAccessibilitySurface({ tenantId: 't1', runId: 'r2' }).generateAltText!({ orgId: 'o1', assetId: 'a2' });
    expect(generateAltText).toHaveBeenLastCalledWith('t1', 'o1', 'a2', {});
  });

  it('the HTTP route passes the signed-in caller', () => {
    // The route is a thin handler over `authorize`; its call is the contract.
    const src = readFileSync(join(here, '../src/features/media/routes.ts'), 'utf8');
    expect(src).toContain("generateAltText(tenantId, orgId, req.params.assetId, { actingSubject: user.userId })");
  });
});
