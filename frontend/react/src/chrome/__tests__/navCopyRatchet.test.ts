/**
 * ADR 0874 P3 — a nav entry's words have ONE source.
 *
 * An entry carries a `nav` catalog key, or (an adopter's feature with no catalog)
 * an English literal — never both, never neither. A literal beside a key shipped
 * a second copy of the English in the entry chunk: 198 of them cost 2.66 kB gzip
 * (129.0 → 126.4 kB, measured on 7b9bb8138). Every surface reads the words through
 * `chrome/navText.ts`, so a dropped literal cannot render `undefined` on a surface
 * that kept its own `t(labelKey, { defaultValue: label })`.
 *
 * Sabotage, each red: put a literal back beside a key; drop a key from the en
 * catalog; drop a host entry's key; hand-write `item.labelKey ? tn(item.labelKey, …)`
 * in a chrome file, on one line or across several.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES } from '../features.js';
import i18n from '../../i18n/index.js';
import { ADOPTER_FRONTEND_FEATURES } from '../../features/adopterFeatures.js';
import { navHint, navLabel } from '../navText.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The composed `nav` namespace (host catalog plus every feature's `navMessages`), in English. */
const english = (key: string): string => {
  const v: unknown = i18n.getResource('en', 'nav', key);
  return typeof v === 'string' ? v : '';
};

const words = FEATURES.flatMap((f) => (f.nav ? [{ path: f.path, nav: f.nav }] : []));
// An adopter's entries (ADR 1031, `src/adopter/features/`) are held only to "a key or a
// literal": one that carries both still renders (the key wins), so an upgrade does not
// red an adopter's suite over bytes in ITS entry share. The host's own entries are held
// to the full rule. Vacuous in openwop-app, which ships no adopter features.
const adopterPaths = new Set(ADOPTER_FRONTEND_FEATURES.flatMap((f) => (f.routes ?? []).map((r) => r.path)));
const host = words.filter(({ path }) => !adopterPaths.has(path));

/** Hand-written `item.labelKey ? tn(item.labelKey…` or `tn(item.labelKey, { defaultValue: item.label })`
 *  reads, matched over the whole text so a read split across lines is caught (NAV-2). */
const HAND = /\.(label|hint)Key\s*\??\s*\??\s*\(?\s*t[n]?\([\w.]+\.(label|hint)Key|t[n]?\([\w.]+\.(label|hint)Key,\s*\{\s*defaultValue:\s*[\w.]+\.(label|hint)\s*,?\s*\}/g;
function handReads(path: string, text: string): string[] {
  return [...text.matchAll(HAND)].flatMap((m) => {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    return /nav|item|parent|hit|it\b/.test(text.slice(lineStart, m.index) + m[0]) ? [`${path}:${text.slice(0, m.index).split('\n').length}`] : [];
  });
}

describe('navCopyRatchet', () => {
  it('every nav entry has a key or a literal for its label and its hint', () => {
    const bad = words.flatMap(({ path, nav }) => [
      ...(!nav.labelKey && !nav.label ? [`${path}: no label`] : []),
      ...(!nav.hintKey && nav.hint === undefined ? [`${path}: no hint`] : []),
    ]);
    expect(bad).toEqual([]);
  });

  it('no host nav entry carries a literal beside its key', () => {
    const bad = host.flatMap(({ path, nav }) => [
      ...(nav.labelKey && nav.label !== undefined ? [`${path}: label literal beside labelKey`] : []),
      ...(nav.hintKey && nav.hint !== undefined ? [`${path}: hint literal beside hintKey`] : []),
    ]);
    expect(bad).toEqual([]);
  });

  // A host entry with no key shows English in every language. Before P3 nine
  // entries carried dead keys (feature-namespace keys the nav namespace never had);
  // P3 left them literal-only and the NAV-1 follow-up keyed them in `nav`.
  it('every host nav entry carries a label key and a hint key', () => {
    const bad = host.flatMap(({ path, nav }) => [
      ...(!nav.labelKey ? [`${path}: no labelKey`] : []),
      ...(nav.hint !== undefined && !nav.hintKey ? [`${path}: no hintKey`] : []),
    ]);
    expect(bad).toEqual([]);
  });

  // A key that resolves nowhere renders the raw key.
  it('every host key resolves to non-empty English in the composed nav namespace', () => {
    const missing = host.flatMap(({ path, nav }) =>
      [nav.labelKey, nav.hintKey].filter((k): k is string => !!k && !english(k).trim()).map((k) => `${path}: ${k}`));
    expect(missing).toEqual([]);
  });

  it('navLabel/navHint read the catalog for a key and the literal otherwise', () => {
    const keyed = words.find(({ nav }) => nav.labelKey && nav.hintKey);
    expect(keyed).toBeDefined();
    expect(navLabel(keyed!.nav)).toBe(english(keyed!.nav.labelKey!));
    expect(navHint(keyed!.nav)).toBe(english(keyed!.nav.hintKey!));
    expect(navLabel({ label: 'Adopter page' })).toBe('Adopter page');
    expect(navHint({})).toBe('');
  });

  it('no surface resolves a nav key by hand outside chrome/navText.ts', () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== '__tests__') walk(p); }
        else if (/\.tsx?$/.test(n)) files.push(p);
      }
    };
    walk(SRC);
    const sites = files.filter((p) => !p.endsWith(join('chrome', 'navText.ts'))).flatMap((p) => handReads(relative(SRC, p), readFileSync(p, 'utf8')));
    expect(sites).toEqual([]);
  });

  it('catches a planted hand-written read, on one line or across lines', () => {
    expect([
      ...handReads('a.tsx', 'const s = item.labelKey ? tn(item.labelKey) : item.label;'),
      ...handReads('b.tsx', 'const s = nav.labelKey\n  ? tn(nav.labelKey)\n  : nav.label;'),
      ...handReads('c.tsx', 'x\nconst s = tn(item.hintKey, {\n  defaultValue: item.hint,\n});'),
      ...handReads('d.tsx', 'const s = navLabel(item, tn);'),
    ]).toEqual(['a.tsx:1', 'b.tsx:1', 'c.tsx:2']);
  });
});
