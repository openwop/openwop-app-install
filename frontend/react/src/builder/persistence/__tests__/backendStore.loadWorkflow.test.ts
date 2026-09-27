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

import { loadWorkflow } from '../backendStore.js';
import { CanonicalParseError } from '../../schema/deserialize.js';

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
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for a SLOW dynamic catalog before deserializing a pack-typeId definition', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/node-catalog')) {
          // The race: the catalog resolves AFTER the definition would have.
          await new Promise((r) => setTimeout(r, 40));
          return jsonResponse(CATALOG_BODY);
        }
        if (url.includes('/workflows/')) return jsonResponse(defBody(PACK_TYPE_ID));
        return jsonResponse({}, 404);
      }),
    );

    const wf = await loadWorkflow('wf.test.1');
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
        if (url.includes('/node-catalog')) return jsonResponse(CATALOG_BODY);
        if (url.includes('/host/openwop-app/workflows')) {
          return jsonResponse({ workflows: [{ workflowId: 'wf.test.4', name: 'Webhook → Slack', nodeCount: 1, createdAt: 'x', updatedAt: 'y' }] });
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

  it('still degrades to null (local cache empty) when the backend is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(loadWorkflow('wf.test.3')).resolves.toBeNull();
  });
});
