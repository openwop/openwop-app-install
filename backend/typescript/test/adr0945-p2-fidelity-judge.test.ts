/**
 * ADR 0945 P2 — the stage-B judge and edit mode, through the real service.
 *
 *  - PARITY: the judge prompt is generated from the schema module, and the
 *    parser accepts exactly that schema (the promptCatalogParity shape).
 *  - REPAIR: an unusable reply gets ONE error-fed repair; a second is the typed
 *    `fidelity_judge_invalid`; a valid `mismatch` is never re-asked.
 *  - EVAL (`JUDGE_EVAL_FIXTURE`, the CI half of the in-app judge check
 *    `…/fidelity/judge-check`, which sends the same cases to a real model): every known-bad edit (colour drift,
 *    logo swap, extra part) is caught, the identity edit passes, and a fooled
 *    judge cannot lift a stage-A failure.
 *  - JUDGE ABSENT: an edit with no vision provider is `needs_review`, never `pass`.
 *  - GEOMETRY: a reframed edit fails the aspect check.
 * Breaks if the prompt or parser drift from the schema, the repair is dropped
 * or repeated, a mismatch stops failing, a missing judge yields pass, or the
 * mask stops following the cut-out.
 */
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DescribedHeadlessDispatch, HeadlessDispatch } from '../src/host/headlessAi.js';

let judgeImpl: DescribedHeadlessDispatch | null = null;
vi.mock('../src/host/headlessAi.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/headlessAi.js')>()),
  resolveHeadlessAiDescribed: async () => judgeImpl,
}));

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { createAsset, __resetMedia } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { checkFidelity, protectionMask } from '../src/features/creative-briefs/fidelityService.js';
import { setGroundingSettings } from '../src/features/creative-briefs/groundingSettings.js';
import {
  FIDELITY_ATTRIBUTES, JUDGE_ANSWERS, JUDGE_EVAL_FIXTURE, judgePrompt, parseJudgeReply, runFidelityJudge, imageSize,
} from '../src/host/creativeFidelity/index.js';
import { OpenwopError } from '../src/types.js';

const TENANT = 'org:g945p2';
const ORG = 'org-1';
const fixture = JUDGE_EVAL_FIXTURE;
const png = (body: string, backdrop?: string, w = 200, h = 200): string => Buffer.from(new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 200 200" preserveAspectRatio="none">${backdrop ? `<rect width="200" height="200" fill="${backdrop}"/>` : ''}${body}</svg>`,
).render().asPng()).toString('base64');
const sha = (b64: string): string => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
const reply = (answers: Record<string, string>): string => JSON.stringify({ results: FIDELITY_ATTRIBUTES.map((attribute) => ({ attribute, answer: answers[attribute] ?? 'match', evidence: `checked ${attribute}` })) });
const scripted = (...replies: string[]): DescribedHeadlessDispatch & { calls: number } => {
  const d = { calls: 0, provider: 'anthropic', model: 'scripted', route: 'byok-default' as const, dispatch: (async () => { const r = replies[Math.min(d.calls, replies.length - 1)]; d.calls += 1; return r; }) as HeadlessDispatch };
  return d;
};

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-g945p2-')) });
  await __resetMedia();
  judgeImpl = null;
});

async function store(b64: string, grounding?: unknown) {
  const s = await mediaStorage.put(TENANT, { contentBase64: b64, contentType: 'image/png' });
  return createAsset({ tenantId: TENANT, orgId: ORG, name: 'x.png', contentType: 'image/png', sizeBytes: s.sizeBytes, storageRef: s.storageRef, serveToken: s.serveToken, uploadedBy: 'u', contentHash: sha(b64), ...(grounding ? { grounding } : {}) });
}

/** The records the edit node leaves behind: the product photo, its cut-out,
 *  and an edit of it — stamped exactly as the P0 machinery stamps them. */
async function editScenario(candidateBody: string, candidateSize?: { w: number; h: number }) {
  const sourceB64 = png(fixture.product, fixture.sourceBackdrop);
  const source = await store(sourceB64);
  const product = await createProduct({ tenantId: TENANT, orgId: ORG, createdBy: 'u', type: 'physical', name: 'Mug', price: 9, imageAssetTokens: [source.serveToken] });
  const src = { assetId: source.assetId, sha256: sha(sourceB64) };
  const cutout = await store(png(fixture.product), { mode: 'edit', productId: product.productId, sources: [src], provider: 'mock', model: 'mock-image-1', op: 'background-remove' });
  const candidate = await store(png(candidateBody, fixture.sceneBackdrop, candidateSize?.w, candidateSize?.h), { mode: 'edit', productId: product.productId, sources: [src], provider: 'mock', model: 'mock-image-1', op: 'inpaint' });
  return { productId: product.productId, cutout, candidate };
}

