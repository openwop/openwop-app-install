/** BUILDER-PORT-1 (ADR 0440 correction, 2026-11-07): an omitted source output
 * stays omitted, and an explicitly named one stays named, through the real store
 * history, scoped local cache, workflow duplicate, debounced autosave POST, the
 * backend validator (bounded IPC) and the head reload. The host-local
 * `canonicalSourceOutput` field never reaches the canonical POST.
 * HTTP is captured in memory; no server/app boot or external effect.
 *
 * Sabotage, each witnessed red (wave 97): `updateEdge` clearing
 * `canonicalSourceOutput`; `addEdge` normalizing a named port to default; the
 * `addEdge` duplicate check disabled; serialize leaking `canonicalSourceOutput`;
 * deserialize dropping it; `sourceOutputForWire(null)` returning the placeholder. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cancelPendingBackendSync, enqueueBuilderWrite, useBuilderStore } from '../builderStore.js';
import { loadWorkflowWithHead } from '../../persistence/backendStore.js';
import { getSavedWorkflow, duplicateSavedWorkflow } from '../../persistence/localStore.js';
import { fromCanonicalDefinition } from '../../schema/deserialize.js';
import { serializeWorkflow } from '../../schema/serialize.js';
import type { SavedWorkflow } from '../../schema/workflow.js';
import { validateBuilderDefinition } from '../../__tests__/support/builderContractClient.js';
import { config } from '../../../client/config.js';

function fixture(): SavedWorkflow {
  const parsed = fromCanonicalDefinition({ workflowId: 'wf.binding-history', nodes: [{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }], edges: [{ edgeId: 'default', sourceNodeId: 'a', targetNodeId: 'b' }] });
  return { id: 'wf.binding-history', name: 'Binding history', version: '1.0.0', createdAt: 'now', updatedAt: 'now', nodes: parsed.nodes, edges: parsed.edges };
}
const state = () => useBuilderStore.getState();
beforeEach(() => { localStorage.clear(); state().loadFromSaved(fixture()); });
afterEach(() => { cancelPendingBackendSync(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });
it('non-binding edge edits, undo/redo and workflow duplicate preserve omitted intent in cache and export', () => {
  state().updateEdge('default', { label: 'reviewed', triggerRule: 'any_success', condition: { path: 'ready', op: 'truthy' } });
  expect(state().edges[0]).toMatchObject({ canonicalSourceOutput: null, label: 'reviewed', triggerRule: 'any_success' });
  state().undo();
  expect(state().edges[0]).toMatchObject({ canonicalSourceOutput: null });
  expect(state().edges[0]).not.toHaveProperty('label');
  state().redo();
  const cached = getSavedWorkflow('wf.binding-history');
  if (!cached) throw new Error('Cache did not persist workflow');
  const copy = duplicateSavedWorkflow(cached.id);
  if (!copy) throw new Error('Workflow duplicate missing');
  expect(JSON.parse(JSON.stringify(copy)).edges).toEqual(state().edges);
  const exported = serializeWorkflow(copy);
  expect(exported.edges[0]).not.toHaveProperty('sourceOutput');
  expect(exported.edges[0]).toMatchObject({ label: 'reviewed', triggerRule: 'any_success', condition: { path: 'ready', op: 'truthy' } });
});
it('named authoring is distinct from default, dedupes exact repeated binding, and survives undo/redo', () => {
  state().addEdge({ source: 'a', sourcePort: 'output', target: 'b', targetPort: 'in' });
  state().addEdge({ source: 'a', sourcePort: 'output', target: 'b', targetPort: 'in' });
  expect(state().edges).toHaveLength(2);
  expect(serializeWorkflow(state().snapshot()).edges.map(e => e.sourceOutput)).toEqual([undefined, 'output']);
  state().undo();
  expect(state().edges).toHaveLength(1);
  state().redo();
  expect(serializeWorkflow(state().snapshot()).edges[1]).toHaveProperty('sourceOutput', 'output');
});
it('debounced real autosave POST passes real validator and head reload without leaking host metadata', async () => {
  vi.useFakeTimers();
  const posts: unknown[] = [];
  const requests: string[] = [];
  let stored: unknown = serializeWorkflow(fixture());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/node-catalog')) return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
    if (url.endsWith('/host/openwop-app/workflows') && init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Missing canonical autosave body');
      stored = JSON.parse(init.body); posts.push(stored);
      return new Response(JSON.stringify({ revision: 'r2' }), { status: 200 });
    }
    if (url.endsWith('/head')) return new Response(JSON.stringify({ definition: stored, revision: 'r2' }), { status: 200 });
    if (url.endsWith('/host/openwop-app/workflows')) return new Response(JSON.stringify({ workflows: [] }), { status: 200 });
    throw new Error('Unexpected transport: ' + url);
  }));
  state().updateNode('a', { name: 'Renamed without changing binding' });
  state().updateEdge('default', { label: 'Retained' });
  await vi.advanceTimersByTimeAsync(1500);
  await enqueueBuilderWrite(async () => undefined);
  expect(posts).toHaveLength(1);
  const canonical = posts[0];
  expect(canonical).toMatchObject({ edges: [{ edgeId: 'default', label: 'Retained' }] });
  expect(JSON.stringify(canonical)).not.toContain('canonicalSourceOutput');
  expect(JSON.stringify(canonical)).not.toContain('__openwop_');
  vi.useRealTimers(); // IPC's fixed child deadline must use a real clock.
  const validated = await validateBuilderDefinition(canonical);
  expect(validated.edges).toHaveLength(1);
  expect(validated.edges[0]).not.toHaveProperty('sourceOutput');
  const loaded = await loadWorkflowWithHead('wf.binding-history');
  if (!loaded.workflow) throw new Error('Actual head reload returned no workflow');
  expect(loaded.headRevision).toBe('r2');
  expect(loaded.workflow.nodes.find(n => n.id === 'a')?.name).toBe('Renamed without changing binding');
  expect(loaded.workflow.edges[0]).toMatchObject({ canonicalSourceOutput: null, label: 'Retained' });
  expect(serializeWorkflow(loaded.workflow).edges[0]).not.toHaveProperty('sourceOutput');
  // Exact transport, not suffix matches: one POST to the workflows collection
  // and the head read of THIS workflow id.
  const workflows = `${config.baseUrl}/host/openwop-app/workflows`;
  expect(requests.filter(r => r.startsWith('POST '))).toEqual([`POST ${workflows}`]);
  expect(requests).toContain(`GET ${workflows}/wf.binding-history/head`);
});
