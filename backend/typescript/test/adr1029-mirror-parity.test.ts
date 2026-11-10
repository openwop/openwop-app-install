/**
 * ADR 1029/1030 grading follow-up — the values the frontend and backend hand-
 * mirror cannot drift apart silently (CODEBASE-ASSESSMENT-adr1029-1030 GRADE-1029-1
 * and GRADE-1030-1).
 *
 *   1. The section `motion` values, the activity row `state` values and the new
 *      column layouts are read from the frontend source and compared with the
 *      backend's closed enums (the backend is the authority; a value the editor
 *      offers that the validator drops would be silently lost on save).
 *   2. The SPA's ADR 1029 motion block and the custom-domain `site.css` carry the
 *      same guards, checked RULE BY RULE (not once per block): every animating
 *      rule sits inside `@supports (animation-timeline: view())` and a `screen`
 *      media query carrying `(prefers-reduced-motion: no-preference)` (the SPA's
 *      selectors also honour the in-app override); every `animation-range` ends at
 *      `entry 100%` (so a fully visible section is never faded); every timeline
 *      rule is longhands with `animation-duration: auto`. Measured 2026-11-06: SPA
 *      7 ranges / 2 timeline rules, site 2 / 2.
 *
 *   3. (ADR 1038/1050) hero emphases, flow states and the editor's flow cap, the
 *      hero visuals in order, and the section types the editor offers a tone on
 *      against the types the validator tones.
 *
 * Sabotage-witnessed (wave 90, 2026-11-06): one extra or missing value in any
 * frontend list (motion, emphasis, flow state, activity state, TONED_TYPES), the
 * hero visuals reordered, FLOW_MAX_STEPS 7, `...tone()` dropped from one builder
 * case, the gallery layout option removed, `screen` or the `@supports` guard
 * dropped, the SECOND rule's range or longhands broken, and a site rule moved
 * outside both guards each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HERO_EMPHASES, SECTION_MOTIONS } from '../src/features/cms/cmsService.js';
import { stripComments } from './helpers/stripComments.js';

const FE = join(import.meta.dirname, '..', '..', '..', 'frontend', 'react', 'src');
const read = (p: string): string => readFileSync(join(FE, p), 'utf8');
const listOf = (src: string, name: string): string[] => {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\] as const`).exec(src);
  expect(m, `${name} not found`).not.toBeNull();
  return [...m![1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!);
};
const BE_CMS = readFileSync(join(import.meta.dirname, '..', 'src', 'features', 'cms', 'cmsService.ts'), 'utf8');

describe('frontend mirrors of the backend enums', () => {
  it('section motion values match', () => {
    expect(listOf(read('features/cms/sectionStyles.tsx'), 'MOTIONS')).toEqual([...SECTION_MOTIONS]);
  });

  it('hero emphasis styles match (ADR 1038 D2)', () => {
    expect(listOf(read('features/cms/sectionStyles.tsx'), 'HERO_EMPHASES')).toEqual([...HERO_EMPHASES]);
  });

  it('flow step states match (ADR 1038 D8)', () => {
    expect(listOf(read('features/cms/sectionStyles.tsx'), 'FLOW_STATES')).toEqual(listOf(BE_CMS, 'FLOW_STATES'));
  });

  it('the editor stops a flow at the validator\'s six steps (ADR 1038 D8)', () => {
    const editor = /const FLOW_MAX_STEPS = (\d+);/.exec(read('features/cms/SectionsEditor.tsx'))?.[1];
    const server = /flowNodes: (\d+),/.exec(BE_CMS)?.[1];
    expect(editor).toBeDefined();
    expect(editor).toBe(server);
  });

  it('hero visuals match, in order (ADR 1050 D4)', () => {
    expect(listOf(read('features/cms/sectionStyles.tsx'), 'HERO_VISUALS')).toEqual(listOf(BE_CMS, 'HERO_VISUALS'));
  });

  it('the editor offers a tone on exactly the types the validator tones (ADR 1050 D5)', () => {
    const m = /const TONED_TYPES = \[([^\]]*)\] as const/.exec(read('features/cms/SectionsEditor.tsx'));
    expect(m, 'TONED_TYPES not found').not.toBeNull();
    const editor = [...m![1]!.matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]!).sort();
    // Each `case 'type': {` body of buildTypedSectionData that spreads `...tone()`.
    // A grouped `case 'a': case 'b':` (ADR 1080's design sections) tones every label.
    const builder = BE_CMS.slice(BE_CMS.indexOf('function buildTypedSectionData'));
    const toned = builder.split(/\n {4}case '/).slice(1)
      .filter((body) => body.includes('...tone()'))
      .flatMap((body) => [...`'${body.split('\n')[0]!}`.matchAll(/case '([A-Za-z]+)'|^'([A-Za-z]+)'/g)].map((x) => (x[1] ?? x[2])!))
      .sort();
    expect(toned.length).toBeGreaterThan(0);
    expect(editor).toEqual(toned);
  });

  it('activity row states match', () => {
    expect(listOf(read('features/cms/sectionStyles.tsx'), 'ACTIVITY_STATES')).toEqual(listOf(BE_CMS, 'ACTIVITY_STATES'));
  });

  it('every column layout the validator accepts is offered by the editor', () => {
    const editor = read('features/cms/SectionsEditor.tsx');
    const offered = [...editor.matchAll(/<option value="([a-z]+)">\{t\('layout[A-Z]/g)].map((m) => m[1]!);
    expect(offered.sort()).toEqual(listOf(BE_CMS, 'COLUMN_LAYOUTS').sort());
  });
});

/** One CSS rule with the at-rule preludes it sits inside, outermost first. */
interface Rule { selector: string; body: string; ancestors: string[] }
/** Every style rule in `src` (comments stripped by the shared scanner, never a hand-rolled regex: `strip-comments.test.ts`), recursing into at-rules. */
const rulesOf = (src: string, ancestors: string[] = []): Rule[] => {
  const code = stripComments(src);
  const out: Rule[] = [];
  let depth = 0, start = 0, open = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') { if (depth === 0) open = i; depth++; }
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) {
        const prelude = code.slice(start, open).trim();
        const body = code.slice(open + 1, i);
        if (prelude.startsWith('@keyframes')) { /* frames, not rules */ }
        else if (prelude.startsWith('@')) out.push(...rulesOf(body, [...ancestors, prelude]));
        else out.push({ selector: prelude, body, ancestors });
        start = i + 1;
      }
    }
  }
  return out;
};
/** A rule that starts motion (sets an animation other than `none`). */
const animates = (r: Rule): boolean => /animation-(name|timeline)\s*:/.test(r.body) || /(^|[;{\s])animation\s*:(?!\s*none\s*;)/.test(r.body);
/** The ADR 1038 reduced-motion guard, in either spelling (wave 90 ruling). */
const isMotionGuard = (p: string): boolean => /^@media\b[^{]*\(prefers-reduced-motion:\s*no-preference\)/.test(p);
const SUPPORTS = '@supports (animation-timeline: view())';

describe('the SPA and the custom-domain stylesheet guard motion the same way', () => {
  const blockOf = (css: string, from: string, to?: string): string => {
    const a = css.indexOf(from);
    expect(a, from).toBeGreaterThanOrEqual(0);
    if (!to) return css.slice(a);
    const b = css.indexOf(to, a);
    expect(b, to).toBeGreaterThan(a);
    return css.slice(a, b);
  };
  const spa = blockOf(read('styles/global.css'), '/* ── ADR 1029 — section scroll motion', '/* Landing flash');
  const site = blockOf(read('site-runtime/site.css'), '/* ADR 1029 motion, keyed on the hook');
  const blocks = [['spa', spa], ['site', site]] as const;
  /** Per-rule checks, one per label (the label set is the counted rule list: never change it). */
  const perRule: Record<string, (name: string, rules: Rule[]) => void> = {
    // Every rule that animates sits inside the scroll-timeline @supports.
    'scroll timelines only': (name, rules) => {
      const moving = rules.filter(animates);
      expect(moving.length, `${name}: animating rules`).toBeGreaterThan(0);
      for (const r of moving) expect(r.ancestors, `${name}: ${r.selector}`).toContain(SUPPORTS);
    },
    // ...and inside a `screen` media query carrying the no-preference guard; the
    // SPA's selectors also honour the in-app override.
    'screen and no-preference only': (name, rules) => {
      for (const r of rules.filter(animates)) {
        const guard = r.ancestors.find(isMotionGuard);
        expect(guard, `${name}: ${r.selector}`).toBeDefined();
        expect(guard, `${name}: ${r.selector}`).toMatch(/^@media screen and /);
        if (name === 'spa') {
          for (const s of r.selector.split(/,(?![^(]*\))/)) expect(s.trim(), s).toMatch(/^:root:not\(\[data-reduce-motion="reduce"\]\) /);
        }
      }
    },
    // Every range ends at `entry 100%`, so a fully visible section is never faded.
    'a range that ends at entry 100%': (name, rules) => {
      const ranges = rules.flatMap((r) => [...r.body.matchAll(/animation-range\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim()));
      expect(ranges.length, `${name}: ranges`).toBeGreaterThan(0);
      for (const v of ranges) expect(v, name).toMatch(/ entry 100%$/);
    },
    // A rule on the scroll timeline is written in longhands with `duration: auto`.
    'longhands, so one rejected value drops only itself': (name, rules) => {
      const timed = rules.filter((r) => /animation-timeline\s*:/.test(r.body));
      expect(timed.length, `${name}: timeline rules`).toBeGreaterThan(0);
      for (const r of timed) {
        expect(r.body, `${name}: ${r.selector}`).toContain('animation-duration: auto');
        expect(r.body, `${name}: ${r.selector}`).not.toMatch(/(^|[;{\s])animation\s*:/);
      }
    },
  };

  it.each([
    ['scroll timelines only', '@supports (animation-timeline: view())'],
    ['screen and no-preference only', '@media screen and (prefers-reduced-motion: no-preference)'],
    ['a range that ends at entry 100%', 'animation-range: entry 0% entry 100%'],
    ['longhands, so one rejected value drops only itself', 'animation-duration: auto'],
  ])('%s', (label, guard) => {
    expect(spa).toContain(guard);
    expect(site).toContain(guard);
    for (const [name, css] of blocks) perRule[label]!(name, rulesOf(css));
  });
});
