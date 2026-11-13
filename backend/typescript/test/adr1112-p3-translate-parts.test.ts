/**
 * ADR 1112 P3 — AI translation of a large scheduleSim, in parts.
 *
 * Pins:
 *  - the model is sent words and ids only: behaviour keys come back from the base;
 *  - a section over one reply's size is split in order, each part at most AI_BATCH_CHARS,
 *    the first carrying everything but the later decisions; past AI_SECTION_MAX_BATCHES
 *    parts the typed `too_large` refusal stays, before any model call;
 *  - the parts join into one overlay with every decision translated and aligned by id;
 *  - a part that drops a decision gets the one repair, then a typed `items_missing`;
 *  - the first failed part stops the others, and one deadline bounds them all (`timeout`);
 *  - the sweep charges a section its parts, and leaves one that would overrun the budget
 *    whole for the next submit.
 *
 * Sabotage, each restored, each red: send the payload unstripped; drop the item-count
 * check or the id check; merge only the first part's decisions; charge the sweep one call per section;
 * drop the abort on a failed part; drop the deadline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

import { resolveHeadlessAi, type HeadlessDispatch } from '../src/host/headlessAi.js';
import { stampSourceDigests, translationStatus, validateSection, type Section } from '../src/features/cms/cmsService.js';
import {
  AI_BATCH_CHARS, AI_SECTION_MAX_BATCHES, AI_TRANSLATE_DEADLINE_MS,
  autoTranslateMissingOverlays, planSectionTranslation, translateSectionData, translationPayload,
} from '../src/features/cms/translate.js';

type Raw = Record<string, unknown>;
const mockResolve = vi.mocked(resolveHeadlessAi);

const milestones = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, label: `Milestone ${i + 1}`, startWeek: i * 4, weeks: 4, floatDays: 3 }));
const roles = ['client', 'designer', 'builder'].map((key) => ({ key, label: key }));
function catalog(n: number): Raw[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `DEC-${String(i).padStart(5, '0')}`,
    title: `What finish and size does item ${i} need for t`.slice(0, 39),
    element: `Kitchen layout and work zones ${i}`.slice(0, 33),
    milestone: `m${(i % 12) + 1}`, role: roles[i % 3]?.key,
    lockWeek: (i % 12) * 4 + 2, leadDays: (i % 7) * 7, ...(i % 3 === 0 ? { back: true } : {}),
    ...(i > 0 && i % 8 !== 0 ? { dependsOn: [`DEC-${String(i - 1).padStart(5, '0')}`] } : {}),
  }));
}
const sim = (n: number): Raw => validateSection({ type: 'scheduleSim', data: { startDate: '2027-03-01', roles, milestones, decisions: catalog(n) } }, 'en', 't1').data;

/** The JSON a prompt carries (buildTranslationPrompt puts it after a blank line). */
const sent = (messages: readonly { content: unknown }[]): Raw => {
  const user = String(messages.find((m, i) => i > 0 && typeof m.content === 'string' && m.content.startsWith('Translate'))?.content ?? '');
  return JSON.parse(user.slice(user.indexOf('\n\n') + 2)) as Raw;
};
/** A model that "translates" every title and label, keeping the structure. */
const es = (v: unknown, key = ''): unknown => {
  if (Array.isArray(v)) return v.map((x) => es(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, es(x, k)]));
  return typeof v === 'string' && (key === 'title' || key === 'label') ? `ES ${v}`.slice(0, 39) : v;
};
function model(reply: (part: Raw, call: number) => unknown = (p) => es(p)) {
  const parts: Raw[] = [];
  const dispatch = vi.fn<HeadlessDispatch>(async (messages) => {
    const part = sent(messages);
    parts.push(part);
    return JSON.stringify(reply(part, parts.length));
  });
  mockResolve.mockResolvedValue(dispatch);
  return { dispatch, parts };
}

afterEach(() => { vi.useRealTimers(); mockResolve.mockReset(); });

