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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
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
/** `ask` returns the fenced prompt + the raw `contexts` the hits came from. */
interface AskOut { augmentedPrompt: string; citations: Array<{ documentId: string }>; contexts: Array<{ documentId: string }> }
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

  /**
   * ADR 0602 / `NBWF-1` — `topK` REACHES the retrieval, on BOTH sibling methods.
   *
   * `searchNotebook` ran its `topK` through `surfaceOptStr` (a `string|undefined`
   * coercion), so a well-typed `topK: 2` became `undefined` and `kbService.clampTopK`
   * substituted its own default fan-out — and the call still returned `status:
   * success` with a plausible-looking, WRONG-SIZED result set. Nothing observed the
   * count, so nothing went red. `ask`, twenty lines away, had the correct check
   * hand-written; the two disagreed. Both now share `surfaceOptCount`.
   *
   * NON-VACUITY FLOOR: the unbounded read must return MORE than the bound we then
   * ask for. Without that assertion a corpus of ≤2 hits would satisfy the bounded
   * expectation no matter what the surface did with `topK`.
   */
  it('(d) topK bounds the fan-out on BOTH searchNotebook and ask (NBWF-1)', async () => {
    const tenantId = 'nb-surf-topk';
    const orgId = 'org-topk';
    const nb = await createNotebook(tenantId, orgId, 'actor', { name: 'Fan-out' });
    // Six distinct sources that all match the query, so the default fan-out and a
    // topK of 2 are DISTINGUISHABLE. (One source per doc keeps hits == sources.)
    for (let i = 0; i < 6; i += 1) {
      await addSource(tenantId, nb.id, 'actor', { title: `Whales ${i}`, text: `Whales are large marine mammals that sing, note ${i}.` });
    }
    const surface = notebooksSurface(tenantId);

    const unbounded = as<SearchOut>(await surface.searchNotebook!({ notebookId: nb.id, query: 'whales sing' }));
    // The floor. If this is ever ≤ 2 the bounded assertions below prove nothing.
    expect(unbounded.hits.length, 'the unbounded read must exceed the bound for this test to discriminate').toBeGreaterThan(2);

    const bounded = as<SearchOut>(await surface.searchNotebook!({ notebookId: nb.id, query: 'whales sing', topK: 2 }));
    expect(bounded.hits.length).toBe(2);
    expect(bounded.citations.length).toBeGreaterThan(0);

    // The sibling that was already correct, kept as a CONTROL: the point of the fix
    // is that one shared rule now governs both, so both must move together.
    const askBounded = as<AskOut>(await surface.ask!({ notebookId: nb.id, query: 'whales sing', topK: 2 }));
    expect(askBounded.contexts.length).toBe(2);

    // ── ADR 0602 § Correction log, item C (`M6`) ─────────────────────────────
    // This block used to read:
    //     const stringy = await surface.searchNotebook!({ …, topK: '2' });
    //     expect(stringy.hits.length).toBe(unbounded.hits.length);
    // — i.e. it PINNED a silent wrong-sized success. A string `topK` fell back
    // to the host default and the call returned `status: success` with a result
    // set the caller never asked for: the same defect the rest of this test
    // exists to prevent, reached from a different input. A test that pins a
    // defect is worse than no test, because the honest fix then looks like a
    // regression. The stated reason was also a non-sequitur — the parity gate it
    // named reads static pack JSON and never observes a runtime value.
    //
    // A present-but-unusable count is now a TYPED FAILURE.
    await expect(surface.searchNotebook!({ notebookId: nb.id, query: 'whales sing', topK: '2' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(surface.ask!({ notebookId: nb.id, query: 'whales sing', topK: '2' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    // `L4`: `0.5` is not a positive count. The old predicate (`v > 0 ?
    // Math.floor(v) : undefined`) passed it and returned **0** — a latent
    // slice-index hazard shipped as a "positive count".
    await expect(surface.searchNotebook!({ notebookId: nb.id, query: 'whales sing', topK: 0.5 }))
      .rejects.toMatchObject({ code: 'validation_error' });
    // The control that keeps the three above from being satisfied by a surface
    // that rejects everything: ABSENT is still legal and still means "default".
    const absent = as<SearchOut>(await surface.searchNotebook!({ notebookId: nb.id, query: 'whales sing', topK: undefined }));
    expect(absent.hits.length).toBe(unbounded.hits.length);
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
