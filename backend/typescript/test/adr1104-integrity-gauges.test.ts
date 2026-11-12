/**
 * ADR 1104 — daily integrity gauges.
 *
 *   - the host runs every registered gauge once per UTC day across instances
 *     sharing one Storage (one kv lease), and logs aggregate numbers only;
 *   - a gauge that throws is logged and does not stop the others;
 *   - `OPENWOP_INTEGRITY_GAUGES=false` turns them off;
 *   - the CMS counts (PROBE-1038-1…3) and the tutorials counts (PROBE-1038-4)
 *     find exactly the rows the data assessment asked about, and a clean page
 *     counts zero;
 *   - both features register their gauge;
 *   - a gauge's read is capped per tenant and says when it was (`listByPrefixUpTo`).
 *
 * Red when: the daily lease is removed; one failing gauge stops the rest; a
 * string reaches a gauge line; a probe stops matching its shape; a feature stops
 * registering its gauge.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __resetIntegrityGaugesForTest, integrityGaugeNames, registerIntegrityGauge, runIntegrityGaugesOnce } from '../src/host/integrityGauges.js';
import { countCmsIntegrity } from '../src/features/cms/integrityGauge.js';
import type { Page, Section } from '../src/features/cms/cmsService.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';

const DAY = 86_400_000;
let storage: Storage;
beforeAll(async () => { storage = await openStorage('memory://'); });
afterAll(async () => { await storage.close(); });

describe('runIntegrityGaugesOnce', () => {
  let out: string[] = [];
  beforeEach(() => {
    out = [];
    __resetIntegrityGaugesForTest();
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stdout.write);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetIntegrityGaugesForTest();
    delete process.env.OPENWOP_INTEGRITY_GAUGES;
  });

  it('runs once per UTC day across instances and logs numbers only', async () => {
    // A string value must never reach the line, whatever a gauge returns.
    const leaky: Record<string, number> = { found: 2 };
    Object.assign(leaky, { tenant: 'tenant-secret' });
    registerIntegrityGauge('probe', () => Promise.resolve(leaky));
    const t0 = 20_000 * DAY + 5_000;
    expect(await runIntegrityGaugesOnce(storage, t0)).toBe(true);
    expect(await runIntegrityGaugesOnce(storage, t0 + 3_600_000)).toBe(false); // second instance, same day
    const lines = out.filter((l) => l.includes('integrity_gauge'));
    expect(lines.some((l) => l.includes('"gauge":"probe"') && l.includes('"found":2'))).toBe(true);
    for (const l of lines) expect(l).not.toContain('tenant-secret');
    out = [];
    expect(await runIntegrityGaugesOnce(storage, t0 + DAY)).toBe(true);
    expect(out.some((l) => l.includes('"gauge":"probe"'))).toBe(true);
  });

  it('logs a failing gauge and still runs the next one', async () => {
    registerIntegrityGauge('broken', () => Promise.reject(new Error('boom')));
    registerIntegrityGauge('fine', () => Promise.resolve({ n: 0 }));
    expect(await runIntegrityGaugesOnce(storage, 30_000 * DAY)).toBe(true);
    expect(out.some((l) => l.includes('integrity_gauge_failed') && l.includes('"gauge":"broken"'))).toBe(true);
    expect(out.some((l) => l.includes('"gauge":"fine"') && l.includes('"n":0'))).toBe(true);
  });

  it('is off when OPENWOP_INTEGRITY_GAUGES=false, and claims nothing with no gauges', async () => {
    process.env.OPENWOP_INTEGRITY_GAUGES = 'false';
    registerIntegrityGauge('probe', () => Promise.resolve({ n: 1 }));
    expect(await runIntegrityGaugesOnce(storage, 40_000 * DAY)).toBe(false);
    delete process.env.OPENWOP_INTEGRITY_GAUGES;
    __resetIntegrityGaugesForTest();
    expect(await runIntegrityGaugesOnce(storage, 41_000 * DAY)).toBe(false);
    expect(out.some((l) => l.includes('integrity_gauge'))).toBe(false);
  });
});

const AT = '2026-11-11T00:00:00.000Z';
function page(tenantId: string, pageId: string, sections: Section[]): Page {
  return { pageId, tenantId, orgId: 'org', title: 't', slug: pageId, status: 'published', sections, version: 1, createdBy: 'u', updatedBy: 'u', createdAt: AT, updatedAt: AT };
}

describe('countCmsIntegrity (PROBE-1038-1…3)', () => {
  const steps = (states: string[]) => states.map((state, i) => ({ label: `Step ${i + 1}`, state }));

  it('counts a stale overlay state, a dormant hero flow and an oversized flow overlay', () => {
    const stale: Section = {
      sectionId: 'h1', type: 'hero',
      data: { heading: 'H', visual: 'flow', flow: { nodes: steps(['done', 'waiting']) } },
      // Written before M38-1: the overlay still says the first step is waiting.
      localizations: { es: { flow: { nodes: steps(['waiting', 'waiting']) } } },
    };
    const dormant: Section = { sectionId: 'h2', type: 'hero', data: { heading: 'H', visual: 'workflow', flow: { nodes: steps(['idle', 'idle']) } } };
    const oversized: Section = {
      sectionId: 'c1', type: 'columns',
      data: { layout: 'flow', columns: steps(['done', 'done']) },
      localizations: { fr: { columns: steps(['done', 'done', 'done', 'done', 'done', 'done', 'done']) } },
    };
    const counts = countCmsIntegrity([page('t1', 'p1', [stale, dormant]), page('t2', 'p2', [oversized])]);
    expect(counts).toMatchObject({ pages: 2, sections: 3, tenants: 2, staleItemOverlays: 1, staleItemPages: 1, dormantHeroFlows: 1, oversizedFlowOverlays: 1 });
  });

  it('counts zero on a page whose overlays follow the base', () => {
    const clean: Section = {
      sectionId: 'h', type: 'hero',
      data: { heading: 'H', visual: 'flow', flow: { nodes: steps(['done', 'waiting']) } },
      localizations: { es: { heading: 'Hola', flow: { nodes: steps(['done', 'waiting']) } } },
    };
    expect(countCmsIntegrity([page('t', 'p', [clean])])).toMatchObject({ staleItemOverlays: 0, dormantHeroFlows: 0, oversizedFlowOverlays: 0 });
  });
});

describe('both features register their gauge', () => {
  // A gauge nobody registers never runs, and nothing would go red.
  const src = (f: string): string => readFileSync(join(__dirname, '..', 'src', 'features', f), 'utf8');
  it('cms and tutorials', () => {
    expect(src('cms/feature.ts')).toContain("registerIntegrityGauge('cms', cmsIntegrityGauge)");
    expect(src('tutorials/feature.ts')).toContain("registerIntegrityGauge('tutorials', tutorialIntegrityGauge)");
    expect(integrityGaugeNames()).toEqual([]); // nothing leaked from the cases above
  });
});

describe('the per-tenant row cap (ADR 1104)', () => {
  it('reads at most the cap and says when there were more', async () => {
    initHostExtPersistence(storage);
    const col = new DurableCollection<{ id: string; tenantId: string }>('test:adr1104-cap', (r) => r.id);
    for (const id of ['t1:a', 't1:b', 't1:c', 't2:a']) await col.put({ id, tenantId: id.split(':')[0]! });
    expect(await col.listByPrefixUpTo('t1:', 2)).toMatchObject({ truncated: true, items: [{ id: 't1:a' }, { id: 't1:b' }] });
    expect((await col.listByPrefixUpTo('t1:', 3)).truncated).toBe(false);
    expect((await col.listByPrefixUpTo('t2:', 1)).items).toHaveLength(1);
  });
});
