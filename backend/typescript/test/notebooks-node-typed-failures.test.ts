/**
 * ADR 1103 D4 — a notebook node that wrote nothing FAILS, typed.
 *
 * Every one of these used to answer `status:'success'` with `stored:false` /
 * `written:false` / `ingested:false` / `empty:true`, so a summarize, transform or
 * ingest run in a private project "completed" after a paid model call and wrote
 * nothing (`NBK92-2`). Pure node-fn tests against a mock `ctx.features.notebooks`:
 * the refusal SHAPE (`{ error: { code, message } }`) is the surface's contract
 * (witnessed end to end in `notebooks-run-lane-authority.test.ts`); here the claim is
 * only that each node turns that shape, and its own empty cases, into a throw that
 * carries the code.
 *
 * Sabotage: restoring any one of the old `return { status: 'success', … false }`
 * branches reds the matching case below.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
import * as pack from '../../../packs/feature.notebooks.nodes/index.mjs';

const refused = (code: string) => async () => ({ error: { code, message: `refused: ${code}` } });
const ctx = (features: Record<string, unknown>, inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ inputs, features, ...extra });

describe('ADR 1103 D4 — read-source', () => {
  it('fails with the surface refusal code instead of an empty payload', async () => {
    await expect(pack.readSource(ctx({ notebooks: { getSourceText: refused('notebook_unavailable') } }, { notebookId: 'n', sourceId: 's' })))
      .rejects.toMatchObject({ code: 'notebook_unavailable' });
  });
  it('fails source_empty for a blank source', async () => {
    await expect(pack.readSource(ctx({ notebooks: { getSourceText: async () => ({ text: '   ', revision: 1 }) } }, { notebookId: 'n', sourceId: 's' })))
      .rejects.toMatchObject({ code: 'source_empty' });
  });
  it('outputs the revision it read, for the store-summary edge', async () => {
    const out = await pack.readSource(ctx({ notebooks: { getSourceText: async () => ({ text: 'body', revision: 3 }) } }, { notebookId: 'n', sourceId: 's' }));
    expect(out.outputs).toMatchObject({ empty: false, revision: 3 });
  });
});

describe('ADR 1103 D4 — store-summary', () => {
  it('fails summary_empty for an empty model output, without calling the surface', async () => {
    const calls: unknown[] = [];
    const nb = { setSourceSummary: async (a: unknown) => { calls.push(a); return { stored: true }; } };
    await expect(pack.storeSummary(ctx({ notebooks: nb }, { notebookId: 'n', sourceId: 's', summary: '  ' })))
      .rejects.toMatchObject({ code: 'summary_empty' });
    expect(calls).toEqual([]);
  });
  it('fails with the surface refusal code (a run that may not write)', async () => {
    await expect(pack.storeSummary(ctx({ notebooks: { setSourceSummary: refused('notebook_write_forbidden') } }, { notebookId: 'n', sourceId: 's', summary: 'S' })))
      .rejects.toMatchObject({ code: 'notebook_write_forbidden' });
    await expect(pack.storeSummary(ctx({ notebooks: { setSourceSummary: refused('source_changed') } }, { notebookId: 'n', sourceId: 's', summary: 'S', revision: 1 })))
      .rejects.toMatchObject({ code: 'source_changed' });
  });
  it('passes the read revision through and succeeds only when stored', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const nb = { setSourceSummary: async (a: Record<string, unknown>) => { calls.push(a); return { stored: true }; } };
    const out = await pack.storeSummary(ctx({ notebooks: nb }, { notebookId: 'n', sourceId: 's', summary: 'S', revision: 2 }));
    expect(out).toMatchObject({ status: 'success', outputs: { stored: true } });
    expect(calls).toEqual([{ notebookId: 'n', sourceId: 's', summary: 'S', revision: 2 }]);
  });
});

describe('ADR 1103 D4/D5 — write-transformation', () => {
  const docs = { createDocument: async () => ({ document: { documentId: 'd' } }), addVersion: async () => ({}) };
  const target = { transformTarget: async () => ({ orgId: 'o1', ownerSubject: { kind: 'project', id: 'n' } }) };
  it('fails transformation_empty for empty model output', async () => {
    await expect(pack.writeTransformation(ctx({ documents: docs, notebooks: target }, { notebookId: 'n', content: ' ' })))
      .rejects.toMatchObject({ code: 'transformation_empty' });
  });
  it('fails notebook_required without a notebook id', async () => {
    await expect(pack.writeTransformation(ctx({ documents: docs, notebooks: target }, { content: 'x', orgId: 'o1' })))
      .rejects.toMatchObject({ code: 'notebook_required' });
  });
  it('fails with the target refusal code (the run cannot write this notebook)', async () => {
    await expect(pack.writeTransformation(ctx({ documents: docs, notebooks: { transformTarget: refused('notebook_unavailable') } }, { notebookId: 'n', content: 'x' })))
      .rejects.toMatchObject({ code: 'notebook_unavailable' });
  });
});

describe('ADR 1103 D4 — transcribe-source and ingest-source', () => {
  it('transcribe-source fails validation_error for blank audio and no_transcript for an empty transcript', async () => {
    const callAI = async () => ({ content: '  ' });
    await expect(pack.transcribeSource(ctx({}, { audioBase64: '' }, { callAI }))).rejects.toMatchObject({ code: 'validation_error' });
    await expect(pack.transcribeSource(ctx({}, { audioBase64: 'AAAA', mimeType: 'audio/mpeg' }, { callAI }))).rejects.toMatchObject({ code: 'no_transcript' });
  });
  it('ingest-source fails notebook_required, transcript_empty and the refusal code', async () => {
    const ok = { ingestSource: async () => ({ ingested: true, sourceId: 'd', title: 't' }) };
    await expect(pack.ingestSource(ctx({ notebooks: ok }, { text: 'x' }))).rejects.toMatchObject({ code: 'notebook_required' });
    await expect(pack.ingestSource(ctx({ notebooks: ok }, { notebookId: 'n', text: ' ' }))).rejects.toMatchObject({ code: 'transcript_empty' });
    await expect(pack.ingestSource(ctx({ notebooks: { ingestSource: refused('notebook_write_needs_person') } }, { notebookId: 'n', text: 'x' })))
      .rejects.toMatchObject({ code: 'notebook_write_needs_person' });
    const out = await pack.ingestSource(ctx({ notebooks: ok }, { notebookId: 'n', text: 'x' }));
    expect(out.outputs).toMatchObject({ ingested: true, sourceId: 'd' });
  });
});

describe('ADR 1103 D4 — MCP write nodes', () => {
  it('a decline stays a success (a human answered); an accepted refusal fails typed', async () => {
    const declined = await pack.mcpAddSource(ctx({ notebooks: { ingestSource: refused('x') } }, { notebookId: 'n', text: 't', decision: 'reject' }));
    expect(declined).toMatchObject({ status: 'success', outputs: { written: false, declined: true } });
    await expect(pack.mcpAddSource(ctx({ notebooks: { ingestSource: refused('notebook_write_forbidden') } }, { notebookId: 'n', text: 't', decision: 'accept' })))
      .rejects.toMatchObject({ code: 'notebook_write_forbidden' });
    await expect(pack.mcpCreateNote(ctx({ notebooks: { addNote: refused('notebook_unavailable') } }, { notebookId: 'n', content: 'c', decision: 'accept' })))
      .rejects.toMatchObject({ code: 'notebook_unavailable' });
    await expect(pack.mcpCreateNote(ctx({ notebooks: { addNote: async () => ({ created: true }) } }, { notebookId: 'n', content: ' ', decision: 'accept' })))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(pack.mcpAddSource(ctx({ notebooks: { ingestSource: async () => ({ ingested: true, sourceId: 'd' }) } }, { notebookId: 'n', text: ' ', decision: 'accept' })))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
});
