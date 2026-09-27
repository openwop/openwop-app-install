/**
 * Sync-honesty contract (ADR 0434 Phase 1).
 *
 * The defect: `saveWorkflow` POSTed inside `try{}catch{}` and NEVER read
 * `res.ok`, `listWorkflows` fell back to the device-local cache on ANY error,
 * and `removeWorkflow` dropped the local copy even when the server refused.
 * So a 401 (expired session) or 429 (the documented per-IP fan-out hazard)
 * was indistinguishable from success — the row lived in exactly one browser
 * while the UI said "saved", which is how the same account showed different
 * data on different machines.
 *
 * The contract pinned here is the distinction the old code lacked:
 *   - transport failure (offline)  => local cache is HONEST, degrade quietly
 *   - server refused (4xx/5xx)     => data loss, MUST surface
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listWorkflows, removeWorkflow, saveWorkflow } from '../backendStore.js';
import { listSavedWorkflows, upsertSavedWorkflow } from '../localStore.js';
import { SyncFailureError } from '../../../client/config.js';
import type { SavedWorkflow } from '../../schema/workflow.js';

// Serialization resolves node kinds against the live node catalog, which is
// irrelevant to — and would mask — the transport-honesty contract under test.
// Stub it so every failure below is unambiguously a sync failure.
vi.mock('../../schema/serialize.js', () => ({
  serializeWorkflow: (w: { id: string; name: string }) => ({
    workflowId: w.id,
    nodes: [{ nodeId: 'n1', typeId: 'core.openwop.noop', config: {} }],
    edges: [],
    metadata: { name: w.name },
  }),
}));

function wf(id: string): SavedWorkflow {
  const now = new Date().toISOString();
  return {
    id,
    name: `wf-${id}`,
    version: '1.0.0',
    nodes: [{ id: 'n1', kind: 'noop', name: 'n1', position: { x: 0, y: 0 }, config: {} }],
    edges: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as SavedWorkflow;
}

const origFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('saveWorkflow — a refused write is surfaced, never silent', () => {
  it('THROWS SyncFailureError when the backend refuses (401)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(saveWorkflow(wf('a'))).rejects.toBeInstanceOf(SyncFailureError);
  });

  it('THROWS on 429 — the rate-limit case that silently stranded workflows', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    await expect(saveWorkflow(wf('b'))).rejects.toMatchObject({ status: 429 });
  });

  it('keeps the local copy even when it throws — the throw must not destroy work', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(saveWorkflow(wf('c'))).rejects.toBeInstanceOf(SyncFailureError);
    expect(listSavedWorkflows().map((w) => w.id)).toContain('c');
  });

  it('stays QUIET when genuinely offline — local cache is the honest answer', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    // ADR 0440 P2 gave saveWorkflow a SaveOutcome return (it now reports nodes
    // a save dropped that a run had recorded). Offline must still resolve —
    // and with an EMPTY outcome: we never reached the server, so we have
    // nothing to disclose and must not imply otherwise.
    await expect(saveWorkflow(wf('d'))).resolves.toEqual({});
    expect(listSavedWorkflows().map((w) => w.id)).toContain('d');
  });
});

describe('listWorkflows — never renders device-local drafts as the account list', () => {
  it('THROWS on 401 instead of returning this browser\'s drafts', async () => {
    upsertSavedWorkflow(wf('local-only'));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(listWorkflows()).rejects.toBeInstanceOf(SyncFailureError);
  });

  it('falls back to the local cache ONLY when offline', async () => {
    upsertSavedWorkflow(wf('local-only'));
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(listWorkflows()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'local-only' })]),
    );
  });

  // ADR 0596 §Correction 4 (`WFAU-2`) — the MIDDLE hop of "made readable".
  // The provenance chain is ownership row → wire → this projection → the chip.
  // The wire hop and the render hop each got a witness; without this one,
  // deleting the `authoredVia` line here drops the chip on a green suite,
  // because `listWorkflows` REBUILDS the row field by field rather than
  // spreading it — an omission here is silent by construction.
  it('carries authoredVia from the wire into the summary the dashboard renders', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        workflows: [
          { workflowId: 'authored.x', name: 'A', nodeCount: 1, createdAt: 'T', updatedAt: 'T', authoredVia: 'workflow-author' },
          { workflowId: 'plain.y', name: 'B', nodeCount: 1, createdAt: 'T', updatedAt: 'T' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const rows = await listWorkflows();
    expect(rows.find((r) => r.id === 'authored.x')?.authoredVia).toBe('workflow-author');
    // Control: absent on the wire stays absent — the projection must not invent it.
    expect(rows.find((r) => r.id === 'plain.y')?.authoredVia).toBeUndefined();
  });
});

describe('removeWorkflow — the local delete follows the server, not the other way round', () => {
  it('does NOT delete locally when the server refuses (401)', async () => {
    upsertSavedWorkflow(wf('keep'));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(removeWorkflow('keep')).rejects.toBeInstanceOf(SyncFailureError);
    expect(listSavedWorkflows().map((w) => w.id)).toContain('keep');
  });

  it('treats 404 as already-deleted and drops the local copy', async () => {
    upsertSavedWorkflow(wf('gone'));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await expect(removeWorkflow('gone')).resolves.toBeUndefined();
    expect(listSavedWorkflows().map((w) => w.id)).not.toContain('gone');
  });

  it('surfaces the domain reason on a 409 workflow_referenced', async () => {
    upsertSavedWorkflow(wf('ref'));
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ details: { reason: 'workflow_referenced' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    await expect(removeWorkflow('ref')).rejects.toMatchObject({ reason: 'workflow_referenced' });
    expect(listSavedWorkflows().map((w) => w.id)).toContain('ref');
  });

  it('still drops the local copy when offline (next sync reconciles)', async () => {
    upsertSavedWorkflow(wf('off'));
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(removeWorkflow('off')).resolves.toBeUndefined();
    expect(listSavedWorkflows().map((w) => w.id)).not.toContain('off');
  });
});
