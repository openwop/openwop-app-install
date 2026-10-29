/**
 * ADR 0083 — run-output artifact producer + run-event projection.
 *
 * The long-deferred PRODUCER: persist a node output as a durable artifact (replay-safe,
 * idempotent on the deterministic ${runId}:${nodeId} key), then read it back through the
 * existing `artifactProjection` `run-event` source so the workbench/Library/approval-card
 * can preview it. Verifies kind derivation, idempotency, projection round-trip, the Library
 * list, and cross-tenant isolation.
 *
 * Breaks it (round-1 probes, witnessed): the markdown hint / lone-port unwrap in
 * deriveArtifact (8fw2g2-ra-md, ra-unwrap), the insert-only CAS replaced by a put
 * (ra-cas — reds the gate-preview case AND, since round 2, the URL-image case,
 * which now re-executes with a DIFFERENT output), the role→status map
 * (ra-status), the asset-only Library filter (ra-asset), the tenant check on the
 * read (ra-tenant), the document / multi-image / URL-array / serve branches
 * (ra-doc, ra-multi, ra-urlmulti, ra-serve).
 *
 * DOUBLE GUARD on "INLINE BINARY … idempotent (no re-mint)" (`mintAndLink`):
 * the get-first on the bookkeeping row AND the CAS-loss GC of a freshly minted
 * asset each keep the media count at 1 (round-1 8fw2g2-ra-getfirst, get-first
 * removed, was VACUOUS by design). The probe is on both together
 * (8fw2g2-ra-getfirst-both-r2).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import {
  persistRunArtifact, getRunArtifact, deriveArtifact, listRunArtifactsForTenant, __resetRunArtifactStore,
} from '../src/host/runArtifactStore.js';
import { getArtifact, getArtifactRevision, listArtifacts, listArtifactsForRun } from '../src/host/artifactProjection.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import type { RunArtifactRecord } from '../src/host/runArtifactStore.js';
import { registerKicktodoCreatorArtifactTypes } from '../src/features/kicktodo-creator/artifactSchemas.js';
import { createDocument } from '../src/features/documents/documentsService.js';
import { __resetMedia } from '../src/features/media/mediaService.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { clientRunStamp } from '../src/host/runClientOrg.js';

// a tiny valid base64 payload (the media store just persists the bytes)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetRunArtifactStore();
  await __resetMedia();
});

describe('ADR 0083 — run-artifact producer', () => {
  it('deriveArtifact classifies content kind + unwraps a lone output/input port', () => {
    expect(deriveArtifact('# Title\nbody', 'n').kind).toBe('markdown');
    expect(deriveArtifact('{"a":1}', 'n').kind).toBe('data');
    expect(deriveArtifact('plain text', 'n').kind).toBe('text');
    expect(deriveArtifact({ a: 1 }, 'n').format).toBe('application/json');
    expect(deriveArtifact({ output: 'hi' }, 'n').content).toBe('hi'); // terminal unwrap
    expect(deriveArtifact({ input: 'hi' }, 'n').content).toBe('hi'); // gate-input unwrap
  });

  it('persists + reads back; idempotent on the deterministic key (replay-safe)', async () => {
    const r1 = await persistRunArtifact({ tenantId: 't1', runId: 'run1', nodeId: 'gate', role: 'gate-preview', output: { subject: 'Hi', body: 'congrats on 10 years' }, now: '2026-06-20T00:00:00Z' });
    expect(r1?.artifactId).toBe('run-event:run1:gate');
    expect(r1?.revisionId).toBe('run1:gate:1');
    expect((await getRunArtifact('run1:gate'))?.status).toBe('in-review');
    // A re-execution writing the SAME key is a no-op — first write wins, no duplicate, same id.
    const r2 = await persistRunArtifact({ tenantId: 't1', runId: 'run1', nodeId: 'gate', role: 'gate-preview', output: { different: 'ignored' }, now: '2026-06-20T01:00:00Z' });
    expect(r2?.artifactId).toBe('run-event:run1:gate');
    const all = await listRunArtifactsForTenant('t1');
    expect(all.length).toBe(1);
    expect(all[0]!.content).toContain('congrats on 10 years'); // original preserved
  });

  it('null/empty output → no row', async () => {
    expect(await persistRunArtifact({ tenantId: 't1', runId: 'r', nodeId: 'n', role: 'deliverable', output: null, now: 'x' })).toBeNull();
    expect(await persistRunArtifact({ tenantId: 't1', runId: 'r', nodeId: 'n2', role: 'deliverable', output: undefined, now: 'x' })).toBeNull();
    // …and nothing was written for either.
    expect(await getRunArtifact('r:n')).toBeNull();
    expect(await listRunArtifactsForTenant('t1')).toEqual([]);
  });

  it('projects a run-event artifact; a raw output is addressable but not a Library asset', async () => {
    await persistRunArtifact({ tenantId: 't1', runId: 'run9', nodeId: 'final', role: 'deliverable', output: '# Report\nQ3 variance', now: '2026-06-20T00:00:00Z' });
    const proj = await getArtifact('t1', undefined, 'run-event:run9:final');
    expect(proj?.source).toBe('run-event');
    expect(proj?.kind).toBe('markdown');
    expect(proj?.status).toBe('final');
    expect(proj?.createdBy.kind).toBe('run');
    expect(proj?.provenance.runId).toBe('run9');
    const rev = await getArtifactRevision('t1', undefined, 'run-event:run9:final', 'run9:final:1');
    expect(rev?.content).toContain('Q3 variance');
    // ADR 0083 §Amendment — the Library is asset-only: a raw markdown run OUTPUT (no
    // artifactTypeId) stays addressable via getArtifact but is NOT listed as an asset.
    const lib = await listArtifacts('t1', undefined);
    expect(lib.some((a) => a.artifactId === 'run-event:run9:final')).toBe(false);
  });

  it('cross-tenant isolation: another tenant cannot read the row', async () => {
    await persistRunArtifact({ tenantId: 't1', runId: 'runX', nodeId: 'n', role: 'deliverable', output: 'secret', now: 'x' });
    expect(await getArtifact('t2', undefined, 'run-event:runX:n')).toBeNull();
    expect((await listArtifacts('t2', undefined)).some((a) => a.artifactId === 'run-event:runX:n')).toBe(false);
  });
});

describe('ADR 0083 amendment — reference resolution (media / document / serve)', () => {
  it('INLINE BINARY → mints a media: artifact (previewable image), not a JSON blob; idempotent (no re-mint)', async () => {
    const r = await persistRunArtifact({ tenantId: 'tA', runId: 'imgRun', nodeId: 'gen', role: 'deliverable', output: { images: [{ contentBase64: PNG_B64, contentType: 'image/png' }] }, now: '2026-06-20T00:00:00Z' });
    expect(r?.artifactId).toMatch(/^media:/);
    // the media artifact previews as a real image (source media, image kind)
    const proj = await getArtifact('tA', undefined, r!.artifactId);
    expect(proj?.source).toBe('media');
    expect(proj?.kind).toBe('image');
    // run-event has NO inline blob row for it (the media owner represents it)
    expect((await listRunArtifactsForTenant('tA')).length).toBe(0);
    // the Library lists the media artifact (not a duplicate run-event)
    const lib = await listArtifacts('tA', undefined);
    expect(lib.filter((a) => a.artifactId === r!.artifactId).length).toBe(1);
    // idempotent: a re-execution returns the SAME media id without re-minting
    const r2 = await persistRunArtifact({ tenantId: 'tA', runId: 'imgRun', nodeId: 'gen', role: 'deliverable', output: { images: [{ contentBase64: PNG_B64, contentType: 'image/png' }] }, now: '2026-06-20T01:00:00Z' });
    expect(r2?.artifactId).toBe(r!.artifactId);
    expect((await listArtifacts('tA', undefined)).filter((a) => a.source === 'media').length).toBe(1); // no second asset
  });

  it('MULTI-IMAGE generator mints a media: artifact for EVERY image (ADR 0083 #3)', async () => {
    const r = await persistRunArtifact({ tenantId: 'tM', runId: 'mRun', nodeId: 'gen', role: 'deliverable', output: { images: [{ contentBase64: PNG_B64, contentType: 'image/png' }, { contentBase64: PNG_B64, contentType: 'image/png' }, { contentBase64: PNG_B64, contentType: 'image/png' }] }, now: '2026-06-20T00:00:00Z' });
    expect(r?.artifactId).toMatch(/^media:/); // the binding/primary is the first image
    expect((await listArtifacts('tM', undefined)).filter((a) => a.source === 'media').length).toBe(3); // all 3 captured
    // idempotent: re-exec mints none
    await persistRunArtifact({ tenantId: 'tM', runId: 'mRun', nodeId: 'gen', role: 'deliverable', output: { images: [{ contentBase64: PNG_B64, contentType: 'image/png' }, { contentBase64: PNG_B64, contentType: 'image/png' }, { contentBase64: PNG_B64, contentType: 'image/png' }] }, now: '2026-06-20T01:00:00Z' });
    expect((await listArtifacts('tM', undefined)).filter((a) => a.source === 'media').length).toBe(3);
  });

  it('ADR 0115 Phase 4 — URL-based image array (image-gen output) → a file artifact per image, not a JSON blob; replay-idempotent', async () => {
    // The image-generate node emits `images: [{ url }]` (bytes already a host media asset).
    const out = { images: [{ url: '/host/openwop-app/assets/img-a', mimeType: 'image/png' }, { url: '/host/openwop-app/assets/img-b', mimeType: 'image/png' }] };
    const r = await persistRunArtifact({ tenantId: 'tU', runId: 'uRun', nodeId: 'gen', role: 'deliverable', output: out, now: '2026-06-20T00:00:00Z' });
    expect(r).not.toBeNull();
    const rows = await listRunArtifactsForTenant('tU');
    expect(rows.length).toBe(2);                                   // both images captured…
    expect(rows.every((a) => a.kind === 'file')).toBe(true);       // …as file artifacts…
    expect(rows.some((a) => a.format === 'application/json')).toBe(false); // …NOT a JSON blob
    expect(rows.some((a) => a.content.includes('/assets/img-a'))).toBe(true);
    expect(rows.some((a) => a.content.includes('/assets/img-b'))).toBe(true);
    // replay-safe: a re-execution writes no new rows AND overwrites none (insert-only on
    // the deterministic key). The re-exec carries DIFFERENT urls, so an overwrite would
    // show `img-c`/`img-d` — a row COUNT alone cannot tell insert-only from overwrite.
    const rerun = { images: [{ url: '/host/openwop-app/assets/img-c', mimeType: 'image/png' }, { url: '/host/openwop-app/assets/img-d', mimeType: 'image/png' }] };
    await persistRunArtifact({ tenantId: 'tU', runId: 'uRun', nodeId: 'gen', role: 'deliverable', output: rerun, now: '2026-06-20T01:00:00Z' });
    const after = await listRunArtifactsForTenant('tU');
    expect(after.length).toBe(2);
    expect(after.some((a) => a.content.includes('/assets/img-a'))).toBe(true);
    expect(after.some((a) => a.content.includes('/assets/img-b'))).toBe(true);
    expect(after.some((a) => a.content.includes('/assets/img-c') || a.content.includes('/assets/img-d'))).toBe(false);
  });

  it('DOCUMENT reference → links the document: artifact (no duplicate run-event blob)', async () => {
    const doc = await createDocument({ tenantId: 'tD', orgId: 'tD', title: 'SOW', kind: 'sow', provenance: { producedBy: { kind: 'run', id: 'docRun' } }, createdBy: 'docRun' });
    const r = await persistRunArtifact({ tenantId: 'tD', runId: 'docRun', nodeId: 'gen', role: 'deliverable', output: { document: { documentId: doc.documentId }, version: 1 }, now: '2026-06-20T00:00:00Z' });
    expect(r?.artifactId).toBe(`document:${doc.documentId}`);
    // no inline run-event artifact duplicating the document
    expect((await listRunArtifactsForTenant('tD')).length).toBe(0);
    // the bookkeeping row exists (idempotency) but is a link, not a projectable run-event
    expect((await getRunArtifact('docRun:gen'))?.linkedArtifactId).toBe(`document:${doc.documentId}`);
    expect(await getArtifact('tD', undefined, 'run-event:docRun:gen')).toBeNull();
  });

  it('SERVE reference (renderedMediaToken) → a click-to-open link, not a JSON blob', async () => {
    const r = await persistRunArtifact({ tenantId: 'tS', runId: 'rndRun', nodeId: 'render', role: 'deliverable', output: { versionId: 'v1', renderedMediaToken: 'tok-xyz', url: '/host/openwop-app/assets/tok-xyz', sizeBytes: 99 }, now: '2026-06-20T00:00:00Z' });
    expect(r?.artifactId).toBe('run-event:rndRun:render');
    const rev = await getArtifactRevision('tS', undefined, r!.artifactId, r!.revisionId);
    expect(rev?.content).toContain('(/host/openwop-app/assets/tok-xyz)');
    expect(rev?.content).toMatch(/^\[.*\]\(/); // a markdown link, not raw JSON
  });
});

describe('ADR 0957 P1b — client-bound outputs retain their organization', () => {
  it.each(['inline', 'media'] as const)('%s output is readable only in the run client; output cannot forge its organization', async (kind) => {
    const { tenantId } = await createWorkspace({ name: 'Artifact agency', ownerSubject: 'owner' });
    const a = await createOrg({ tenantId, createdBy: 'owner', name: 'A' });
    const b = await createOrg({ tenantId, createdBy: 'owner', name: 'B' });
    for (const [subject, orgId] of [['reviewer-a', a.orgId], ['reviewer-b', b.orgId]]) {
      await createMember({ tenantId, orgId: tenantId, subject, displayName: subject, roles: ['viewer'] });
      await createMember({ tenantId, orgId, subject, displayName: subject, roles: ['editor'] });
    }
    const now = new Date().toISOString();
    const runId = `client-artifact-${kind}`;
    await storage.insertRun({ runId, tenantId, workflowId: 'client-report', status: 'running', inputs: {}, configurable: {}, metadata: clientRunStamp(a.orgId), createdAt: now, updatedAt: now });
    const result = await persistRunArtifact({ tenantId, runId, nodeId: 'preview', role: 'gate-preview', now,
      output: kind === 'inline' ? { orgId: b.orgId, snapshot: { spend: 123 } } : { orgId: b.orgId, contentBase64: PNG_B64, contentType: 'image/png' },
    });
    expect(result).not.toBeNull();
    const visible = await getArtifact(tenantId, 'reviewer-a', result!.artifactId);
    expect(visible?.orgId).toBe(a.orgId);
    expect(await getArtifact(tenantId, 'reviewer-b', result!.artifactId)).toBeNull();
    expect(await getArtifactRevision(tenantId, 'reviewer-b', result!.artifactId, result!.revisionId)).toBeNull();
    expect((await listArtifacts(tenantId, 'reviewer-b')).some((item) => item.artifactId === result!.artifactId)).toBe(false);
  });

  it.each([
    ['malformed', { 'openwop-app.campaignOps': {} }],
    ['conflicting', { ...clientRunStamp('a'), campaignOrchestration: { orgId: 'b' } }],
    ['missing client', clientRunStamp('missing-client')],
  ])('a %s client binding never falls back to the workspace', async (_reason, metadata) => {
    const now = new Date().toISOString();
    await storage.insertRun({ runId: 'bad-client-run', tenantId: 'tenant', workflowId: 'client-report', status: 'running', inputs: {}, configurable: {}, metadata, createdAt: now, updatedAt: now });
    expect(await persistRunArtifact({ tenantId: 'tenant', runId: 'bad-client-run', nodeId: 'preview', role: 'gate-preview', output: 'private figures', now })).toBeNull();
    expect(await getRunArtifact('bad-client-run:preview')).toBeNull();
  });
});

// P9 (2026-10-28) — the Challenge Factory outline and final result both listed
// as `{`: an untyped JSON row took its first line as its title.
describe('JSON artifact titles', () => {
  const day = (n: number, extra: Record<string, unknown> = {}) => ({ day: n, stableActivityId: `d${n}`, title: `Day ${n}`, actionInstruction: 'Do it.', userFacingWhy: 'Because.', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'note', claimRefs: [], ...extra });
  const plan = (days: unknown[]) => ({ title: 'Twenty-One Days of Focus', promise: 'Focus daily', audience: 'makers', durationDays: 21, dailyMinutesBudget: 20, outcomes: [{ outcomeId: 'o1', measurableOutcome: 'x', method: 'y' }], achievements: [{ achievementId: 'a1', observableEvidence: 'z', outcomeIds: ['o1'] }], days });
  const envelope = (p: ReturnType<typeof plan>) => ({ plan: p, artifact: { artifactTypeId: 'kicktodo.challenge-plan', title: p.title, payload: p } });
  const alt = { stableActivityId: 'd1-alt', title: 'Alt', actionInstruction: 'Alt.', evidencePolicy: 'note' };

  it('a plan with alternatives persists TYPED, titled by the plan', async () => {
    registerKicktodoCreatorArtifactTypes();
    await persistRunArtifact({ tenantId: 't1', runId: 'p9', nodeId: 'outline-approve', role: 'gate-preview', output: envelope(plan([day(1, { alternatives: [alt] }), day(2)])), now: '2026-10-28T00:00:00Z' });
    const row = await getRunArtifact('p9:outline-approve');
    expect(row?.artifactTypeId).toBe('kicktodo.challenge-plan');
    expect(row?.title).toBe('Twenty-One Days of Focus');
  });

  it('a malformed alternative stays UNTYPED (no false typed claim) but is still titled by the plan', async () => {
    registerKicktodoCreatorArtifactTypes();
    await persistRunArtifact({ tenantId: 't1', runId: 'p9b', nodeId: 'outline-approve', role: 'gate-preview', output: envelope(plan([day(1, { alternatives: [{ ...alt, evidencePolicy: 'vibes' }] })])), now: '2026-10-28T00:00:00Z' });
    const row = await getRunArtifact('p9b:outline-approve');
    expect(row?.artifactTypeId).toBeUndefined();
    expect(row?.format).toBe('application/json');
    expect(row?.title).toBe('Twenty-One Days of Focus');
    expect(row?.content).toContain('"vibes"'); // raw bytes kept as produced
  });

  it('a submitted approval result is named by its state, never as published', () => {
    const { title } = deriveArtifact({ approvalId: 'appr:1', state: 'submitted' }, 'submit');
    expect(title).toBe('Approval request (submitted)');
    expect(title.toLowerCase()).not.toContain('publish');
  });

  it('JSON that names nothing falls back to the node, never to `{` or `[`', () => {
    expect(deriveArtifact({ a: 1 }, 'n').title).toBe('n output');
    expect(deriveArtifact('[1, 2]', 'n').title).toBe('n output');
    expect(deriveArtifact('{"name":"Weekly report"}', 'n').title).toBe('Weekly report');
    expect(deriveArtifact('plain first line\nmore', 'n').title).toBe('plain first line');
  });

  it('a SAVED legacy `{` row is renamed on read (get + run list), with its stored title and bytes untouched', async () => {
    const rows = new DurableCollection<RunArtifactRecord>('runartifact', (a) => a.artifactKey);
    const content = JSON.stringify(envelope(plan([day(1)])), null, 2);
    const base = { tenantId: 't1', orgId: 't1', runId: 'old', role: 'gate-preview' as const, kind: 'data', format: 'application/json', status: 'in-review', createdBy: 'old', createdAt: '2026-10-28T16:01:35Z' };
    await rows.put({ ...base, artifactKey: 'old:outline-approve', nodeId: 'outline-approve', title: '{', content });
    await rows.put({ ...base, artifactKey: 'old:submit', nodeId: 'submit', title: '{', content: JSON.stringify({ approvalId: 'appr:1', state: 'submitted' }, null, 2), createdAt: '2026-10-28T16:05:00Z' });
    await rows.put({ ...base, artifactKey: 'old:named', nodeId: 'named', title: 'Chosen by the node', content: '{\n  "x": 1\n}', createdAt: '2026-10-28T16:06:00Z' });

    expect((await getArtifact('t1', undefined, 'run-event:old:outline-approve'))?.title).toBe('Twenty-One Days of Focus');
    const listed = await listArtifactsForRun('t1', undefined, 'old');
    expect(Object.fromEntries(listed.map((a) => [a.runNodeId, a.title]))).toEqual({
      'outline-approve': 'Twenty-One Days of Focus',
      submit: 'Approval request (submitted)',
      named: 'Chosen by the node',
    });
    expect((await getRunArtifact('old:outline-approve'))?.title).toBe('{'); // no migration
    expect((await getArtifactRevision('t1', undefined, 'run-event:old:outline-approve', 'old:outline-approve:1'))?.content).toBe(content);
  });
});
