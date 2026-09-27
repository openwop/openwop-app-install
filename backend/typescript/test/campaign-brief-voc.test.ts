/**
 * VOC evidence (ADR 0403 Phase 1) — the grounding invariant, end to end:
 *   - validateVocCandidate: closed-world findings (quote / sourceRef / sentiment / theme)
 *   - persistVocEvidence: typed 422 on empty, 413 over the batch cap
 *   - surface.persistVoc: drop-with-finding, all-dropped = typed failure (never
 *     success-with-empty), tenant isolation
 *   - extract-voc node: the node BUILDS every sourceRef from the retrieved chunk
 *     (documentId + chunk locator + sha256 contentHash) and drops fabricated /
 *     mis-indexed quotes; ONE error-fed repair; all-dropped after repair is a
 *     typed `extraction_ungrounded` failure
 *   - brief-delete cascade takes the evidence with it
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createBrief, deleteBrief, __clearBriefs } from '../src/features/campaign-brief/briefService.js';
import { __clearPersonas } from '../src/features/campaign-brief/personaService.js';
import {
  validateVocCandidate, persistVocEvidence, listVocEvidence, deleteVocEvidence, __resetVocStore,
  VOC_SENTIMENTS, VOC_SOURCE_KINDS, VOC_LIMITS,
} from '../src/features/campaign-brief/vocService.js';
import { buildCampaignBriefSurface } from '../src/features/campaign-brief/surface.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-brief.nodes/index.mjs';

const TENANT = 'tenant-voc';
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }

const GOOD_REF = { documentId: 'doc-1', sourceKind: 'kb', locator: 'chunk:0', contentHash: 'a'.repeat(64) };
const GOOD = { quote: 'I waste two hours every morning', sourceRef: GOOD_REF, theme: 'time waste', sentiment: 'pain' };

beforeEach(async () => {
  initHostExtPersistence(openSqliteStorage(':memory:'));
  await __clearBriefs();
  await __clearPersonas();
  await __resetVocStore();
});

describe('validateVocCandidate — closed-world', () => {
  it('accepts a fully-grounded candidate (and normalizes personaHint)', () => {
    const r = validateVocCandidate({ ...GOOD, personaHint: '  Ops Director  ' }, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.sourceRef).toEqual(GOOD_REF);
      expect(r.item.personaHint).toBe('Ops Director');
    }
  });

  it('a quote without a sourceRef is a finding, never a bare string', () => {
    const r = validateVocCandidate({ ...GOOD, sourceRef: undefined }, 3);
    expect(r).toMatchObject({ ok: false, finding: { index: 3, field: 'sourceRef' } });
  });

  it.each([
    ['documentId', { ...GOOD_REF, documentId: '' }],
    ['locator', { ...GOOD_REF, locator: '' }],
    ['contentHash', { ...GOOD_REF, contentHash: '' }],
    ['sourceKind', { ...GOOD_REF, sourceKind: 'scraper' }],
  ])('an incomplete sourceRef (%s) is a finding', (_field, ref) => {
    const r = validateVocCandidate({ ...GOOD, sourceRef: ref }, 0);
    expect(r).toMatchObject({ ok: false, finding: { field: 'sourceRef' } });
  });

  it('rejects an empty quote, an unknown sentiment, and a missing theme', () => {
    expect(validateVocCandidate({ ...GOOD, quote: '   ' }, 0)).toMatchObject({ ok: false, finding: { field: 'quote' } });
    expect(validateVocCandidate({ ...GOOD, sentiment: 'meh' }, 0)).toMatchObject({ ok: false, finding: { field: 'sentiment' } });
    expect(validateVocCandidate({ ...GOOD, theme: '' }, 0)).toMatchObject({ ok: false, finding: { field: 'theme' } });
  });
});

describe('persistVocEvidence — typed caps', () => {
  it('an empty batch is a typed 422, never a silent no-op', async () => {
    await expect(persistVocEvidence(TENANT, 'o1', 'b1', 'u1', [])).rejects.toMatchObject({ code: 'validation_error', httpStatus: 422 });
  });

  it('a batch over the cap is a typed 413', async () => {
    const items = Array.from({ length: 101 }, () => ({ ...GOOD, sourceRef: GOOD_REF } as never));
    await expect(persistVocEvidence(TENANT, 'o1', 'b1', 'u1', items)).rejects.toMatchObject({ httpStatus: 413 });
  });

  it('re-persisting the same quote from the same source snapshot is idempotent (DATA-1)', async () => {
    const [first] = await persistVocEvidence(TENANT, 'o1', 'b1', 'u1', [GOOD as never]);
    const [again] = await persistVocEvidence(TENANT, 'o1', 'b1', 'u2', [GOOD as never]);
    expect(again.id).toBe(first.id);
    expect(again.createdBy).toBe('u1'); // the existing row is returned untouched
    expect(await listVocEvidence(TENANT, 'b1')).toHaveLength(1);
  });

  it('persists, lists (sentiment + theme filters), and deletes', async () => {
    await persistVocEvidence(TENANT, 'o1', 'b1', 'u1', [
      GOOD as never,
      { quote: 'wish it synced overnight', sourceRef: GOOD_REF, theme: 'automation', sentiment: 'desire' } as never,
    ]);
    expect(await listVocEvidence(TENANT, 'b1')).toHaveLength(2);
    expect((await listVocEvidence(TENANT, 'b1', { sentiment: 'pain' })).map((e) => e.theme)).toEqual(['time waste']);
    expect(await listVocEvidence(TENANT, 'b1', { theme: 'AUTO' })).toHaveLength(1);
    // Foreign tenant sees nothing; a foreign delete is a miss.
    expect(await listVocEvidence('other-tenant', 'b1')).toHaveLength(0);
    const [first] = await listVocEvidence(TENANT, 'b1');
    expect(await deleteVocEvidence('other-tenant', 'b1', first.id)).toBe(false);
    expect(await deleteVocEvidence(TENANT, 'b1', first.id)).toBe(true);
    expect(await listVocEvidence(TENANT, 'b1')).toHaveLength(1);
  });
});

describe('surface.persistVoc — drop-with-finding, all-dropped fails typed', () => {
  it('persists the valid candidates and returns findings for the dropped', async () => {
    const brief = await createBrief(TENANT, 'org-1', 'u1', { name: 'C', productName: 'FlashPick' });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    const out = as<{ evidence: Array<{ id: string }>; droppedFindings: Array<{ field: string }> }>(
      await surface.persistVoc({ briefId: brief.id, candidates: [GOOD, { quote: 'no source', sentiment: 'pain', theme: 't' }] }),
    );
    expect(out.evidence).toHaveLength(1);
    expect(out.droppedFindings).toEqual([expect.objectContaining({ field: 'sourceRef' })]);
    expect(await listVocEvidence(TENANT, brief.id)).toHaveLength(1);
  });

  it('an all-dropped batch is a typed validation_error — never success-with-empty', async () => {
    const brief = await createBrief(TENANT, 'org-1', 'u1', { name: 'C', productName: 'P' });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    await expect(surface.persistVoc({ briefId: brief.id, candidates: [{ quote: 'bare string' }] }))
      .rejects.toMatchObject({ code: 'validation_error', httpStatus: 422 });
    expect(await listVocEvidence(TENANT, brief.id)).toHaveLength(0);
  });

  it('a foreign-tenant surface cannot write into the brief (uniform not_found)', async () => {
    const brief = await createBrief(TENANT, 'org-1', 'u1', { name: 'C', productName: 'P' });
    const foreign = buildCampaignBriefSurface({ tenantId: 'other-tenant' });
    await expect(foreign.persistVoc({ briefId: brief.id, candidates: [GOOD] })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('extract-voc node — node-built sourceRefs + the grounding invariant', () => {
  const CHUNKS = [
    { chunkId: 'c1', documentId: 'doc-1', title: 'Reviews', chunkIndex: 0, text: 'A picker told us: "I waste two hours every morning re-counting bins." That pain came up in six interviews.', score: 0.9, contentTrust: 'untrusted' },
    { chunkId: 'c2', documentId: 'doc-2', title: 'Survey', chunkIndex: 3, text: 'Several customers said they wish the app just synced automatically overnight.', score: 0.8, contentTrust: 'untrusted' },
  ];

  function ctxWith(callAI: (req: unknown) => Promise<unknown>, briefId: string, rag?: () => Promise<unknown>) {
    return {
      features: {
        'campaign-brief': buildCampaignBriefSurface({ tenantId: TENANT }),
        kb: { rag: rag ?? (async () => ({ contexts: CHUNKS, citations: [], coverage: 'ok' })) },
      },
      callAI,
      inputs: { briefId },
    };
  }

  async function briefWithKb(): Promise<string> {
    const brief = await createBrief(TENANT, 'org-1', 'u1', { name: 'C', productName: 'FlashPick', industryVertical: 'Grocery', kbCollectionId: 'col-1' });
    return brief.id;
  }

  it('persists grounded quotes with node-built sourceRefs; fabricated or mis-indexed quotes drop with findings', async () => {
    const briefId = await briefWithKb();
    const callAI = vi.fn(async () => ({
      data: {
        candidates: [
          { contextIndex: 0, quote: 'I waste two hours every morning re-counting bins.', theme: 'time waste', sentiment: 'pain' },
          { contextIndex: 1, quote: 'This product changed my life completely.', theme: 'praise', sentiment: 'praise' }, // fabricated
          { contextIndex: 9, quote: 'wish the app just synced', theme: 'automation', sentiment: 'desire' }, // bad index
        ],
      },
    }));
    const out = as<{ status: string; outputs: { evidence: Array<{ quote: string; sourceRef: Record<string, string> }>; dropped: Array<{ field: string }> } }>(
      await nodePack['feature.campaign-brief.nodes.extract-voc'](ctxWith(callAI, briefId)),
    );
    expect(out.status).toBe('success');
    expect(out.outputs.evidence).toHaveLength(1);
    const ev = out.outputs.evidence[0];
    expect(ev.sourceRef.documentId).toBe('doc-1');
    expect(ev.sourceRef.sourceKind).toBe('kb');
    expect(ev.sourceRef.locator).toBe('chunk:0');
    expect(ev.sourceRef.contentHash).toBe(createHash('sha256').update(CHUNKS[0].text, 'utf8').digest('hex'));
    expect(out.outputs.dropped.map((d) => d.field).sort()).toEqual(['contextIndex', 'quote']);
    expect(await listVocEvidence(TENANT, briefId)).toHaveLength(1); // durably persisted
    expect(callAI).toHaveBeenCalledTimes(1); // no repair needed
  });

  it('runs ONE error-fed repair when everything drops, then succeeds on the corrected batch', async () => {
    const briefId = await briefWithKb();
    const callAI = vi.fn()
      .mockResolvedValueOnce({ data: { candidates: [{ contextIndex: 0, quote: 'totally invented', theme: 't', sentiment: 'pain' }] } })
      .mockResolvedValueOnce({ data: { candidates: [{ contextIndex: 1, quote: 'wish the app just synced automatically overnight', theme: 'automation', sentiment: 'desire' }] } });
    const out = as<{ status: string; outputs: { evidence: unknown[] } }>(
      await nodePack['feature.campaign-brief.nodes.extract-voc'](ctxWith(callAI, briefId)),
    );
    expect(out.status).toBe('success');
    expect(out.outputs.evidence).toHaveLength(1);
    expect(callAI).toHaveBeenCalledTimes(2);
    // The repair message names the grounding violations (error-fed, not blind).
    const repairCall = as<{ messages: Array<{ role: string; content: string }> }>(callAI.mock.calls[1][0]);
    expect(repairCall.messages.at(-1)?.content).toContain('FAILED grounding');
  });

  it('all-dropped after the repair is a typed extraction_ungrounded failure — never success-with-empty', async () => {
    const briefId = await briefWithKb();
    const callAI = vi.fn(async () => ({ data: { candidates: [{ contextIndex: 0, quote: 'still invented', theme: 't', sentiment: 'pain' }] } }));
    const out = as<{ status: string; error: { code: string } }>(
      await nodePack['feature.campaign-brief.nodes.extract-voc'](ctxWith(callAI, briefId)),
    );
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('extraction_ungrounded');
    expect(callAI).toHaveBeenCalledTimes(2); // exactly one repair
    expect(await listVocEvidence(TENANT, briefId)).toHaveLength(0);
  });

  it('fails typed when the brief binds no KB collection (OQ-1: no scraping fallback)', async () => {
    const brief = await createBrief(TENANT, 'org-1', 'u1', { name: 'C', productName: 'P' });
    const out = as<{ status: string; error: { code: string } }>(
      await nodePack['feature.campaign-brief.nodes.extract-voc'](ctxWith(vi.fn(), brief.id)),
    );
    expect(out).toMatchObject({ status: 'failed', error: { code: 'missing_input' } });
  });

  it('fails typed on empty retrieval coverage', async () => {
    const briefId = await briefWithKb();
    const out = as<{ status: string; error: { code: string } }>(
      await nodePack['feature.campaign-brief.nodes.extract-voc'](ctxWith(vi.fn(), briefId, async () => ({ contexts: [], coverage: 'none' }))),
    );
    expect(out).toMatchObject({ status: 'failed', error: { code: 'grounding_insufficient' } });
  });
});

describe('artifact-type pack ↔ TS SSoT parity', () => {
  it('the campaign-brief.voc-evidence pack schema mirrors vocService (enums + bounds + required)', () => {
    const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
    const pack = JSON.parse(readFileSync(join(REPO_ROOT, 'packs', 'feature.campaign-brief.artifact-types', 'pack.json'), 'utf8'));
    expect(pack.kind).toBe('artifact-type');
    const voc = pack.artifactTypes.find((t: { artifactTypeId: string }) => t.artifactTypeId === 'campaign-brief.voc-evidence');
    expect(voc, 'campaign-brief.voc-evidence must be declared').toBeTruthy();
    const schema = voc.schema;
    expect(schema.required).toEqual(['quote', 'sourceRef', 'theme', 'sentiment']);
    expect(schema.properties.sentiment.enum).toEqual([...VOC_SENTIMENTS]);
    expect(schema.properties.quote.maxLength).toBe(VOC_LIMITS.quoteMax);
    expect(schema.properties.theme.maxLength).toBe(VOC_LIMITS.themeMax);
    expect(schema.properties.personaHint.maxLength).toBe(VOC_LIMITS.personaHintMax);
    const ref = schema.properties.sourceRef;
    expect(ref.required).toEqual(['documentId', 'sourceKind', 'locator', 'contentHash']);
    expect(ref.properties.sourceKind.enum).toEqual([...VOC_SOURCE_KINDS]);
    expect(ref.properties.documentId.maxLength).toBe(VOC_LIMITS.documentIdMax);
    expect(ref.properties.locator.maxLength).toBe(VOC_LIMITS.locatorMax);
    expect(ref.properties.contentHash.maxLength).toBe(VOC_LIMITS.contentHashMax);
  });
});

describe('brief-delete cascade', () => {
  it('deleting the brief takes its VOC evidence with it', async () => {
    const brief = await createBrief(TENANT, 'org-1', 'u1', { name: 'C', productName: 'P' });
    await persistVocEvidence(TENANT, 'org-1', brief.id, 'u1', [GOOD as never]);
    expect(await listVocEvidence(TENANT, brief.id)).toHaveLength(1);
    await deleteBrief(TENANT, brief.id, 'u1');
    expect(await listVocEvidence(TENANT, brief.id)).toHaveLength(0);
  });
});
