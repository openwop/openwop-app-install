/**
 * AI section translation (ADR 0064 Phase 3) — the deterministic units:
 * prompt construction, tolerant JSON extraction, and the overlay sanitization
 * that cleans the model's output (so an AI translation can't inject XSS).
 */
import { describe, it, expect } from 'vitest';
import { buildTranslationPrompt, extractJSON } from '../src/features/cms/translate.js';
import { sanitizeSectionOverlay } from '../src/features/cms/cmsService.js';

describe('buildTranslationPrompt', () => {
  it('names the target language and embeds the source JSON', () => {
    const p = buildTranslationPrompt({ heading: 'Welcome' }, 'pt-BR');
    expect(p).toMatch(/Portuguese/);
    expect(p).toMatch(/pt-BR/);
    expect(p).toMatch(/"heading": "Welcome"/);
  });
});

describe('extractJSON', () => {
  it('parses a bare JSON object', () => {
    expect(extractJSON('{"heading":"Olá"}')).toEqual({ heading: 'Olá' });
  });
  it('strips a ```json fence', () => {
    expect(extractJSON('```json\n{"heading":"Olá"}\n```')).toEqual({ heading: 'Olá' });
  });
  it('finds JSON amid surrounding prose', () => {
    expect(extractJSON('Here you go:\n{"heading":"Olá"}\nHope that helps!')).toEqual({ heading: 'Olá' });
  });
  it('returns {} for garbage or a non-object', () => {
    expect(extractJSON('not json at all')).toEqual({});
    expect(extractJSON('[1,2,3]')).toEqual({});
    expect(extractJSON('')).toEqual({});
  });
});

describe('sanitizeSectionOverlay — AI output is cleaned like a stored overlay', () => {
  it('drops a dangerous URL scheme from a translated cta overlay', () => {
    const out = sanitizeSectionOverlay('cta', { label: 'Ir', url: 'javascript:alert(1)' });
    expect(out.label).toBe('Ir');
    expect(out.url).toBe(''); // dangerous scheme dropped, same as base sanitization
  });
  it('keeps only present fields (partial overlay) and bounds them', () => {
    const out = sanitizeSectionOverlay('hero', { heading: 'Bem-vindo' });
    expect(out).toEqual({ heading: 'Bem-vindo' });
  });
});
