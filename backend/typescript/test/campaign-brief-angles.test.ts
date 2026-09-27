/**
 * Ad angles + hook bank + targeting packs (ADR 0403 Phases 2-3):
 *   - validateAngleCandidate: proofRefs non-empty AND resolving to stored evidence
 *   - surface.persistAngles: closed-world proofRef re-check, drop-with-finding,
 *     all-dropped typed 422, hook emission (deterministic ids, idempotent,
 *     never demoting a tested hook)
 *   - generate-angles node: index→id mapping, kernel required, ONE repair,
 *     typed generation_ungrounded
 *   - hook transitions: candidate→tested→retired lattice enforced
 *   - assembleContext projects TESTED hooks only (capped)
 *   - build-targeting node + surface: platform enum, evidence grounding,
 *     deterministic brief+platform upsert (re-run replaces)
 *   - brief-delete cascade: angles + targeting go, the ORG hook bank survives
 *   - artifact-type pack parity for the three Phase 2-3 schemas
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createBrief, deleteBrief, setKernel, __clearBriefs } from '../src/features/campaign-brief/briefService.js';
import { __clearPersonas } from '../src/features/campaign-brief/personaService.js';
import { listVocEvidence, persistVocEvidence, __resetVocStore, type VocEvidence } from '../src/features/campaign-brief/vocService.js';
import { validateAngleCandidate, listAngles, __resetAngleStore, ANGLE_LIMITS } from '../src/features/campaign-brief/angleService.js';
import { listHooks, promoteHook, deterministicHookId, __resetHookStore, HOOK_LIMITS } from '../src/features/campaign-brief/hookBankService.js';
import { listTargetingPacks, __resetTargetingStore, TARGETING_PLATFORMS, TARGETING_LIMITS } from '../src/features/campaign-brief/targetingService.js';
import { buildCampaignBriefSurface } from '../src/features/campaign-brief/surface.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-brief.nodes/index.mjs';
import type { MessagingKernel } from '../src/features/campaign-brief/types.js';

const TENANT = 'tenant-angles';
const ORG = 'org-1';
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }

const REF = { documentId: 'doc-1', sourceKind: 'kb' as const, locator: 'chunk:0', contentHash: 'a'.repeat(64) };
const KERNEL: MessagingKernel = {
  headline: 'Pick faster', supportingStatement: 'Zero recounts', proofPoints: ['40%'], primaryCta: 'Demo',
  secondaryCta: '', tone: 'direct', channelTones: {}, sourceDocIds: [], generatedAt: new Date().toISOString(),
};

beforeEach(async () => {
  initHostExtPersistence(openSqliteStorage(':memory:'));
  await __clearBriefs();
  await __clearPersonas();
  await __resetVocStore();
  await __resetAngleStore();
  await __resetHookStore();
  await __resetTargetingStore();
});

async function briefWithEvidence(): Promise<{ briefId: string; evidence: VocEvidence[] }> {
  const brief = await createBrief(TENANT, ORG, 'u1', { name: 'C', productName: 'FlashPick', industryVertical: 'Grocery' });
  await setKernel(TENANT, brief.id, KERNEL);
  const evidence = await persistVocEvidence(TENANT, ORG, brief.id, 'u1', [
    { quote: 'I waste two hours every morning', sourceRef: REF, theme: 'time waste', sentiment: 'pain' },
    { quote: 'wish it synced overnight', sourceRef: REF, theme: 'automation', sentiment: 'desire' },
  ]);
  return { briefId: brief.id, evidence };
}

describe('validateAngleCandidate — the proofRef grounding invariant', () => {
  const IDS = new Set(['ev-1', 'ev-2']);
  const GOOD = { claim: 'Fastest picker', positioningLens: 'speed', proofRefs: ['ev-1'], hookVariants: [{ text: 'Two hours, gone.', format: 'bold-claim' }] };

  it('accepts a grounded candidate and normalizes hook variants', () => {
    const r = validateAngleCandidate({ ...GOOD, hookVariants: [...GOOD.hookVariants, { text: '', format: 'x' }] }, 0, IDS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.hookVariants).toHaveLength(1);
  });

  it('empty proofRefs is a finding — an ungrounded angle is not evidence-based', () => {
    expect(validateAngleCandidate({ ...GOOD, proofRefs: [] }, 2, IDS)).toMatchObject({ ok: false, finding: { index: 2, field: 'proofRefs' } });
  });

  it('a proofRef that does not resolve to stored evidence is a finding', () => {
    expect(validateAngleCandidate({ ...GOOD, proofRefs: ['ev-1', 'hallucinated'] }, 0, IDS)).toMatchObject({ ok: false, finding: { field: 'proofRefs' } });
  });

  it('missing claim / lens are findings', () => {
    expect(validateAngleCandidate({ ...GOOD, claim: ' ' }, 0, IDS)).toMatchObject({ ok: false, finding: { field: 'claim' } });
    expect(validateAngleCandidate({ ...GOOD, positioningLens: '' }, 0, IDS)).toMatchObject({ ok: false, finding: { field: 'positioningLens' } });
  });
});

describe('surface.persistAngles — closed-world + hook emission', () => {
  it('persists grounded angles, drops unresolvable ones with findings, and emits candidate hooks', async () => {
    const { briefId, evidence } = await briefWithEvidence();
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    const out = as<{ angles: Array<{ id: string; proofRefs: string[] }>; droppedFindings: unknown[]; emittedHooks: Array<{ id: string; status: string }> }>(
      await surface.persistAngles({
        briefId,
        candidates: [
          { claim: 'Fastest', positioningLens: 'speed', proofRefs: [evidence[0].id], hookVariants: [{ text: 'Two hours, gone.', format: 'bold-claim' }] },
          { claim: 'Ungrounded', positioningLens: 'trust', proofRefs: ['fake-id'], hookVariants: [] },
        ],
      }),
    );
    expect(out.angles).toHaveLength(1);
    expect(out.droppedFindings).toHaveLength(1);
    expect(out.emittedHooks).toEqual([expect.objectContaining({ status: 'candidate', id: deterministicHookId(TENANT, ORG, 'Two hours, gone.') })]);
    expect(await listHooks(TENANT, ORG)).toHaveLength(1);
  });

  it('re-persisting the same hook text is idempotent and never demotes a tested hook', async () => {
    const { briefId, evidence } = await briefWithEvidence();
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    const mk = (claim: string) => ({ claim, positioningLens: 'speed', proofRefs: [evidence[0].id], hookVariants: [{ text: 'Two hours, gone.', format: 'bold-claim' }] });
    await surface.persistAngles({ briefId, candidates: [mk('First')] });
    const hookId = deterministicHookId(TENANT, ORG, 'Two hours, gone.');
    await promoteHook(TENANT, ORG, hookId, 'tested', 'perf:123');
    const out = as<{ skippedExistingHooks: number; emittedHooks: unknown[] }>(
      await surface.persistAngles({ briefId, candidates: [mk('Second — same hook line')] }),
    );
    expect(out.emittedHooks).toHaveLength(0);
    expect(out.skippedExistingHooks).toBe(1);
    const [hook] = await listHooks(TENANT, ORG);
    expect(hook.status).toBe('tested'); // survived the re-emission
    expect(await listHooks(TENANT, ORG)).toHaveLength(1); // no duplicate
  });

  it('an all-ungrounded batch is a typed 422 — never success-with-empty', async () => {
    const { briefId } = await briefWithEvidence();
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    await expect(surface.persistAngles({ briefId, candidates: [{ claim: 'X', positioningLens: 'y', proofRefs: ['nope'], hookVariants: [] }] }))
      .rejects.toMatchObject({ code: 'validation_error', httpStatus: 422 });
    expect(await listAngles(TENANT, briefId)).toHaveLength(0);
  });
});

describe('hook transitions — the promotion lattice', () => {
  it('candidate→tested→retired; illegal moves are typed 422s', async () => {
    const { briefId, evidence } = await briefWithEvidence();
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    await surface.persistAngles({ briefId, candidates: [{ claim: 'C', positioningLens: 'l', proofRefs: [evidence[0].id], hookVariants: [{ text: 'Hook A', format: 'question' }] }] });
    const id = deterministicHookId(TENANT, ORG, 'Hook A');
    await expect(promoteHook(TENANT, ORG, id, 'bogus')).rejects.toMatchObject({ httpStatus: 422 });
    const tested = await promoteHook(TENANT, ORG, id, 'tested', 'perf:abc');
    expect(tested).toMatchObject({ status: 'tested', metricRef: 'perf:abc' });
    await expect(promoteHook(TENANT, ORG, id, 'candidate')).rejects.toMatchObject({ httpStatus: 422 }); // no demotion
    expect(await promoteHook(TENANT, ORG, id, 'retired')).toMatchObject({ status: 'retired' });
    await expect(promoteHook(TENANT, ORG, id, 'tested')).rejects.toMatchObject({ httpStatus: 422 }); // retired is terminal
    expect(await promoteHook(TENANT, ORG, 'missing', 'tested')).toBeNull();
  });
});

describe('assembleContext — TESTED-only hooks projection', () => {
  it('projects only tested hooks, minimal shape', async () => {
    const { briefId, evidence } = await briefWithEvidence();
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    await surface.persistAngles({
      briefId,
      candidates: [{ claim: 'C', positioningLens: 'l', proofRefs: [evidence[0].id], hookVariants: [{ text: 'Tested hook', format: 'question' }, { text: 'Candidate hook', format: 'story' }] }],
    });
    await promoteHook(TENANT, ORG, deterministicHookId(TENANT, ORG, 'Tested hook'), 'tested');
    const asm = as<{ hooks: Array<{ text: string; id: string }> }>(await surface.assembleContext({ briefId }));
    expect(asm.hooks.map((h) => h.text)).toEqual(['Tested hook']);
  });
});

describe('generate-angles node — index→id mapping + typed failures', () => {
  function ctx(callAI: unknown, briefId: string) {
    return { features: { 'campaign-brief': buildCampaignBriefSurface({ tenantId: TENANT }) }, callAI, inputs: { briefId } };
  }

  it('maps cited evidence indexes to stored ids and persists via the surface', async () => {
    const { briefId } = await briefWithEvidence();
    const callAI = vi.fn(async () => ({
      data: { angles: [{ claim: 'Fastest', positioningLens: 'speed', evidenceIndexes: [0, 99], hookVariants: [{ text: 'Two hours, gone.', format: 'bold-claim' }] }] },
    }));
    const out = as<{ status: string; outputs: { angles: Array<{ proofRefs: string[] }>; emittedHooks: unknown[] } }>(
      await nodePack['feature.campaign-brief.nodes.generate-angles'](ctx(callAI, briefId)),
    );
    expect(out.status).toBe('success');
    const nodeView = await listVocEvidence(TENANT, briefId); // the node's own list order
    expect(out.outputs.angles[0].proofRefs).toEqual([nodeView[0].id]); // 99 silently ignored, 0 mapped
    expect(out.outputs.emittedHooks).toHaveLength(1);
    expect(callAI).toHaveBeenCalledTimes(1);
  });

  it('fails typed without a kernel', async () => {
    const brief = await createBrief(TENANT, ORG, 'u1', { name: 'NK', productName: 'P' });
    await persistVocEvidence(TENANT, ORG, brief.id, 'u1', [{ quote: 'q', sourceRef: REF, theme: 't', sentiment: 'pain' }]);
    const out = as<{ status: string; error: { code: string } }>(await nodePack['feature.campaign-brief.nodes.generate-angles'](ctx(vi.fn(), brief.id)));
    expect(out).toMatchObject({ status: 'failed', error: { code: 'kernel_required' } });
  });

  it('fails typed without stored evidence', async () => {
    const brief = await createBrief(TENANT, ORG, 'u1', { name: 'NE', productName: 'P' });
    await setKernel(TENANT, brief.id, KERNEL);
    const out = as<{ status: string; error: { code: string } }>(await nodePack['feature.campaign-brief.nodes.generate-angles'](ctx(vi.fn(), brief.id)));
    expect(out).toMatchObject({ status: 'failed', error: { code: 'grounding_insufficient' } });
  });

  it('all-ungrounded after ONE repair is a typed generation_ungrounded failure', async () => {
    const { briefId } = await briefWithEvidence();
    const callAI = vi.fn(async () => ({ data: { angles: [{ claim: 'X', positioningLens: 'y', evidenceIndexes: [42], hookVariants: [] }] } }));
    const out = as<{ status: string; error: { code: string } }>(await nodePack['feature.campaign-brief.nodes.generate-angles'](ctx(callAI, briefId)));
    expect(out).toMatchObject({ status: 'failed', error: { code: 'generation_ungrounded' } });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(await listAngles(TENANT, briefId)).toHaveLength(0);
  });
});

describe('build-targeting node + surface — platform packs', () => {
  function ctx(callAI: unknown, briefId: string, platform: string) {
    return { features: { 'campaign-brief': buildCampaignBriefSurface({ tenantId: TENANT }) }, callAI, inputs: { briefId, platform } };
  }

  it('persists THE brief+platform pack with mapped evidenceRefs; a re-run replaces it', async () => {
    const { briefId } = await briefWithEvidence();
    const mkAI = (kw: string) => vi.fn(async () => ({ data: { audiences: ['ops directors'], interests: ['warehouse automation'], keywords: [kw], rationale: 'Derived from [0].', evidenceIndexes: [0] } }));
    const first = as<{ status: string; outputs: { pack: { keywords: string[]; evidenceRefs: string[] } } }>(
      await nodePack['feature.campaign-brief.nodes.build-targeting'](ctx(mkAI('picking speed'), briefId, 'meta')),
    );
    expect(first.status).toBe('success');
    const nodeView = await listVocEvidence(TENANT, briefId);
    expect(first.outputs.pack.evidenceRefs).toEqual([nodeView[0].id]);
    const second = as<{ status: string }>(await nodePack['feature.campaign-brief.nodes.build-targeting'](ctx(mkAI('recount waste'), briefId, 'meta')));
    expect(second.status).toBe('success');
    const packs = await listTargetingPacks(TENANT, briefId);
    expect(packs).toHaveLength(1); // replaced, not duplicated
    expect(packs[0].keywords).toEqual(['recount waste']);
  });

  it('rejects an unknown platform typed', async () => {
    const { briefId } = await briefWithEvidence();
    const out = as<{ status: string; error: { code: string } }>(await nodePack['feature.campaign-brief.nodes.build-targeting'](ctx(vi.fn(), briefId, 'myspace')));
    expect(out).toMatchObject({ status: 'failed', error: { code: 'missing_input' } });
  });

  it('ungrounded after ONE repair is a typed failure; nothing persists', async () => {
    const { briefId } = await briefWithEvidence();
    const callAI = vi.fn(async () => ({ data: { audiences: ['a'], interests: [], keywords: [], rationale: 'r', evidenceIndexes: [] } }));
    const out = as<{ status: string; error: { code: string } }>(await nodePack['feature.campaign-brief.nodes.build-targeting'](ctx(callAI, briefId, 'google')));
    expect(out).toMatchObject({ status: 'failed', error: { code: 'generation_ungrounded' } });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(await listTargetingPacks(TENANT, briefId)).toHaveLength(0);
  });
});

describe('brief-delete cascade — org hook bank survives', () => {
  it('deleting the brief removes angles + targeting but keeps the org hook bank', async () => {
    const { briefId, evidence } = await briefWithEvidence();
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    await surface.persistAngles({ briefId, candidates: [{ claim: 'C', positioningLens: 'l', proofRefs: [evidence[0].id], hookVariants: [{ text: 'Keep me', format: 'question' }] }] });
    await surface.persistTargeting({ briefId, candidate: { platform: 'meta', audiences: ['a'], interests: [], keywords: [], rationale: 'r', evidenceRefs: [evidence[0].id] } });
    await deleteBrief(TENANT, briefId, 'u1');
    expect(await listAngles(TENANT, briefId)).toHaveLength(0);
    expect(await listTargetingPacks(TENANT, briefId)).toHaveLength(0);
    expect(await listHooks(TENANT, ORG)).toHaveLength(1); // the bank outlives the brief
  });
});

describe('artifact-type pack ↔ TS SSoT parity (Phases 2-3)', () => {
  it('ad-angle / hook / targeting-pack schemas mirror their services', () => {
    const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
    const pack = JSON.parse(readFileSync(join(REPO_ROOT, 'packs', 'feature.campaign-brief.artifact-types', 'pack.json'), 'utf8'));
    const byId = new Map<string, { schema: Record<string, any> }>(pack.artifactTypes.map((t: { artifactTypeId: string }) => [t.artifactTypeId, t]));

    const angle = byId.get('campaign-brief.ad-angle');
    expect(angle, 'campaign-brief.ad-angle must be declared').toBeTruthy();
    expect(angle!.schema.properties.claim.maxLength).toBe(ANGLE_LIMITS.claimMax);
    expect(angle!.schema.properties.positioningLens.maxLength).toBe(ANGLE_LIMITS.lensMax);
    expect(angle!.schema.properties.proofRefs.minItems).toBe(1);
    expect(angle!.schema.properties.proofRefs.maxItems).toBe(ANGLE_LIMITS.maxProofRefs);
    expect(angle!.schema.properties.hookVariants.maxItems).toBe(ANGLE_LIMITS.maxHooksPerAngle);
    expect(angle!.schema.properties.hookVariants.items.properties.text.maxLength).toBe(ANGLE_LIMITS.hookTextMax);

    const hook = byId.get('campaign-brief.hook');
    expect(hook, 'campaign-brief.hook must be declared (namespaced, not bare `hook`)').toBeTruthy();
    expect(hook!.schema.properties.status.enum).toEqual(['candidate', 'tested', 'retired']);
    expect(hook!.schema.properties.text.maxLength).toBe(HOOK_LIMITS.textMax);
    expect(hook!.schema.properties.metricRef.maxLength).toBe(HOOK_LIMITS.metricRefMax);

    const targeting = byId.get('campaign-brief.targeting-pack');
    expect(targeting, 'campaign-brief.targeting-pack must be declared').toBeTruthy();
    expect(targeting!.schema.properties.platform.enum).toEqual([...TARGETING_PLATFORMS]);
    expect(targeting!.schema.properties.audiences.maxItems).toBe(TARGETING_LIMITS.listMax);
    expect(targeting!.schema.properties.rationale.maxLength).toBe(TARGETING_LIMITS.rationaleMax);
    expect(targeting!.schema.properties.evidenceRefs.maxItems).toBe(TARGETING_LIMITS.maxEvidenceRefs);
  });
});