describe('ADR 1112 P3 — what the model is sent', () => {
  it('keeps words and ids, drops behaviour keys, and leaves other section types whole', () => {
    const p = translationPayload('scheduleSim', sim(3));
    const d = (p.decisions as Raw[])[1]!;
    expect(Object.keys(d).sort()).toEqual(['element', 'id', 'title']);
    expect((p.milestones as Raw[])[0]).toEqual({ id: 'm1', label: 'Milestone 1' });
    expect((p.roles as Raw[])[0]).toEqual({ key: 'client', label: 'client' });
    const faq = { heading: 'Q', items: [{ q: 'a', a: 'b', state: 'x' }] };
    expect(translationPayload('faq', faq)).toBe(faq);
  });
});

describe('ADR 1112 P3 — parts', () => {
  it('sends a section that fits as one part', () => {
    expect(planSectionTranslation('scheduleSim', sim(40))).toHaveLength(1);
  });
  it('splits a larger one in order, each part within the batch size, the first carrying the rest', () => {
    const data = sim(200);
    const parts = planSectionTranslation('scheduleSim', data);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(AI_SECTION_MAX_BATCHES);
    for (const p of parts) expect(JSON.stringify(p).length).toBeLessThanOrEqual(AI_BATCH_CHARS);
    expect(parts[0]).toHaveProperty('milestones');
    expect(parts.slice(1).every((p) => Object.keys(p).join() === 'decisions')).toBe(true);
    const ids = parts.flatMap((p) => (p.decisions as Raw[]).map((x) => x.id));
    expect(ids).toEqual((data.decisions as Raw[]).map((x) => x.id));
  });
  it('refuses a section past the part budget, with the count, before calling a model', async () => {
    const { dispatch } = model();
    const data = sim(1_500);
    expect(() => planSectionTranslation('scheduleSim', data)).toThrow(/too many decisions for AI translation: it would take \d+ requests, and the limit is 8/);
    await expect(translateSectionData('t1', 'scheduleSim', data, 'es')).rejects.toMatchObject({
      code: 'translation_invalid', details: { reason: 'too_large', maxBatches: AI_SECTION_MAX_BATCHES },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('ADR 1112 P3 — translating in parts', () => {
  it('joins the parts into one overlay: every decision translated, behaviour from the base', async () => {
    const data = sim(200);
    const n = planSectionTranslation('scheduleSim', data).length;
    const { dispatch } = model();
    const overlay = await translateSectionData('t1', 'scheduleSim', data, 'es');
    expect(dispatch).toHaveBeenCalledTimes(n);
    const base = data.decisions as Raw[];
    const out = overlay.decisions as Raw[];
    expect(out).toHaveLength(base.length);
    out.forEach((x, i) => {
      expect(x.id).toBe(base[i]!.id);
      expect(String(x.title)).toMatch(/^ES /);
      expect(x).toMatchObject({ milestone: base[i]!.milestone, lockWeek: base[i]!.lockWeek, leadDays: base[i]!.leadDays });
      if (base[i]!.dependsOn) expect(x.dependsOn).toEqual(base[i]!.dependsOn);
    });
    expect(String((overlay.milestones as Raw[])[0]!.label)).toBe('ES Milestone 1');
  });
  it('the joined overlay saves as a translation and reads current (data probe, grade-data P3)', async () => {
    const data = sim(200);
    model();
    const overlay = await translateSectionData('t1', 'scheduleSim', data, 'es');
    const saved = validateSection({ type: 'scheduleSim', data, localizations: { es: overlay } }, 'en', 't1');
    const stored = (saved.localizations?.es ?? {}) as Raw;
    expect((stored.decisions as Raw[]).map((x) => x.id)).toEqual((data.decisions as Raw[]).map((x) => x.id));
    const [stamped] = stampSourceDigests(undefined, [saved as Section]);
    expect(translationStatus(stamped as Section, 'es')).toBe('current');
  });
  it('repairs a part that drops a decision, then refuses it as items_missing', async () => {
    const data = sim(200);
    const n = planSectionTranslation('scheduleSim', data).length;
    const drop = (p: Raw): Raw => ({ ...(es(p) as Raw), decisions: (p.decisions as Raw[]).slice(1) });
    // The second part drops one on its first reply only: the repair lands.
    model((p, call) => (call === 2 ? drop(p) : es(p)));
    await expect(translateSectionData('t1', 'scheduleSim', data, 'es')).resolves.toHaveProperty('decisions');
    const { dispatch } = model((p) => drop(p));
    await expect(translateSectionData('t1', 'scheduleSim', data, 'es')).rejects.toMatchObject({
      code: 'translation_invalid', details: { reason: 'items_missing', repairAttempted: true },
    });
    expect(dispatch.mock.calls.length).toBeLessThan(2 * n); // the failed part stopped the rest
  });
  it('repairs a part that changes a decision id, which would otherwise stay untranslated', async () => {
    const data = sim(200);
    const swap = (p: Raw): Raw => {
      const out = es(p) as Raw;
      const ds = out.decisions as Raw[];
      ds[0] = { ...ds[0]!, id: 'DEC-renamed' };
      return out;
    };
    const { dispatch } = model((p) => swap(p));
    await expect(translateSectionData('t1', 'scheduleSim', data, 'es')).rejects.toMatchObject({
      code: 'translation_invalid', details: { reason: 'items_missing', repairAttempted: true },
    });
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('stops the other parts when one fails', async () => {
    const data = sim(200);
    const signals: AbortSignal[] = [];
    const dispatch = vi.fn<HeadlessDispatch>(async (_messages, opts) => {
      if (opts.signal) signals.push(opts.signal);
      if (signals.length === 1) throw new Error('provider down');
      return new Promise<string>((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    mockResolve.mockResolvedValue(dispatch);
    await expect(translateSectionData('t1', 'scheduleSim', data, 'es')).rejects.toThrow('provider down');
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
  it('bounds all the parts with one deadline, and says so', async () => {
    vi.useFakeTimers();
    const data = sim(200);
    const dispatch = vi.fn<HeadlessDispatch>((_m, opts) => new Promise<string>((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    mockResolve.mockResolvedValue(dispatch);
    const pending = translateSectionData('t1', 'scheduleSim', data, 'es');
    const settled = expect(pending).rejects.toMatchObject({ code: 'translation_invalid', httpStatus: 504, details: { reason: 'timeout' } });
    await vi.advanceTimersByTimeAsync(AI_TRANSLATE_DEADLINE_MS + 1);
    await settled;
  });
});

describe('ADR 1112 P3 — the submit sweep', () => {
  it('charges a section its parts, and leaves one that would overrun the budget whole', async () => {
    const large = { sectionId: 'big', type: 'scheduleSim' as const, data: sim(200) };
    const small = { sectionId: 'small', type: 'scheduleSim' as const, data: sim(10) };
    const n = planSectionTranslation('scheduleSim', large.data).length;
    // One part short for the large section: it is left whole, and the small one still goes.
    const { dispatch } = model();
    const r = await autoTranslateMissingOverlays('t1', [large, small], ['es'], n - 1);
    expect(r.capped).toBe(true);
    expect([...r.overlays.keys()]).toEqual(['small']);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // With the budget for both, both are translated.
    const all = await autoTranslateMissingOverlays('t1', [large, small], ['es'], n + 1);
    expect(all).toMatchObject({ capped: false, errored: false, invalid: 0 });
    expect([...all.overlays.keys()].sort()).toEqual(['big', 'small']);
  });
  it('skips a section too large to translate without a model call', async () => {
    const { dispatch } = model();
    const huge = { sectionId: 'h', type: 'scheduleSim' as const, data: sim(1_500) };
    const r = await autoTranslateMissingOverlays('t1', [huge], ['es', 'fr'], 4);
    expect(r).toMatchObject({ invalid: 2, capped: false, errored: false });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
