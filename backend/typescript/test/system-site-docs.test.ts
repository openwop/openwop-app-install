/**
 * System-site docs corpus (ADR 0392 OQ-1) — the seeder: idempotent boot seed,
 * public /docs nav coverage with group ordering, never-clobber on human edit,
 * SEED_VERSION refresh of system-authored pages, and TOC-viable sections.
 *
 * The idempotency and never-clobber cases re-run the seeder as a fresh BOOT
 * (bootSeederFresh): the in-process ensure is memoized, so a second call in the
 * same module never reaches the marker check or the updatedBy freeze. What breaks
 * them: dropping the `marker?.version === SEED_VERSION` short-circuit (a current
 * corpus is rewritten) or the `updatedBy === SYSTEM_ACTOR` guard (a human edit is
 * clobbered). The seeded slug floor (16) is the measured SEEDED_DOC_SLUGS size.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { ensureSystemSiteDocs, SEEDED_DOC_SLUGS } from '../src/host/systemSiteDocs.js';
import { getPage, updatePage, listPages } from '../src/features/cms/cmsService.js';
import { SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from '../src/host/systemSite.js';
import { DurableCollection, __hostExtStorage } from '../src/host/hostExtPersistence.js';
// Static, not in-case dynamic imports: bootSeederFresh() resets the module
// registry, and a fresh kb/docs graph has none of this app's in-process state.
import { backfillDocsKb } from '../src/features/docs/docsKnowledgeService.js';
import { listDocuments } from '../src/features/kb/kbService.js';

/** The seeder's own marker namespace (systemSiteDocs.ts `seedMarker`). A second
 *  handle over the same namespace reads and deletes the same row. */
const seedMarker = new DurableCollection<{ id: string; version: number }>('systemsite:docs-seed', (r) => r.id);

/**
 * A fresh BOOT of the seeder. `ensureSystemSiteDocs` is memoized for the life of
 * the module, so calling it again in-process never re-enters `doEnsure` (that is
 * why the old idempotency and never-clobber cases could not fail: probes
 * 8fw3g3-ssd-marker and -ssd-freeze were vacuous). A redeploy is a new process:
 * re-import the module graph, bind the fresh persistence module to THIS store,
 * and run the fresh instance's ensure.
 */
async function bootSeederFresh(): Promise<void> {
  const store = __hostExtStorage();
  if (!store) throw new Error('host-ext persistence is not initialised');
  vi.resetModules();
  const persistence = await import('../src/host/hostExtPersistence.js');
  persistence.initHostExtPersistence(store);
  const fresh = await import('../src/host/systemSiteDocs.js');
  await fresh.ensureSystemSiteDocs();
}

const QUICKSTART = 'page:host-site-docs-quickstart';
const docsCount = async (): Promise<number> =>
  (await listPages(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, { collection: 'docs' })).length;

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('docs');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  await ensureSystemSiteDocs(); // boot fires it async; await deterministically here
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('the seeded corpus', () => {
  it('publishes every seeded page into the public /docs nav, group-ordered', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/public/${SYSTEM_SITE_ORG}/docs`);
    expect(res.status).toBe(200);
    const { docs } = (await res.json()) as { docs: Array<{ slug: string; order: string }> };
    const slugs = docs.map((d) => d.slug);
    for (const s of SEEDED_DOC_SLUGS) expect(slugs).toContain(s);
    expect(slugs.length).toBeGreaterThanOrEqual(16);
    // group ordering: the WHOLE nav is sorted by its docsNav order key, so every
    // getting-started/* page sorts before work/*, business/* and reference/*.
    const orders = docs.map((d) => d.order);
    expect(orders).toEqual([...orders].sort((a, b) => a.localeCompare(b)));
    expect(orders.findIndex((o) => o.startsWith('reference/'))).toBeGreaterThan(orders.findIndex((o) => o.startsWith('getting-started/')));
  });

  it('every page is TOC-viable (≥2 headed sections) and serves publicly by slug', async () => {
    const pages = await listPages(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, { collection: 'docs', status: 'published' });
    for (const p of pages) {
      const headed = p.sections.filter((s) => typeof (s.data as { heading?: unknown }).heading === 'string');
      expect(headed.length, p.slug).toBeGreaterThanOrEqual(2);
    }
    const served = await fetch(`${BASE}/host/openwop-app/public/${SYSTEM_SITE_ORG}/pages/welcome`);
    expect(served.status).toBe(200);
  });

  it('is idempotent: a fresh boot with the marker current writes nothing and creates no duplicates', async () => {
    expect((await seedMarker.get('seed'))?.version).toBe(1); // the marker the first boot wrote
    const before = await docsCount();
    // A SYSTEM-authored drift a refresh WOULD restore, so "wrote nothing" is visible.
    await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, QUICKSTART, { title: 'Quickstart (drifted)' }, 'system');
    try {
      await bootSeederFresh();
      expect(await docsCount()).toBe(before);
      expect((await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, QUICKSTART))?.title).toBe('Quickstart (drifted)');
    } finally {
      await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, QUICKSTART, { title: 'Quickstart' }, 'system');
    }
  });

  it('never clobbers a human-edited page (updatedBy freeze) while a re-seed refreshes system pages', async () => {
    const pageId = 'page:host-site-docs-welcome';
    await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, { title: 'Welcome (edited)' }, 'user:human-admin');
    // Positive control: a system-authored page the re-seed must restore.
    await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, QUICKSTART, { title: 'Quickstart (drifted)' }, 'system');
    const before = await docsCount();
    // A redeploy with a new SEED_VERSION: drop the marker, then boot fresh.
    expect(await seedMarker.delete('seed')).toBe(true);
    await bootSeederFresh();
    const page = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId);
    expect(page?.title).toBe('Welcome (edited)');
    expect(page?.updatedBy).toBe('user:human-admin');
    expect((await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, QUICKSTART))?.title).toBe('Quickstart');
    expect(await docsCount()).toBe(before); // the re-run path creates no duplicates either
    expect((await seedMarker.get('seed'))?.version).toBe(1); // and re-writes the marker
  });

  it('enable-then-backfill lands the corpus in the KB (the documented operator flow)', async () => {
    // The boot seed fired while the docs toggle was OFF (the default), so the
    // lifecycle sync no-op'd — exactly the shipped posture. The operator flow
    // is: enable the toggle, run the backfill. Prove it lands everything.
    const out = await backfillDocsKb(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG);
    expect(out.pages).toBeGreaterThanOrEqual(16);
    const docs = await listDocuments(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, `mgd-docs-${SYSTEM_SITE_ORG}`);
    expect(docs.length).toBeGreaterThanOrEqual(16);
  });
});
