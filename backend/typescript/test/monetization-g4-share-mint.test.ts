/**
 * ADR 0820 G4 — a member share-link MINT resolves the owning feature through
 * `resolveOne` (toggle + plan); the host's own visitor mints keep the toggle-only
 * gate. Observed RED on unmodified source: the free tenant minted a public link
 * to a slides canvas. Harness: `monetizationGateHarness.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { createLink } from '../src/features/sharing/sharingService.js';
import { useMonetizationHarness, FREE_TENANT, OPERATOR_TENANT, workspace } from './monetizationGateHarness.js';

useMonetizationHarness();

describe('G4 — a member share-link MINT needs the owning feature\'s plan, not only its toggle', () => {
  it('the free tenant cannot mint a public link to a slides canvas; the operator can', async () => {
    const free = await workspace(FREE_TENANT);
    const deck = await createCanvasForTenant(FREE_TENANT, { canvasTypeId: 'canvas.slides', name: 'Deck' });
    const refused = await free.post(`/host/openwop-app/sharing/orgs/${encodeURIComponent(free.orgId)}/links`, { resourceType: 'slides_canvas', resourceId: deck.canvasId });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body?.details?.feature ?? refused.body?.feature).toBe('slides');

    const op = await workspace(OPERATOR_TENANT);
    const opDeck = await createCanvasForTenant(OPERATOR_TENANT, { canvasTypeId: 'canvas.slides', name: 'Deck' });
    const minted = await op.post(`/host/openwop-app/sharing/orgs/${encodeURIComponent(op.orgId)}/links`, { resourceType: 'slides_canvas', resourceId: opDeck.canvasId });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    expect(typeof minted.body.token).toBe('string');
  });

  it('a host-minted VISITOR link keeps the toggle-only gate (a receipt is never stranded by a lapse)', async () => {
    const free = await workspace(FREE_TENANT);
    const deck = await createCanvasForTenant(FREE_TENANT, { canvasTypeId: 'canvas.slides', name: 'Deck' });
    await expect(createLink(FREE_TENANT, free.orgId, 'system:test', { resourceType: 'slides_canvas', resourceId: deck.canvasId }, { lane: 'visitor', why: 'test' })).resolves.toMatchObject({ resourceType: 'slides_canvas' });
    // …while the default (member) lane refuses the same mint.
    await expect(createLink(FREE_TENANT, free.orgId, free.userId, { resourceType: 'slides_canvas', resourceId: deck.canvasId })).rejects.toMatchObject({ httpStatus: 403 });
  });
});
