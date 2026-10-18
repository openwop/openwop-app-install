/**
 * loadWorkflow ordering + honesty contract (day-1 UX program P2, defect D1).
 *
 * The blank-template-canvas bug: pack-instantiated definitions reference
 * pack typeIds that only resolve after the dynamic node catalog loads, but
 * loadWorkflow deserialized as soon as the definition fetch returned — the
 * unresolved typeIds threw, the broad catch swallowed it, and the caller
 * blank-minted an "Untitled workflow" over a real 4-node definition.
 *
 * Contract pinned here:
 *  1. loadWorkflow AWAITS the dynamic catalog before deserializing — a slow
 *     catalog response must not blank a template open.
 *  2. A definition the builder genuinely can't open (unknown typeId) REJECTS
 *     with CanonicalParseError — it is never silently null.
 *
 * ADR 0730 C.4 — the definition read moved from a raw `GET /v1/workflows/{id}`
 * to the shared major-2 client, so the stubs below route on `/workflows/` (no
 * `/v1` prefix). The host-extension branch is matched FIRST where both exist,
 * because `/host/openwop-app/workflows` would otherwise also match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BackendStore from '../backendStore.js';
import type * as LocalStore from '../localStore.js';
import type * as Deserialize from '../../schema/deserialize.js';
import type * as CatalogRegistry from '../../palette/catalogRegistry.js';

// `loadDynamicCatalog()` is memoized at MODULE level with no reset seam, so a
// case that ran after any other would find the catalog already loaded and could
// not observe the ordering it claims (grade-tests w47: the slow-catalog case was
// witnessed only when it happened to run first). Every case therefore gets a
// fresh module graph — and the error classes are taken from that same graph, so
// `instanceof` compares against the class the code under test actually threw.
let loadWorkflow: typeof BackendStore.loadWorkflow;
let loadWorkflowWithHead: typeof BackendStore.loadWorkflowWithHead;
let LoadOfflineError: typeof BackendStore.LoadOfflineError;
let LoadRefusedError: typeof BackendStore.LoadRefusedError;
let upsertSavedWorkflow: typeof LocalStore.upsertSavedWorkflow;
let CanonicalParseError: typeof Deserialize.CanonicalParseError;
let isDynamicCatalogLoaded: typeof CatalogRegistry.isDynamicCatalogLoaded;

const PACK_TYPE_ID = 'vendor.test.pack-node';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CATALOG_BODY = {
  nodes: [
    {
      typeId: PACK_TYPE_ID,
      version: '1.0.0',
      label: 'Pack Node',
      description: 'test pack node',
      category: 'integration',
      source: 'pack',
      packName: 'vendor.test',
    },
  ],
};

function defBody(typeId: string) {
  return {
    workflowId: 'wf.test.1',
    metadata: { name: 'Meeting Prep' },
    nodes: [{ nodeId: 'n1', typeId, config: {} }],
    edges: [],
  };
}

describe('loadWorkflow (backend-first, catalog-ordered)', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    ({ loadWorkflow, loadWorkflowWithHead, LoadOfflineError, LoadRefusedError } = await import('../backendStore.js'));
    ({ upsertSavedWorkflow } = await import('../localStore.js'));
    ({ CanonicalParseError } = await import('../../schema/deserialize.js'));
    ({ isDynamicCatalogLoaded } = await import('../../palette/catalogRegistry.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('waits for a SLOW dynamic catalog before deserializing a pack-typeId definition', async () => {
    // Precondition: this case starts with NO catalog loaded (fresh module graph),
    // or it could pass without ever observing the ordering.
    expect(isDynamicCatalogLoaded()).toBe(false);
    const order: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/head')) {
          order.push('def-read');
          return jsonResponse({}, 404); // not owned: the by-id read (ADR 0770)
        }
        if (url.includes('/node-catalog')) {
          // The race, without a wall clock: the catalog settles several
          // macrotasks later — after a definition read that did not wait for it.
          for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
          order.push('catalog-resolved');
          return jsonResponse(CATALOG_BODY);
        }
        if (url.includes('/workflows/')) return jsonResponse(defBody(PACK_TYPE_ID));
        return jsonResponse({}, 404);
      }),
    );

    const wf = await loadWorkflow('wf.test.1');
    expect(order).toEqual(['catalog-resolved', 'def-read']);
    expect(wf).not.toBeNull();
    expect(wf?.nodes).toHaveLength(1);
    expect(wf?.nodes[0]?.kind).toBe(PACK_TYPE_ID);
    expect(wf?.name).toBe('Meeting Prep');
  });

  it('REJECTS with CanonicalParseError for an unknown typeId — never a silent null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/head')) return jsonResponse({}, 404); // not owned: the by-id read (ADR 0770)
        if (url.includes('/node-catalog')) return jsonResponse(CATALOG_BODY);
        if (url.includes('/workflows/')) return jsonResponse(defBody('vendor.unknown.not-installed'));
        return jsonResponse({}, 404);
      }),
    );

    await expect(loadWorkflow('wf.test.2')).rejects.toBeInstanceOf(CanonicalParseError);
  });

  it('a builder-authored def (NO embedded name) resolves the name from the ownership summary — never "Imported workflow"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/head')) return jsonResponse({}, 404); // not owned: the by-id read (ADR 0770)
        if (url.includes('/node-catalog')) return jsonResponse(CATALOG_BODY);
        if (url.includes('/host/openwop-app/workflows')) {
          return jsonResponse({ workflows: [{ workflowId: 'wf.test.4', name: 'Webhook → Slack', nodeCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] });
        }
        if (url.includes('/workflows/')) {
          // Builder-authored: the display name lives in the ownership record,
          // NOT the canonical definition (serialize.ts omits it by design).
          return jsonResponse({ workflowId: 'wf.test.4', nodes: [{ nodeId: 'n1', typeId: PACK_TYPE_ID, config: {} }], edges: [] });
        }
        return jsonResponse({}, 404);
      }),
    );

    const wf = await loadWorkflow('wf.test.4');
    expect(wf?.name).toBe('Webhook → Slack');
  });

  it('falls back to the id (never the import fallback) when the summary is also unreadable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/head')) return jsonResponse({}, 404); // not owned: the by-id read (ADR 0770)
        if (url.includes('/node-catalog')) return jsonResponse(CATALOG_BODY);
        if (url.includes('/host/openwop-app/workflows')) return jsonResponse({}, 500);
        if (url.includes('/workflows/')) {
          return jsonResponse({ workflowId: 'wf.test.5', nodes: [{ nodeId: 'n1', typeId: PACK_TYPE_ID, config: {} }], edges: [] });
        }
        return jsonResponse({}, 404);
      }),
    );

    const wf = await loadWorkflow('wf.test.5');
    expect(wf?.name).toBe('wf.test.5');
  });

  // grade-code WBCD-1 — an OWNED workflow's content and base come from ONE
  // fresh read (`/head`), never content from the cache-first by-id route.
  it('an owned workflow loads content + head revision from the one /head read', async () => {
    const byId = vi.fn(async () => jsonResponse(defBody(PACK_TYPE_ID)));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/head')) return jsonResponse({ revision: 'rev-fresh', definition: { ...defBody(PACK_TYPE_ID), metadata: { name: 'Fresh head' } } });
      if (url.includes('/node-catalog')) return jsonResponse(CATALOG_BODY);
      return byId();
    }));
    const out = await loadWorkflowWithHead('wf.test.1');
    expect(out.headRevision).toBe('rev-fresh');
    expect(out.workflow?.name).toBe('Fresh head');
    expect(byId).not.toHaveBeenCalled();
  });

  // ADR 0770 D6 (`WBWF-5`) — this case used to pin `resolves.toBeNull()`, and
  // BuilderTab turned that null into a BLANK canvas under the real id, whose
  // first autosave overwrote the workflow. `null` now means an AUTHORITATIVE
  // not-found only; every other failure is a typed, non-null outcome.
  it('offline with no local copy REJECTS (LoadOfflineError), never null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(loadWorkflow('wf.test.3')).rejects.toBeInstanceOf(LoadOfflineError);
  });

  it('offline WITH a local copy returns that copy', async () => {
    upsertSavedWorkflow({ id: 'wf.test.4', name: 'Local draft', version: '1.0.0', nodes: [], edges: [], defaultInputs: '{}', createdAt: '', updatedAt: '' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(loadWorkflow('wf.test.4')).resolves.toMatchObject({ id: 'wf.test.4', name: 'Local draft' });
  });

  it('a REFUSED read (5xx, or a non-transport error) rejects with LoadRefusedError, even with a local copy', async () => {
    upsertSavedWorkflow({ id: 'wf.test.6', name: 'Stale local', version: '1.0.0', nodes: [], edges: [], defaultInputs: '{}', createdAt: '', updatedAt: '' });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => (String(url).includes('/node-catalog') ? jsonResponse(CATALOG_BODY) : jsonResponse({ error: 'internal_error' }, 503))));
    await expect(loadWorkflow('wf.test.6')).rejects.toBeInstanceOf(LoadRefusedError);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(loadWorkflow('wf.test.6')).rejects.toBeInstanceOf(LoadRefusedError);
  });
});
