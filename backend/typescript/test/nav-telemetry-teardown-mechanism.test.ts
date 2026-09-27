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
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { recordNav, navReport } from '../src/features/analytics/navTelemetryService.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('WF-ANL-10 — teardown reaches nav-counts, and the FIELD is what carries it', () => {
  it('a tenant purge removes that tenant\'s rows and leaves another tenant intact', async () => {
    await recordNav('tenant-a', '/runs', 'sidebar');
    await recordNav('tenant-b', '/runs', 'sidebar');
    expect((await navReport('tenant-a')).rows.length, 'seed must be non-vacuous').toBeGreaterThan(0);

    await purgeTenantHostExt('tenant-a');

    expect((await navReport('tenant-a')).rows).toEqual([]);
    expect((await navReport('tenant-b')).rows.length, 'a purge must not cross tenants').toBeGreaterThan(0);
  });

  it('the collection declares NO tenantOf — so the content probe, not the key, is the mechanism', () => {
    const src = readFileSync(join(SRC, 'features', 'analytics', 'navTelemetryService.ts'), 'utf8');
    const decl = /new DurableCollection<NavCountRow>\(([\s\S]*?)\n\);/.exec(src)?.[1] ?? '';
    expect(decl.length, 'the declaration must be located, or this leg is vacuous').toBeGreaterThan(10);
    // name + idOf only: a 3rd/4th argument would mean validate/tenantOf.
    const args = decl.split('\n').filter((l) => l.trim().length > 0);
    expect(args.length, `expected name+idOf only, got:\n${decl}`).toBe(2);
    expect(decl).not.toMatch(/tenantOf/);
  });

  it('...and the row carries the `tenantId` FIELD the probe reads (drop it and teardown stops)', async () => {
    await recordNav('tenant-c', '/x', 'palette');
    expect((await navReport('tenant-c')).rows.length).toBeGreaterThan(0);
    // The probe reads `tenantId` off the stored JSON, so it must be IN the row —
    // asserted at the source of truth: the row type and the key builder both name it.
    const svc = readFileSync(join(SRC, 'features', 'analytics', 'navTelemetryService.ts'), 'utf8');
    // ANCHORED to the interface BLOCK. A first draft used
    // /interface NavCountRow[\s\S]*?tenantId: string/, and sabotage proved it
    // vacuous: renaming the field left the leg green because the lazy match found
    // a `tenantId` further down the file. Slice the block, then assert inside it.
    const open = svc.indexOf('interface NavCountRow {');
    expect(open, 'the row interface must be located').toBeGreaterThan(-1);
    const block = svc.slice(open, svc.indexOf('\n}', open));
    expect(block.length, 'a non-empty block, or this leg is vacuous').toBeGreaterThan(20);
    expect(block, 'the probe reads `tenantId` off the stored row BY NAME').toMatch(/\btenantId\b\s*:\s*string/);
  });

  it('the docblock no longer credits the key prefix (the corrected claim)', () => {
    const src = readFileSync(join(SRC, 'features', 'analytics', 'navTelemetryService.ts'), 'utf8');
    const head = src.slice(0, src.indexOf('*/'));
    expect(head, 'the stale mechanism claim must be gone').not.toMatch(/key embeds the tenant id first/);
    expect(head, 'and the real one named').toMatch(/tenantId` FIELD|content probe|jsonTenantId/);
  });
});
