/**
 * AI section translation (ADR 0064 Phase 3, ADR 0592 §7) — the deterministic units:
 * prompt construction, tolerant JSON extraction on the LIVE path
 * (`translateSectionData` → `extractJSONStrict`), and the overlay sanitization that
 * cleans the model's output (so an AI translation can't inject XSS).
 *
 * The garbage-output path (typed 502 `translation_invalid` after one repair) is
 * asserted by `cms-translate-repair.test.ts`; this file used to assert the tolerant
 * `extractJSON` wrapper's `{}` for garbage instead — a wrapper with no production
 * caller, encoding the success-with-empty shape ADR 0592 §7 retired (grade-tests w16).
 *
 * Sabotage (grade-tests w16): dropping the ```json fence strip reds the fenced case
 * (the prose before the fence carries braces, so the brace slice alone cannot parse
 * it); `sanitizeSectionOverlay` returning its input reds the cta case; non-partial
 * mode reds the richText case.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

import { resolveHeadlessAi, type HeadlessDispatch } from '../src/host/headlessAi.js';
import { buildTranslationPrompt, translateSectionData } from '../src/features/cms/translate.js';
import { sanitizeSectionOverlay } from '../src/features/cms/cmsService.js';

const mockResolve = vi.mocked(resolveHeadlessAi);
beforeEach(() => { mockResolve.mockReset(); });

describe('buildTranslationPrompt', () => {
  it('names the target language and embeds the source JSON', () => {
    const p = buildTranslationPrompt({ heading: 'Welcome' }, 'pt-BR');
    expect(p).toMatch(/Portuguese/);
    expect(p).toMatch(/pt-BR/);
    expect(p).toMatch(/"heading": "Welcome"/);
  });
});

describe('translateSectionData — tolerant extraction of the model completion', () => {
  const translate = async (completion: string): Promise<{ overlay: Record<string, unknown>; calls: number }> => {
    const dispatch = vi.fn<HeadlessDispatch>(async () => completion);
    mockResolve.mockResolvedValue(dispatch);
    const overlay = await translateSectionData('t-translate', 'hero', { heading: 'Welcome' }, 'pt-BR');
    return { overlay, calls: dispatch.mock.calls.length };
  };

  it('parses a bare JSON object', async () => {
    expect(await translate('{"heading":"Olá"}')).toEqual({ overlay: { heading: 'Olá' }, calls: 1 });
  });
  it('strips a ```json fence even when the prose around it carries braces', async () => {
    expect(await translate('Note: {placeholders} are kept.\n```json\n{"heading":"Olá"}\n```\nDone {ok}'))
      .toEqual({ overlay: { heading: 'Olá' }, calls: 1 }); // no repair round-trip
  });
  it('finds JSON amid surrounding prose', async () => {
    expect(await translate('Here you go:\n{"heading":"Olá"}\nHope that helps!')).toEqual({ overlay: { heading: 'Olá' }, calls: 1 });
  });
});

describe('sanitizeSectionOverlay — AI output is cleaned like a stored overlay', () => {
  it('drops a dangerous URL scheme from a translated cta overlay', () => {
    const out = sanitizeSectionOverlay('cta', { label: 'Ir', url: 'javascript:alert(1)' });
    expect(out.label).toBe('Ir');
    expect(out.url).toBe(''); // dangerous scheme dropped, same as base sanitization
  });
  it('keeps only present fields (partial overlay) and bounds them', () => {
    // richText's base layer always carries `text`; a partial overlay must not invent it.
    expect(sanitizeSectionOverlay('richText', { heading: 'Bem-vindo' })).toEqual({ heading: 'Bem-vindo' });
    const long = sanitizeSectionOverlay('hero', { heading: 'palavra '.repeat(100) });
    expect((long.heading as string).length).toBeLessThanOrEqual(200); // MAX.heading
    expect((long.heading as string).length).toBeGreaterThan(150);
  });
});
