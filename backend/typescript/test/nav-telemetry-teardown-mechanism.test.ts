/**
 * WF-ANL-10 — nav telemetry's teardown works, but NOT by the mechanism its own
 * docblock credits.
 *
 * `navTelemetryService.ts` used to say: "The key embeds the tenant id first …
 * so the ADR 0284 tenant teardown sweeps these rows with everything else."
 * MEASURED: the collection is constructed with TWO arguments — name + idOf — and
 * therefore declares **no `tenantOf`** (the 4th ctor param,
 * `hostExtPersistence.ts:272`). So `purgeTenantRows:549` takes the else branch:
 *
 *     const rowTenant = row !== null && this.tenantOf ? this.tenantOf(row) : jsonTenantId(parsed);
 *
 * i.e. a JSON CONTENT PROBE on the row's `tenantId` FIELD. The key shape is
 * irrelevant to teardown; the FIELD is load-bearing.
 *
 * That makes the old docblock a maintenance trap with a direction: reordering the
 * key is harmless, while dropping or renaming `tenantId` silently breaks teardown
 * — and the documented reason would still "read" as satisfied. These legs pin the
 * mechanism that actually carries it. `analytics:identity-link`
 * (`identityLinkService.ts:41`) has the identical shape and is covered too.
 *
 * w35 (grade-tests): the legs that read SOURCE TEXT (the constructor's argument
 * count, the interface block) now read STORED ROWS instead. The first of them
 * failed on a harmless improvement (declaring `tenantOf: r => r.tenantId`); the
 * invariant is that every stored row carries its tenant and a purge reaches all
 * of them, whatever the collection declares.
 * Sabotage witnesses: the purge's content probe returning undefined (legs 1, 2,
 * 5), a purge that ignores the tenant (legs 1, 5), the stored field written as
 * another tenant (leg 3), the docblock reverted (leg 4).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { recordNav, navReport } from '../src/features/analytics/navTelemetryService.js';
import { linkSession, contactForSession } from '../src/features/analytics/identityLinkService.js';
import type { Storage } from '../src/storage/storage.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

/** Every nav-count row as STORED (raw JSON), not as the report projects it. */
async function storedNavRows(): Promise<Array<{ key: string; row: { tenantId?: unknown } }>> {
  return (await storage.kvList('hostext:analytics:nav-counts:'))
    .map(({ key, value }) => ({ key, row: JSON.parse(value) as { tenantId?: unknown } }));
}

describe('WF-ANL-10 — teardown reaches nav-counts, and the FIELD is what carries it', () => {
  it('a tenant purge removes that tenant\'s rows and leaves another tenant intact', async () => {
    await recordNav('tenant-a', '/runs', 'sidebar');
    await recordNav('tenant-b', '/runs', 'sidebar');
    expect((await navReport('tenant-a')).rows.length, 'seed must be non-vacuous').toBeGreaterThan(0);

    await purgeTenantHostExt('tenant-a');

    expect((await navReport('tenant-a')).rows).toEqual([]);
    expect((await navReport('tenant-b')).rows.length, 'a purge must not cross tenants').toBeGreaterThan(0);
  });

  it('a purge reaches EVERY row the tenant wrote, old weeks included (read back from the raw store)', async () => {
    // `navReport` only reads the recent weeks, so it cannot show an old week was
    // swept. Whatever the collection declares (a content probe today, a tenantOf
    // tomorrow), no stored row of the purged tenant may survive.
    await recordNav('tenant-a', '/runs', 'sidebar', new Date('2020-01-08T00:00:00.000Z'));
    await recordNav('tenant-a', '/crm', 'palette', new Date('2021-06-15T00:00:00.000Z'));
    await recordNav('tenant-a', '/runs', 'hub');
    await recordNav('tenant-b', '/runs', 'hub', new Date('2020-01-08T00:00:00.000Z'));
    expect((await storedNavRows()).filter((r) => r.row.tenantId === 'tenant-a'), 'seed').toHaveLength(3);

    await purgeTenantHostExt('tenant-a');

    const left = await storedNavRows();
    expect(left.filter((r) => r.row.tenantId === 'tenant-a' || r.key.includes('tenant-a'))).toEqual([]);
    expect(left.map((r) => r.row.tenantId)).toEqual(['tenant-b']);
  });

  it('...and every STORED row carries the `tenantId` FIELD the probe reads (drop it and teardown stops)', async () => {
    await recordNav('tenant-c', '/x', 'palette');
    await recordNav('tenant-c', '/y', 'sidebar');
    const rows = await storedNavRows();
    expect(rows, 'the seed must be stored').toHaveLength(2);
    // The content probe reads `tenantId` off the stored JSON BY NAME.
    for (const { row } of rows) expect(row.tenantId).toBe('tenant-c');
  });

  it('the docblock no longer credits the key prefix (the corrected claim)', () => {
    const src = readFileSync(join(SRC, 'features', 'analytics', 'navTelemetryService.ts'), 'utf8');
    const head = src.slice(0, src.indexOf('*/'));
    expect(head, 'the stale mechanism claim must be gone').not.toMatch(/key embeds the tenant id first/);
    expect(head, 'and the real one named').toMatch(/tenantId` FIELD|content probe|jsonTenantId/);
  });

  it('analytics:identity-link has the same shape: a purge removes that tenant\'s links and keeps another tenant\'s', async () => {
    expect(await linkSession('tenant-a', 'vk-sess-a1', 'contact-a', 'form-submit')).not.toBeNull();
    expect(await linkSession('tenant-b', 'vk-sess-b1', 'contact-b', 'email-click')).not.toBeNull();
    expect(await contactForSession('tenant-a', 'vk-sess-a1'), 'seed').toBe('contact-a');

    await purgeTenantHostExt('tenant-a');

    expect(await contactForSession('tenant-a', 'vk-sess-a1')).toBeNull();
    expect(await contactForSession('tenant-b', 'vk-sess-b1'), 'a purge must not cross tenants').toBe('contact-b');
    const raw = await storage.kvList('hostext:analytics:identity-link:');
    expect(raw.map(({ value }) => (JSON.parse(value) as { tenantId: string }).tenantId)).toEqual(['tenant-b']);
  });
});
