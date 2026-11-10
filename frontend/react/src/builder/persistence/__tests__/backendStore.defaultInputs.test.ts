/** ADR 0440 / 0523 §WF-BLD-2 correction: editor defaults survive the actual
 * save/head-read boundary. All HTTP is local in-memory transport; values are controlled
 * nonsecret fixtures. The metadata half is checked by the real backend validator over
 * the builder contract helper (IPC, no backend TS import).
 * Breaks if: the editor leaf is not written into `customProperties['openwop-app.builder']`;
 * a blank editor value falls back to legacy top-level defaults on read; the backend
 * validator drops metadata; a malformed reserved slot is overwritten instead of refused;
 * `lifecycle` leaks from an import; an older writer without a defaults string rewrites
 * the leaf; a save mutates the caller's metadata. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveWorkflow, loadWorkflowWithHead } from '../backendStore.js';
import { getSavedWorkflow } from '../localStore.js';
import { fromCanonicalDefinition } from '../../schema/deserialize.js';
import { definitionMetadataFor, stripBuilderOwnedKeys } from '../definitionMetadata.js';
import { validateBuilderDefinition } from '../../__tests__/support/builderContractClient.js';
import type { SavedWorkflow } from '../../schema/workflow.js';

const namespace = 'openwop-app.builder';
const metadata = { customProperties: { other: { keep: true }, [namespace]: { sibling: 'keep' } }, walkthrough: true };
function workflow(raw: string, carried: Record<string, unknown> = metadata): SavedWorkflow {
  return { id: 'wf.qa-default-inputs', name: 'Retained name', version: '1.0.0', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', defaultInputs: raw, metadata: carried,
    nodes: [{ id: 'n1', kind: 'noop', name: 'No op', position: { x: 0, y: 0 }, config: {} }], edges: [] };
}
let posted: Record<string, unknown> | undefined;
const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/node-catalog')) return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
  if (init?.method === 'POST' && url.endsWith('/workflows')) {
    posted = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ revision: 'local-head', workflowId: 'wf.qa-default-inputs' }), { status: 200 });
  }
  if (url.endsWith('/wf.qa-default-inputs/head')) return new Response(JSON.stringify({ definition: posted, revision: 'local-head' }), { status: 200 });
  throw new Error(`Unexpected local test request ${url}`);
});
beforeEach(() => { localStorage.clear(); posted = undefined; transport.mockClear(); vi.stubGlobal('fetch', transport); });
afterEach(() => vi.unstubAllGlobals());

describe('raw editor defaults, including explicit clears and invalid partial edits', () => {
  it.each(['{\n  "query": "controlled", "topK": 8\n}', '{"partial":', '', '{}'])('round-trips raw %j without changing unknown metadata', async raw => {
    const wf = workflow(raw, structuredClone(metadata));
    const before = JSON.stringify(wf.metadata);
    await saveWorkflow(wf);
    expect(getSavedWorkflow(wf.id)?.defaultInputs).toBe(raw);
    expect(posted).not.toHaveProperty('defaultInputs');
    if (!posted) throw new Error('Save must produce a definition');
    expect((await validateBuilderDefinition(posted)).metadata).toEqual(posted.metadata);
    expect(posted?.metadata).toEqual({ ...metadata, name: wf.name, customProperties: { ...metadata.customProperties, [namespace]: { sibling: 'keep', defaultInputs: raw } } });
    const result = await loadWorkflowWithHead(wf.id);
    expect(result.workflow?.defaultInputs).toBe(raw);
    expect(result.workflow?.name).toBe(wf.name);
    expect(JSON.stringify(wf.metadata)).toBe(before);
  });

  it('authoritative blank metadata overrides legacy top-level defaults', () => {
    const result = fromCanonicalDefinition({ nodes: [{ nodeId: 'n1', typeId: 'core.noop' }], defaultInputs: { stale: true }, metadata: { customProperties: { [namespace]: { defaultInputs: '' } } } });
    expect(result.defaultInputs).toBe('');
  });

  it('carries canonical import editor metadata and its unknown siblings into the shared save composer', () => {
    const editor = { sibling: 'keep', defaultInputs: '{"partial":' };
    const importedMetadata = {
      ...metadata, name: 'Source name', lifecycle: { transient: true },
      customProperties: { ...metadata.customProperties, [namespace]: editor },
    };
    const imported = fromCanonicalDefinition({ nodes: [{ nodeId: 'n1', typeId: 'core.noop' }], metadata: importedMetadata });
    expect(imported.metadata).toMatchObject({ customProperties: { other: { keep: true }, [namespace]: editor } });
    if (!imported.metadata) throw new Error('Canonical import must carry metadata');
    const saved = workflow(imported.defaultInputs, stripBuilderOwnedKeys(imported.metadata));
    const composed = definitionMetadataFor(saved);
    expect(composed).toMatchObject({ name: saved.name, customProperties: { other: { keep: true }, [namespace]: editor } });
    expect(composed).not.toHaveProperty('lifecycle');
  });

  it('keeps the legacy fallback distinct from variable declarations', () => {
    const legacy = fromCanonicalDefinition({ nodes: [{ nodeId: 'n1', typeId: 'core.noop' }], defaultInputs: { legacy: true }, variables: [{ name: 'topic', type: 'string' }] });
    expect(JSON.parse(legacy.defaultInputs)).toEqual({ legacy: true });
    expect(legacy.variables).toEqual([{ name: 'topic', type: 'string' }]);
  });
});

describe('malformed reserved metadata is preserved and save refuses honestly', () => {
  it.each([
    { customProperties: 'opaque' },
    { customProperties: { [namespace]: ['opaque'] } },
    { customProperties: { [namespace]: { defaultInputs: 42, sibling: 'keep' } } },
  ])('refuses %j without a backend write or lost local draft', async carried => {
    const wf = workflow('{"local":true}', carried);
    const before = JSON.stringify(carried);
    await expect(saveWorkflow(wf)).rejects.toThrow(/metadata/i);
    expect(transport).not.toHaveBeenCalled();
    expect(getSavedWorkflow(wf.id)?.defaultInputs).toBe(wf.defaultInputs);
    expect(JSON.stringify(wf.metadata)).toBe(before);
    const parsed = fromCanonicalDefinition({ nodes: [{ nodeId: 'n1', typeId: 'core.noop' }], metadata: carried, defaultInputs: { legacy: true } });
    expect(JSON.parse(parsed.defaultInputs)).toEqual({ legacy: true });
  });

  it('an older writer without a defaults string leaves carried editor metadata untouched', () => {
    const carried = { customProperties: { [namespace]: { defaultInputs: 'saved', sibling: 'keep' }, other: true } };
    const { defaultInputs: _omitted, ...older } = workflow('{}', carried);
    expect(definitionMetadataFor(older)).toEqual({ ...carried, name: older.name });
  });
});
