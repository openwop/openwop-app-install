/**
 * ADR 0128 Phase 6 — the interactive-artifacts producer pipe.
 *
 * Proves the load-bearing backend plumbing a static build can't otherwise show:
 * a node that declares a typed `{ artifact: { artifactTypeId, payload } }` output
 * envelope is persisted as a run artifact carrying `artifactTypeId` + the payload
 * as content, and the workbench projection surfaces that type — so the renderer
 * (which dispatches on `interactive.*`) can finally receive it. (The visual render
 * itself is a /browser check.)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { registerInteractiveArtifactTypes } from '../src/features/interactive-artifacts/artifactTypes.js';
import {
  detectTypedArtifact,
  persistRunArtifact,
  getRunArtifact,
  runArtifactKey,
} from '../src/host/runArtifactStore.js';
import { runArtifactToArtifact } from '../src/host/artifactProjection.js';
// The on-disk producer node pack (ambient-typed in test/feature-packs.d.ts).
import { nodes as iaNodes } from '../../../packs/feature.interactive-artifacts.nodes/index.mjs';

const render = iaNodes['feature.interactive-artifacts.nodes.render']!;
/** The typed `{ artifact }` envelope the render node emits (narrowed for asserts). */
type RenderedArtifact = { artifactTypeId: string; payload: unknown; contentTrust: string; title?: string };
const artifactOf = (outputs: Record<string, unknown> | undefined): RenderedArtifact => (outputs?.artifact as RenderedArtifact);

const T = 'ia-tenant';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerInteractiveArtifactTypes();
});

describe('detectTypedArtifact', () => {
  it('reads a mermaid envelope → type + raw-source content + title', () => {
    const got = detectTypedArtifact({ artifact: { artifactTypeId: 'interactive.mermaid', payload: 'graph TD\nA-->B', title: 'Flow' } }, 'n1');
    expect(got?.artifactTypeId).toBe('interactive.mermaid');
    expect(got?.content).toBe('graph TD\nA-->B');
    expect(got?.title).toBe('Flow');
  });

  it('JSON-serializes an object payload (chart spec) for content', () => {
    const got = detectTypedArtifact({ artifact: { artifactTypeId: 'interactive.chart', payload: { chartType: 'bar', data: { labels: ['a'], values: [1] } } } }, 'n1');
    expect(got?.artifactTypeId).toBe('interactive.chart');
    expect(JSON.parse(got!.content).chartType).toBe('bar');
  });

  it('ignores a document-BACKED envelope (has documentId) → null', () => {
    expect(detectTypedArtifact({ artifact: { artifactTypeId: 'interactive.mermaid', payload: 'x', documentId: 'doc:1' } }, 'n1')).toBeNull();
  });

  it('ignores an unregistered type → null', () => {
    expect(detectTypedArtifact({ artifact: { artifactTypeId: 'not.registered', payload: 'x' } }, 'n1')).toBeNull();
  });

  it('ignores output with no artifact envelope → null', () => {
    expect(detectTypedArtifact({ stdout: 'hi' }, 'n1')).toBeNull();
  });

  it('ignores a null/undefined payload → null (no "null" artifact persisted)', () => {
    expect(detectTypedArtifact({ artifact: { artifactTypeId: 'interactive.mermaid', payload: null } }, 'n1')).toBeNull();
    expect(detectTypedArtifact({ artifact: { artifactTypeId: 'interactive.mermaid' } }, 'n1')).toBeNull();
  });
});

describe('persistRunArtifact → projection (the pipe to the renderer)', () => {
  it('persists artifactTypeId + payload content, and the projection surfaces the type', async () => {
    const out = { artifact: { artifactTypeId: 'interactive.mermaid', payload: 'graph LR\nX-->Y', title: 'Pipe' } };
    const res = await persistRunArtifact({ tenantId: T, runId: 'run1', nodeId: 'viz', role: 'deliverable', output: out, now: new Date('2026-06-25').toISOString() });
    expect(res).not.toBeNull();

    const row = await getRunArtifact(runArtifactKey('run1', 'viz'));
    expect(row?.artifactTypeId).toBe('interactive.mermaid');
    expect(row?.content).toBe('graph LR\nX-->Y');
    expect(row?.title).toBe('Pipe');

    const proj = runArtifactToArtifact(row!);
    expect(proj.artifactTypeId).toBe('interactive.mermaid'); // <- the renderer dispatches on this
    expect(proj.source).toBe('run-event');
  });

  it('a plain (untyped) output carries NO artifactTypeId (unchanged behavior)', async () => {
    await persistRunArtifact({ tenantId: T, runId: 'run2', nodeId: 'plain', role: 'deliverable', output: 'just some text', now: new Date('2026-06-25').toISOString() });
    const row = await getRunArtifact(runArtifactKey('run2', 'plain'));
    expect(row?.artifactTypeId).toBeUndefined();
    expect(runArtifactToArtifact(row!).artifactTypeId).toBeUndefined();
  });
});

describe('producer node — feature.interactive-artifacts.nodes.render', () => {
  it('maps kind → interactive.<kind> with the raw source as payload', async () => {
    const r = await render({ inputs: { kind: 'mermaid', source: 'graph TD\nA-->B', title: 'D' } });
    expect(r.status).toBe('success');
    const art = artifactOf(r.outputs);
    expect(art.artifactTypeId).toBe('interactive.mermaid');
    expect(art.payload).toBe('graph TD\nA-->B');
    expect(art.contentTrust).toBe('untrusted');
  });

  it('accepts a chart object spec', async () => {
    const r = await render({ inputs: { kind: 'chart', chart: { chartType: 'line', data: { labels: ['a'], values: [1] } } } });
    const art = artifactOf(r.outputs);
    expect(art.artifactTypeId).toBe('interactive.chart');
    expect((art.payload as { chartType: string }).chartType).toBe('line');
  });

  it('rejects an unsupported kind', async () => {
    await expect(render({ inputs: { kind: 'pie', source: 'x' } })).rejects.toThrow(/unsupported/);
  });

  it('rejects mermaid with no source', async () => {
    await expect(render({ inputs: { kind: 'mermaid' } })).rejects.toThrow(/source/);
  });
});
