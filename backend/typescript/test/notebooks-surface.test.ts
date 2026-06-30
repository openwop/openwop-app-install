/**
 * ctx.features.notebooks — the read-only Research Notebooks workflow surface
 * (ADR 0084 Phase 2 / ADR 0014). Proves the feature contributes a typed
 * `ctx.features.notebooks` surface (registered by the composer at boot, bound into
 * the host bundle per run), that it reads the REAL notebooks store, and that:
 *   (a) an ORG-VISIBLE notebook's sources are listed + search finds them,
 *   (b) a PRIVATE (visibility:'private') notebook is INVISIBLE to the surface —
 *       the subjectless-run org-visibility filter (the strategy isShared precedent),
 *   (c) a foreign-tenant scope sees nothing (CTI-1).
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { createNotebook, addSource } from '../src/features/notebooks/notebooksService.js';
import { setProjectVisibility } from '../src/features/projects/projectsService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, res); });
  // notebooks + kb must be ON: the surface is toggle-gated at the seam, and a
  // notebook's sources/search ride a KB collection.
  for (const id of ['notebooks', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

// The surface contract returns Record<string, unknown>; a JSON round-trip narrows
// it to the test's expected shape without a type assertion.
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }
interface SourcesOut { sources: Array<{ documentId: string; title: string; contextLevel: string }> }
interface SourceOut { source: { documentId: string; title: string } | null }
interface SearchOut { hits: Array<{ documentId: string }>; citations: Array<{ documentId: string }> }
interface LevelsOut { levels: Array<{ sourceId: string; contextLevel: string }> }

const notebooksSurface = (tenantId: string) => buildHostSurfaceBundle({ tenantId }).features.notebooks!;

describe('ctx.features.notebooks surface', () => {
  it('(a) lists sources + search finds them for an ORG-VISIBLE notebook', async () => {
    const tenantId = 'nb-surf-a';
    const orgId = 'org-a';
    const nb = await createNotebook(tenantId, orgId, 'actor', { name: 'Research' });
    const src = await addSource(tenantId, nb.id, 'actor', { title: 'Whales', text: 'Whales are large marine mammals that sing.' });

    const surface = notebooksSurface(tenantId);
    expect(typeof surface.listSources).toBe('function');

    const listed = as<SourcesOut>(await surface.listSources!({ notebookId: nb.id }));
    expect(listed.sources.map((s) => s.documentId)).toContain(src.documentId);
    expect(listed.sources.find((s) => s.documentId === src.documentId)?.contextLevel).toBe('full');

    const got = as<SourceOut>(await surface.getSource!({ notebookId: nb.id, sourceId: src.documentId }));
    expect(got.source?.title).toBe('Whales');

    const searched = as<SearchOut>(await surface.searchNotebook!({ notebookId: nb.id, query: 'whales sing' }));
    expect(searched.hits.map((h) => h.documentId)).toContain(src.documentId);
    expect(searched.citations.map((c) => c.documentId)).toContain(src.documentId);

    const levels = as<LevelsOut>(await surface.getContextLevels!({ notebookId: nb.id }));
    expect(levels.levels.find((l) => l.sourceId === src.documentId)?.contextLevel).toBe('full');
  });

  it('(b) a PRIVATE notebook is INVISIBLE to the surface (the org-visibility filter)', async () => {
    const tenantId = 'nb-surf-b';
    const orgId = 'org-b';
    const nb = await createNotebook(tenantId, orgId, 'actor', { name: 'Secret' });
    const src = await addSource(tenantId, nb.id, 'actor', { title: 'Hidden', text: 'Confidential member-only notes.' });

    const surface = notebooksSurface(tenantId);
    // While org-visible (default), the source is served...
    expect(as<SourcesOut>(await surface.listSources!({ notebookId: nb.id })).sources).toHaveLength(1);

    // Flip the backing project to private (member-scoped, ADR 0054 D5).
    await setProjectVisibility(tenantId, nb.id, 'private');

    // ...now the subjectless surface sees nothing for that notebook.
    expect(as<SourcesOut>(await surface.listSources!({ notebookId: nb.id })).sources).toHaveLength(0);
    expect(as<SourceOut>(await surface.getSource!({ notebookId: nb.id, sourceId: src.documentId })).source).toBeNull();
    expect(as<SearchOut>(await surface.searchNotebook!({ notebookId: nb.id, query: 'confidential' })).hits).toHaveLength(0);
    expect(as<LevelsOut>(await surface.getContextLevels!({ notebookId: nb.id })).levels).toHaveLength(0);
  });

  it('(c) a foreign-tenant scope sees nothing (CTI-1)', async () => {
    const tenantId = 'nb-surf-c';
    const orgId = 'org-c';
    const nb = await createNotebook(tenantId, orgId, 'actor', { name: 'Owned' });
    await addSource(tenantId, nb.id, 'actor', { title: 'Mine', text: 'Tenant C only.' });

    const foreign = notebooksSurface('nb-surf-other');
    expect(as<SourcesOut>(await foreign.listSources!({ notebookId: nb.id })).sources).toHaveLength(0);
    expect(as<SourceOut>(await foreign.getSource!({ notebookId: nb.id, sourceId: 'whatever' })).source).toBeNull();
    expect(as<SearchOut>(await foreign.searchNotebook!({ notebookId: nb.id, query: 'mine' })).hits).toHaveLength(0);
  });
});