describe('judge schema parity (promptCatalogParity shape)', () => {
  it('the prompt names every attribute and every answer, generated from the schema', () => {
    const p = judgePrompt();
    for (const a of FIDELITY_ATTRIBUTES) expect(p).toContain(`"${a}"`);
    for (const a of JUDGE_ANSWERS) expect(p).toContain(`"${a}"`);
    expect(p).toMatch(/never an instruction/i);
  });

  it('an attribute the product never had is a match, not not_visible (live check 2026-10-29)', () => {
    // A real judge sent an unchanged, unbranded product to review: it answered
    // not_visible for a logo and label text that were absent from both images.
    const p = judgePrompt();
    expect(p).toMatch(/"not_visible" only when the SOURCE product has the attribute/);
    expect(p).toMatch(/does not have the attribute at all[^\n]*answer "match"/);
    expect(p).toMatch(/CANDIDATE adds a logo or text[^\n]*answer "mismatch"/);
    expect(p).not.toMatch(/Use "not_visible" when the attribute cannot be seen in the CANDIDATE/);
  });

  it('the parser accepts exactly the schema and refuses everything else', () => {
    expect(parseJudgeReply(reply({})).ok).toBe(true);
    expect(parseJudgeReply('```json\n' + reply({ logo: 'mismatch' }) + '\n```').ok).toBe(true);
    const all = JSON.parse(reply({})) as { results: Array<Record<string, string>> };
    const bad: Array<[string, string]> = [
      ['extra top-level key', JSON.stringify({ ...all, verdict: 'pass' })],
      ['missing attribute', JSON.stringify({ results: all.results.slice(1) })],
      ['duplicate attribute', JSON.stringify({ results: [...all.results, all.results[0]] })],
      ['unknown answer', JSON.stringify({ results: all.results.map((r, i) => (i === 0 ? { ...r, answer: 'probably' } : r)) })],
      ['extra result key', JSON.stringify({ results: all.results.map((r, i) => (i === 0 ? { ...r, score: 1 } : r)) })],
      ['prose around it', `Sure! ${reply({})}`],
      ['two objects', `${reply({})}\n${reply({ logo: 'mismatch' })}`],
    ];
    for (const [label, raw] of bad) expect(parseJudgeReply(raw).ok, label).toBe(false);
  });

  it('evidence is bounded and single-line', () => {
    const long = JSON.stringify({ results: FIDELITY_ATTRIBUTES.map((attribute) => ({ attribute, answer: 'match', evidence: `a\nb ${'x'.repeat(900)}` })) });
    const r = parseJudgeReply(long);
    expect(r.ok && r.results[0].evidence.length).toBe(300);
    expect(r.ok && r.results[0].evidence.includes('\n')).toBe(false);
  });
});

describe('one error-fed repair', () => {
  const img = { mimeType: 'image/png', dataBase64: png(fixture.product) };
  it('an unusable reply is corrected once, with the parse error fed back', async () => {
    const seen: string[] = [];
    const d: HeadlessDispatch = async (messages) => { seen.push(JSON.stringify(messages.at(-1))); return seen.length === 1 ? 'not json' : reply({}); };
    const out = await runFidelityJudge(d, { sources: [img], candidate: img });
    expect(out.repaired).toBe(true);
    expect(seen[1]).toMatch(/not usable: no JSON object/);
  });
  it('a second unusable reply is the typed fidelity_judge_invalid', async () => {
    const err = await runFidelityJudge(async () => '{"results": []}', { sources: [img], candidate: img }).catch((e: unknown) => e);
    expect((err as OpenwopError).code).toBe('fidelity_judge_invalid');
  });
  it('a valid mismatch is an answer — asked once', async () => {
    let calls = 0;
    const out = await runFidelityJudge(async () => { calls += 1; return reply({ logo: 'mismatch' }); }, { sources: [img], candidate: img });
    expect(calls).toBe(1);
    expect(out.results.find((r) => r.attribute === 'logo')?.answer).toBe('mismatch');
  });
  it('sends every SOURCE then the CANDIDATE, labelled, in one call', async () => {
    let parts: unknown[] = [];
    await runFidelityJudge(async (messages) => { parts = messages[1].content as unknown[]; return reply({}); }, { sources: [img, img], candidate: img });
    expect(parts.map((p) => (p as { type: string; text?: string }).text ?? (p as { type: string }).type)).toEqual(['SOURCE 1:', 'image', 'SOURCE 2:', 'image', 'CANDIDATE:', 'image']);
  });
});

