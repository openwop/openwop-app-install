/**
 * Campaign Brief — context assembler + surface + kernel node (ADR 0156 Phase 3).
 * Pure assembler unit tests + surface tenant-isolation + the kernel node over a
 * stubbed 3-surface ctx (campaign-brief + brand + kb) and a stub ctx.callAI.
 * BRIEF-1 (order-insensitive protected-field diff) and R2 CB-SP-9 (model output
 * alone never advances status) are sabotage-witnessed regression pins here.
 *
 * Wave 30 (grade-tests): fixtures are full typed rows (no casts); the node set is
 * pinned to the pack MANIFEST (module ↔ pack.json parity), not a hand list. Two
 * product defects were pinned as `it.fails` (CB-SEEDS-1, CB-KERNEL-1); both are
 * fixed by ADR 1020 and now assert the correct behaviour.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createPersona, __clearPersonas } from '../src/features/campaign-brief/personaService.js';
import { createBrief, updateBrief, setKernel, getBrief, __clearBriefs } from '../src/features/campaign-brief/briefService.js';
import { assembleBriefContextText } from '../src/features/campaign-brief/briefContext.js';
import { buildCampaignBriefSurface } from '../src/features/campaign-brief/surface.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-brief.nodes/index.mjs';
import type { CampaignBrief, Persona } from '../src/features/campaign-brief/types.js';

const TENANT = 'tenant-kernel';
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }

describe('briefContext.assembleBriefContextText (pure)', () => {
  it('composes product, audience (buyer-stage guidance), and messaging', () => {
    const brief: CampaignBrief = {
      id: 'b1', tenantId: TENANT, orgId: 'o1', name: 'Q4', objective: 'Leads', personaIds: ['p1'],
      productName: 'FlashPick', productDescription: 'Grocery automation', industryVertical: 'Grocery',
      channels: [], status: 'draft', kernelStale: false, createdBy: 'u1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
      messaging: { primaryValueProp: 'Pick faster', toneOverride: '', proofPoints: ['40% faster'], ctaStrategy: 'Demo' },
    };
    const personas: Persona[] = [{
      id: 'p1', tenantId: TENANT, orgId: 'o1', name: 'Ops Director', role: 'Ops', buyerStage: 'product_aware', painPoints: ['labor'],
      objections: ['cost'], goals: ['save'], demographics: 'Mid-market', createdBy: 'u1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
    }];
    const text = assembleBriefContextText(brief, personas);
    expect(text).toContain('# Campaign: Q4');
    expect(text).toContain('FlashPick');
    expect(text).toContain('Ops Director');
    expect(text).toContain('handle objections'); // product_aware guidance
    expect(text).toContain('40% faster');
  });
});

describe('campaign-brief surface', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearPersonas();
    await __clearBriefs();
  });

  it('assembleContext returns context + enabled channels; isolates tenants', async () => {
    const persona = await createPersona(TENANT, 'o1', 'u1', { name: 'Ops', buyerStage: 'problem_aware' });
    const brief = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp', productName: 'FlashPick', personaIds: [persona.id],
      messaging: { primaryValueProp: 'Faster' },
      channels: [{ type: 'landing_page', enabled: true, config: {} }],
    });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    const out = as<{ found: boolean; contextText: string; enabledChannels: string[]; valid: boolean }>(await surface.assembleContext({ briefId: brief.id }));
    expect(out.found).toBe(true);
    expect(out.contextText).toContain('Ops');
    expect(out.enabledChannels).toEqual(['landing_page']);

    const foreign = buildCampaignBriefSurface({ tenantId: 'other' });
    expect(as<{ found: boolean }>(await foreign.assembleContext({ briefId: brief.id })).found).toBe(false);
  });
});

describe('feature.campaign-brief.nodes — node pack', () => {
  it('exports the full ADR 0156/0356/0403 node set', () => {
    // Module ↔ manifest parity: every declared node has a handler and vice versa.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packs', 'feature.campaign-brief.nodes', 'pack.json'), 'utf8')) as { nodes: Array<{ typeId: string }> };
    const declared = manifest.nodes.map((n) => n.typeId).sort();
    expect(declared).toHaveLength(14); // + promote-kernel (ADR 1020 D8)
    expect(Object.keys(nodePack).sort()).toEqual(declared);
  });

  it('fails closed with host_capability_missing when the surface is absent', async () => {
    await expect(nodePack['feature.campaign-brief.nodes.validate']({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('generate-kernel composes brand + kb + callAI and persists', async () => {
    const calls: Record<string, unknown> = {};
    const features = {
      'campaign-brief': {
        assembleContext: async () => ({ found: true, brief: { id: 'b1', orgId: 'o1', brandId: 'brand-1', kbCollectionId: 'kb-1', productName: 'FlashPick', industryVertical: 'Grocery' }, contextText: 'CONTEXT', valid: true, enabledChannels: ['landing_page'] }),
        setKernel: async (a: unknown) => { calls.setKernel = a; return { brief: { id: 'b1' } }; },
      },
      brand: { resolveVoice: async () => ({ voice: 'VOICE' }) },
      // Real kb.rag citations carry `documentId` (KB-CODE-1); the legacy `docId`
      // shape is still read as a fallback — pin both.
      kb: { rag: async () => ({ augmentedPrompt: 'GROUNDED', citations: [{ documentId: 'doc-7', title: 'D7' }, { docId: 'doc-legacy' }] }) },
    };
    const callAI = async (req: { messages: Array<{ content: string }> }) => {
      calls.prompt = req.messages[0].content;
      return { data: { headline: 'Pick faster', supportingStatement: 'Save hours', proofPoints: ['40%'], primaryCta: 'Demo', tone: 'confident' } };
    };
    const out = await nodePack['feature.campaign-brief.nodes.generate-kernel']({ features, callAI, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('success');
    const kernel = out.outputs?.kernel as Record<string, unknown>;
    expect(kernel.headline).toBe('Pick faster');
    expect(kernel.sourceDocIds).toEqual(['doc-7', 'doc-legacy']); // KB citation tracing (real shape + legacy fallback)
    expect(String(calls.prompt)).toContain('VOICE'); // brand voice composed
    expect(String(calls.prompt)).toContain('GROUNDED'); // KB grounding composed
    expect((calls.setKernel as { briefId: string }).briefId).toBe('b1'); // persisted
  });

  it('generate-kernel fails closed when the brief is missing', async () => {
    const features = { 'campaign-brief': { assembleContext: async () => ({ found: false }), setKernel: async () => ({}) } };
    const out = await nodePack['feature.campaign-brief.nodes.generate-kernel']({ features, callAI: async () => ({}), inputs: { briefId: 'nope' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('brief_not_found');
  });
});

// CB-SEEDS-1 (wave 30; CLOSED by ADR 1020 D12) — extract-seeds returned
// `status:'success'` with `proposals: {}` when the model returned NOTHING: invalid
// model output reported as success-with-empty (CLAUDE.md non-negotiable). It is now
// a typed `generation_empty` after ONE error-fed repair.
describe('CB-SEEDS-1 — extract-seeds never reports an empty model reply as success', () => {
  it('an empty model reply is a typed failure', async () => {
    const callAI = async () => ({ data: undefined });
    const kb = { rag: async () => ({ augmentedPrompt: '[0] FlashPick buyers are ops directors.', citations: [{ documentId: 'd1' }], coverage: 'ok' }) };
    const out = await nodePack['feature.campaign-brief.nodes.extract-seeds']({ features: { kb }, callAI, inputs: { orgId: 'o1', collectionId: 'c1' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBeTruthy();
  });
});

// CB-KERNEL-1 (wave 30; CLOSED by ADR 1020, `cleanKernel`) — surface.setKernel
// persisted `args.kernel as MessagingKernel` with NO validation, so any surface
// caller could write a malformed kernel onto the brief (and advance its status).
// It is now a typed 422 and the stored brief is untouched.
describe('CB-KERNEL-1 — the kernel write is closed-world', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBriefs();
  });

  it('a malformed kernel is refused and never persisted', async () => {
    const brief = await createBrief(TENANT, 'o1', 'u1', { name: 'Camp', productName: 'FlashPick' });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    await expect(surface.setKernel!({ briefId: brief.id, kernel: { headline: 42, proofPoints: 'not-an-array' } }))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect((await getBrief(TENANT, brief.id))!.kernel).toBeUndefined();
  });
});

describe('protected-field re-approval (BRIEF-1) — order-insensitive diff', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBriefs();
  });

  const KERNEL = {
    headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
    tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
  };

  it('does NOT demote a confirmed brief when a re-send only reorders open channel.config keys', async () => {
    const brief = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp', productName: 'FlashPick',
      channels: [{ type: 'landing_page', enabled: true, config: { a: '1', b: '2', c: '3' } }],
    });
    await setKernel(TENANT, brief.id, KERNEL);
    await updateBrief(TENANT, brief.id, { status: 'confirmed' }, 'u1');

    // Re-send the SAME content with config keys in a different order.
    const updated = await updateBrief(TENANT, brief.id, {
      channels: [{ type: 'landing_page', enabled: true, config: { c: '3', a: '1', b: '2' } }],
    }, 'u1');

    expect(updated!.status).toBe('confirmed'); // NOT demoted to draft
    expect(updated!.kernelStale).not.toBe(true); // kernel still valid
    const reread = await getBrief(TENANT, brief.id);
    expect(reread!.status).toBe('confirmed');
  });

  it('R2 CB-SP-9: setKernel does NOT promote an INVALID brief to validated — model output alone cannot advance status', async () => {
    // No personas, no value prop — validateBrief fails. The old setKernel
    // force-promoted status:'validated' anyway, purely on model output, while
    // the tool/pack/prompt adverts all said generation never auto-approves.
    const brief = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp', productName: 'FlashPick',
      channels: [{ type: 'landing_page', enabled: true, config: {} }],
    });
    const after = await setKernel(TENANT, brief.id, KERNEL);
    expect(after!.status).toBe('draft'); // NOT promoted
    expect(after!.kernel).toBeTruthy(); // the kernel still saves — it is reviewable content

    // Polarity: a brief that actually VALIDATES still promotes.
    const valid = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp2', productName: 'FlashPick',
      personaIds: ['p1'],
      messaging: { primaryValueProp: 'Fast', proofPoints: [], ctaStrategy: '' },
      channels: [{ type: 'landing_page', enabled: true, config: {} }],
    });
    const promoted = await setKernel(TENANT, valid.id, KERNEL);
    expect(promoted!.status).toBe('validated');
  });

  it('STILL demotes when a protected field genuinely changes', async () => {
    const brief = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp', productName: 'FlashPick',
      channels: [{ type: 'landing_page', enabled: true, config: { a: '1' } }],
    });
    await setKernel(TENANT, brief.id, KERNEL);
    await updateBrief(TENANT, brief.id, { status: 'confirmed' }, 'u1');

    const updated = await updateBrief(TENANT, brief.id, { name: 'Renamed' }, 'u1');
    expect(updated!.status).toBe('draft'); // demoted — re-approval required
    expect(updated!.kernelStale).toBe(true);
  });
});

describe('vendor.openwop-app.campaign-brief.agents — agent pack', () => {
  it('loads the Brief Strategist with its tool-allowlist', () => {
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'vendor.openwop-app.campaign-brief.agents'));
    expect(loaded.length).toBe(1);
    expect(loaded[0].agentId).toBe('vendor.openwop-app.campaign-brief.agents.brief-strategist');
    // CFP-1: the Strategist now carries the REAL registered agent tools
    // (`openwop:campaign-brief.<verb>`) — `generate-kernel` ignites the
    // messaging-kernel builtin workflow (assemble → callAI → setKernel → human gate).
    expect([...(loaded[0].toolAllowlist ?? [])].sort()).toEqual([
      'openwop:campaign-brief.generate-kernel',
      'openwop:campaign-brief.get-brief',
      'openwop:campaign-brief.research.run',
      'openwop:campaign-brief.validate',
    ]);
  });
});

describe('ADR 1020 P2 — the kernel is saved only after its approval', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBriefs();
  });
  const GOOD = { headline: 'Pick faster', supportingStatement: 'Save hours', proofPoints: ['40%'], primaryCta: 'Demo', tone: 'confident' };
  const asmOf = (extra: Record<string, unknown> = {}) => ({ found: true, brief: { id: 'b1', orgId: 'o1', productName: 'FlashPick' }, contextText: 'CONTEXT', valid: true, enabledChannels: [], briefVersion: 3, ...extra });

  it('D8: with config.stageKernel, generate-kernel saves NOTHING and hands the kernel + its brief revision to the approval', async () => {
    let saved = 0;
    const features = { 'campaign-brief': { assembleContext: async () => asmOf(), setKernel: async () => { saved += 1; return { brief: { id: 'b1' } }; } } };
    const out = await nodePack['feature.campaign-brief.nodes.generate-kernel']({ features, config: { stageKernel: true }, callAI: async () => ({ data: GOOD }), inputs: { briefId: 'b1' } });
    expect(out).toMatchObject({ status: 'success', outputs: { staged: true, briefVersion: 3, priorKernelAt: null, kernel: { headline: 'Pick faster' } } });
    expect(saved).toBe(0);
  });

  it('CS70WF-19: a kernel with an empty field or no proof point is repaired once, then a typed failure', async () => {
    let calls = 0;
    const features = { 'campaign-brief': { assembleContext: async () => asmOf(), setKernel: async () => ({ brief: { id: 'b1' } }) } };
    const out = await nodePack['feature.campaign-brief.nodes.generate-kernel']({ features, config: { stageKernel: true }, callAI: async () => { calls += 1; return { data: { ...GOOD, proofPoints: [] } }; }, inputs: { briefId: 'b1' } });
    expect(calls).toBe(2);
    expect(out).toMatchObject({ status: 'failed', error: { code: 'generation_empty' } });
    expect(out.error?.message).toContain('no proof points');
  });

  it('D11: promote-kernel saves the approved kernel through the REAL surface, and refuses brief_changed when the brief was edited meanwhile', async () => {
    const brief = await createBrief(TENANT, 'o1', 'u1', { name: 'Camp', productName: 'FlashPick', messaging: { primaryValueProp: 'v' } });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    const kernel = { ...GOOD, secondaryCta: '', channelTones: {}, sourceDocIds: [], generatedAt: '2026-10-31T00:00:00Z' };
    const promote = nodePack['feature.campaign-brief.nodes.promote-kernel'];
    const v = (await getBrief(TENANT, brief.id))!.version ?? 1;
    // An edit lands while the kernel is out for review: the revision moves.
    await updateBrief(TENANT, brief.id, { productName: 'FlashPick Pro' });
    const stale = await promote({ features: { 'campaign-brief': surface }, inputs: { briefId: brief.id, kernel, briefVersion: v, priorKernelAt: null } });
    expect(stale).toMatchObject({ status: 'failed', error: { code: 'brief_changed' } });
    expect((await getBrief(TENANT, brief.id))!.kernel).toBeUndefined();
    // Against the current revision it saves, and clears stale.
    const now = (await getBrief(TENANT, brief.id))!.version ?? 1;
    const ok = await promote({ features: { 'campaign-brief': surface }, inputs: { briefId: brief.id, kernel, briefVersion: now, priorKernelAt: null } });
    expect(ok.status).toBe('success');
    expect((await getBrief(TENANT, brief.id))!.kernel?.headline).toBe('Pick faster');
  });

  it('grade-code M2: promote-kernel refuses a kernel that arrives without its brief revision (never saves unconditioned)', async () => {
    let saved = 0;
    const features = { 'campaign-brief': { setKernel: async () => { saved += 1; return { brief: { id: 'b1', status: 'validated' } }; }, assembleContext: async () => ({ found: true }) } };
    const out = await nodePack['feature.campaign-brief.nodes.promote-kernel']({ features, inputs: { briefId: 'b1', kernel: GOOD } });
    expect(out).toMatchObject({ status: 'failed', error: { code: 'validation_error' } });
    expect(saved).toBe(0);
  });

  it('grade-code M3: two kernels generated from the same state cannot both be approved — the second refuses instead of replacing the first', async () => {
    const brief = await createBrief(TENANT, 'o1', 'u1', { name: 'Camp', productName: 'FlashPick' });
    const v = (await getBrief(TENANT, brief.id))!.version ?? 1;
    const k = (headline: string, at: string) => ({ ...GOOD, headline, secondaryCta: '', channelTones: {}, sourceDocIds: [], generatedAt: at });
    // Both were generated when the brief had NO kernel (priorKernelAt null).
    await setKernel(TENANT, brief.id, k('First approved', '2026-10-31T00:00:01Z'), 'system', { expectedVersion: v, expectedPriorKernelAt: null });
    await expect(setKernel(TENANT, brief.id, k('Second, same state', '2026-10-31T00:00:02Z'), 'system', { expectedVersion: v, expectedPriorKernelAt: null }))
      .rejects.toMatchObject({ details: { reason: 'brief_changed' } });
    const after = (await getBrief(TENANT, brief.id))!;
    expect(after.kernel?.headline).toBe('First approved');
    expect(after.version ?? 1).toBe(v); // a kernel save is not a content revision
  });

  it('promote-kernel refuses when the workflow does not say which kernel it replaces', async () => {
    let saved = 0;
    const features = { 'campaign-brief': { setKernel: async () => { saved += 1; return { brief: { id: 'b1', status: 'validated' } }; }, assembleContext: async () => ({ found: true }) } };
    const out = await nodePack['feature.campaign-brief.nodes.promote-kernel']({ features, inputs: { briefId: 'b1', kernel: GOOD, briefVersion: 1 } });
    expect(out).toMatchObject({ status: 'failed', error: { code: 'validation_error' } });
    expect(saved).toBe(0);
  });

  it('a stale kernel makes angles fail kernel_stale (not "generate the kernel")', async () => {
    const features = { 'campaign-brief': { assembleContext: async () => ({ ...asmOf(), kernel: null, kernelStale: true }), listVocEvidence: async () => ({ evidence: [] }) } };
    const out = await nodePack['feature.campaign-brief.nodes.generate-angles']({ features, callAI: async () => ({}), inputs: { briefId: 'b1' } });
    expect(out).toMatchObject({ status: 'failed', error: { code: 'kernel_stale' } });
  });

  it('D8: a STALE kernel is not a usable kernel — assembleContext hands readers null and says why', async () => {
    const brief = await createBrief(TENANT, 'o1', 'u1', { name: 'Camp', productName: 'FlashPick' });
    await setKernel(TENANT, brief.id, { ...GOOD, secondaryCta: '', channelTones: {}, sourceDocIds: [], generatedAt: '2026-10-31T00:00:00Z' });
    await updateBrief(TENANT, brief.id, { productName: 'Changed' });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    const asm = as<{ kernel: unknown; kernelStale: boolean; briefVersion: number }>(await surface.assembleContext!({ briefId: brief.id }));
    expect(asm).toMatchObject({ kernel: null, kernelStale: true });
    expect(asm.briefVersion).toBe((await getBrief(TENANT, brief.id))!.version);
  });

  it('D12: extract-seeds repairs an empty reply once, and maps each persona\'s [n] sources to the retrieved documents', async () => {
    let calls = 0;
    const kb = { rag: async () => ({
      augmentedPrompt: '[1] (A) ops directors\n\n[2] (B) store managers',
      contexts: [{ documentId: 'doc-a', text: 'ops directors' }, { documentId: 'doc-b', text: 'store managers' }],
      citations: [{ documentId: 'doc-a' }, { documentId: 'doc-b' }],
      coverage: 'ok',
    }) };
    const callAI = async () => {
      calls += 1;
      return calls === 1 ? { data: {} } : { data: { personas: [{ name: 'Ops Director', sources: [2, 9, 1] }], productSummary: '', competitors: [] } };
    };
    const out = await nodePack['feature.campaign-brief.nodes.extract-seeds']({ features: { kb }, callAI, inputs: { orgId: 'o1', collectionId: 'c1' } });
    expect(calls).toBe(2);
    expect(out.status).toBe('success');
    const persona = (out.outputs?.proposals as { personas: Array<Record<string, unknown>> }).personas[0]!;
    expect(persona.sourceDocIds).toEqual(['doc-b', 'doc-a']); // [9] names no retrieved block and is dropped
    expect(persona).not.toHaveProperty('sources');
  });
});

describe('ADR 1020 D11 (CS70WF-15) — a brief edit and a kernel save never drop each other', () => {
  it('an edit whose compare-and-swap loses to a concurrent kernel save re-reads and keeps BOTH writes', async () => {
    const base = openSqliteStorage(':memory:');
    let injected = false;
    // A storage whose FIRST brief swap loses: a concurrent writer saves a kernel on
    // the same row between the edit's read and its swap. The plain get-then-put
    // this replaces would have overwritten that kernel.
    const racing = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      kvCompareAndSwap: async (key: string, expected: string | null, next: string) => {
        if (!injected && key.includes('campaign-brief:brief:') && expected !== null) {
          injected = true;
          const row = JSON.parse(expected) as Record<string, unknown>;
          await base.kvSet(key, JSON.stringify({ ...row, kernel: { headline: 'Concurrent' }, updatedAt: 'concurrent' }));
        }
        return base.kvCompareAndSwap(key, expected, next);
      },
    });
    initHostExtPersistence(racing);
    await __clearBriefs();
    const brief = await createBrief(TENANT, 'o1', 'u1', { name: 'Camp', productName: 'FlashPick' });
    await updateBrief(TENANT, brief.id, { objective: 'Leads' });
    expect(injected).toBe(true);
    const after = (await getBrief(TENANT, brief.id))!;
    expect(after.objective).toBe('Leads'); // the edit landed…
    expect((after.kernel as { headline: string } | undefined)?.headline).toBe('Concurrent'); // …and did not erase the other write
  });
});
