/**
 * DATA-AB-1 (ADR 0382) — retention for abandoned App-Builder canvases.
 *
 * The purger is type-scoped to the `canvas.app-builder` slice of the SHARED canvas store,
 * uses its OWN opt-in window (`OPENWOP_APPBUILDER_CANVAS_RETENTION_DAYS`, not the shared
 * `internal` window), and keeps project-linked or live-shared designs. Drives the host seam
 * via `purgeRetained('internal', …)`; seeds canvases (controlled `updatedAt`) + share links.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { purgeRetained, __resetRetentionPurgers } from '../src/host/retentionPurger.js';
import { __putCanvasForTest, getCanvasForTenant } from '../src/host/canvasSurface.js';
import { registerAppBuilderCanvasRetention } from '../src/features/app-builder/canvasRetention.js';
import { APP_BUILDER_CANVAS_TYPE } from '../src/features/app-builder/componentCatalog.js';
import type { Storage } from '../src/storage/storage.js';

const T = 'tA';
const DAY = 86_400_000;
const OLD = new Date(Date.now() - 400 * DAY).toISOString();   // well past any window
const FRESH = new Date(Date.now() - 1 * DAY).toISOString();

// Minimal share-link row over the REAL collection name. Must pass the sharing
// store's read-validation (sharingService.ts:396), which since ADR 0448 requires
// `tokenHash` (links are keyed + stored HASHED, not by the raw token) + tenantId +
// orgId + resourceType + resourceId + revoked — a row missing `tokenHash` is
// dropped by `links.list()`, so the live-link protection would never see it.
interface LinkSeed { tokenHash: string; tenantId: string; orgId: string; resourceType: string; resourceId: string; revoked: boolean; createdBy: string; createdAt: string; expiresAt?: string }
const linkCol = () => new DurableCollection<LinkSeed>('sharing:link', (l) => l.tokenHash);
async function seedLink(canvasId: string, over: Partial<LinkSeed> = {}): Promise<void> {
  await linkCol().put({ tokenHash: `hash-${canvasId}`, tenantId: T, orgId: 'org', resourceType: 'app_builder_canvas', resourceId: canvasId, revoked: false, createdBy: 'u', createdAt: FRESH, ...over });
}
const putCanvas = (canvasId: string, over: { canvasTypeId?: string; projectId?: string; updatedAt?: string } = {}) =>
  __putCanvasForTest({ canvasId, tenantId: T, canvasTypeId: over.canvasTypeId ?? APP_BUILDER_CANVAS_TYPE, state: {}, updatedAt: over.updatedAt ?? OLD, ...(over.projectId ? { projectId: over.projectId } : {}) });

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __resetRetentionPurgers();
  registerAppBuilderCanvasRetention();
  process.env.OPENWOP_APPBUILDER_CANVAS_RETENTION_DAYS = '30';
});
afterEach(() => { delete process.env.OPENWOP_APPBUILDER_CANVAS_RETENTION_DAYS; });

const purge = () => purgeRetained(T, 'internal', new Date().toISOString());

describe('DATA-AB-1 — app-builder canvas retention', () => {
  it('purges an abandoned canvas (old, no project, no link); keeps a freshly-edited one', async () => {
    await putCanvas('ab-old', { updatedAt: OLD });
    await putCanvas('ab-fresh', { updatedAt: FRESH });
    const res = await purge();
    expect(res.find((r) => r.feature === 'app-builder:canvas')).toMatchObject({ deleted: 1, ok: true });
    expect(await getCanvasForTenant(T, 'ab-old')).toBeNull();
    expect(await getCanvasForTenant(T, 'ab-fresh')).not.toBeNull();
  });

  it('KEEPS a project-linked canvas even when abandoned', async () => {
    await putCanvas('ab-proj', { updatedAt: OLD, projectId: 'proj-1' });
    await purge();
    expect(await getCanvasForTenant(T, 'ab-proj')).not.toBeNull();
  });

  it('KEEPS a canvas with a live share link; PURGES one whose only link is revoked or expired', async () => {
    await putCanvas('ab-shared', { updatedAt: OLD });
    await seedLink('ab-shared'); // live link
    await putCanvas('ab-deadlink', { updatedAt: OLD });
    await seedLink('ab-deadlink', { revoked: true }); // dead link ⇒ no protection
    await putCanvas('ab-expired', { updatedAt: OLD });
    await seedLink('ab-expired', { expiresAt: OLD }); // expired ⇒ no protection

    await purge();
    expect(await getCanvasForTenant(T, 'ab-shared')).not.toBeNull();  // live share survives
    expect(await getCanvasForTenant(T, 'ab-deadlink')).toBeNull();    // revoked link doesn't protect
    expect(await getCanvasForTenant(T, 'ab-expired')).toBeNull();     // expired link doesn't protect
  });

  it('NEVER touches other canvas types in the shared store (documents/slides)', async () => {
    await putCanvas('doc-old', { canvasTypeId: 'canvas.document', updatedAt: OLD });
    await putCanvas('slide-old', { canvasTypeId: 'canvas.slides', updatedAt: OLD });
    await purge();
    expect(await getCanvasForTenant(T, 'doc-old')).not.toBeNull();
    expect(await getCanvasForTenant(T, 'slide-old')).not.toBeNull();
  });

  it('is opt-in on its OWN window — no env ⇒ nothing purged even under an internal sweep', async () => {
    delete process.env.OPENWOP_APPBUILDER_CANVAS_RETENTION_DAYS;
    await putCanvas('ab-old', { updatedAt: OLD });
    const res = await purge();
    expect(res.find((r) => r.feature === 'app-builder:canvas')?.deleted).toBe(0);
    expect(await getCanvasForTenant(T, 'ab-old')).not.toBeNull();
  });
});