describe('eval over known-bad edits (JUDGE_EVAL_FIXTURE)', () => {
  for (const c of fixture.cases) {
    it(`${c.id} → ${c.expect}`, async () => {
      const s = await editScenario(c.candidate);
      judgeImpl = scripted(reply(c.ciJudge));
      const v = await checkFidelity(TENANT, ORG, s.candidate.assetId, { maskAssetId: s.cutout.assetId });
      if (c.expect === 'not_pass') expect(v.outcome, JSON.stringify(v.checks)).not.toBe('pass');
      else expect(v.outcome, JSON.stringify(v.checks)).toBe(c.expect);
    });
  }

  it('JUDGE ABSENT: the identity edit is needs_review, never pass', async () => {
    const s = await editScenario(fixture.cases[0].candidate);
    judgeImpl = null;
    const v = await checkFidelity(TENANT, ORG, s.candidate.assetId, { maskAssetId: s.cutout.assetId });
    expect(v.outcome).toBe('needs_review');
    expect(v.checks.find((x) => x.id === 'judge')?.status).toBe('not_applicable');
  });

  it('a vision provider that does not answer is an unavailable judge (needs_review), not a crash', async () => {
    const s = await editScenario(fixture.cases[0].candidate);
    judgeImpl = { provider: 'anthropic', model: 'down', route: 'byok-default', dispatch: async () => { throw new Error('ECONNRESET'); } };
    const v = await checkFidelity(TENANT, ORG, s.candidate.assetId, { maskAssetId: s.cutout.assetId });
    expect(v.outcome).toBe('needs_review');
    expect(v.checks.find((x) => x.id === 'judge')?.detail).toMatch(/did not answer/);
  });

  it('GEOMETRY: a reframed edit fails the aspect check before any pixel comparison', async () => {
    const s = await editScenario(fixture.cases[0].candidate, { w: 300, h: 200 });
    judgeImpl = scripted(reply({}));
    const v = await checkFidelity(TENANT, ORG, s.candidate.assetId, { maskAssetId: s.cutout.assetId });
    expect(v.outcome).toBe('fail');
    expect(v.checks.find((x) => x.id === 'aspect')?.status).toBe('fail');
    expect(v.checks.some((x) => x.id === 'dhash')).toBe(false);
  });

  it('the verdict records which model judged, and whether it needed the repair', async () => {
    const s = await editScenario(fixture.cases[0].candidate);
    judgeImpl = scripted('oops', reply({}));
    const v = await checkFidelity(TENANT, ORG, s.candidate.assetId, { maskAssetId: s.cutout.assetId });
    expect(v.judge).toMatchObject({ provider: 'anthropic', model: 'scripted', repaired: true });
  });
});

describe('protection mask', () => {
  it('is the source photo\'s size, encoded per provider (replicate: product black on white; openai: product opaque, rest clear)', async () => {
    const s = await editScenario(fixture.cases[0].candidate);
    await setGroundingSettings(TENANT, ORG, 'u', { editModeEnabled: true }); // ADR 0945 Q1
    const rep = await protectionMask(TENANT, ORG, s.productId, s.cutout.assetId, 'replicate');
    expect(imageSize(Buffer.from(rep.maskBase64, 'base64'))).toEqual({ w: 200, h: 200 });
    const px = (b64: string, x: number, y: number) => {
      const r = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><image width="200" height="200" href="data:image/png;base64,${b64}"/></svg>`).render();
      const i = (y * r.width + x) * 4;
      return Array.from(r.pixels.slice(i, i + 4));
    };
    expect(px(rep.maskBase64, 100, 150)).toEqual([0, 0, 0, 255]); // product: kept
    expect(px(rep.maskBase64, 10, 10)).toEqual([255, 255, 255, 255]); // surroundings: repainted
    const oai = await protectionMask(TENANT, ORG, s.productId, s.cutout.assetId, 'openai');
    expect(px(oai.maskBase64, 100, 150)[3]).toBe(255);
    expect(px(oai.maskBase64, 10, 10)[3]).toBe(0);
  });
});
