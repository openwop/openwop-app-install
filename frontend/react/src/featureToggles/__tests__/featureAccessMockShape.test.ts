/**
 * RATCHET — no test hand-rolls a PARTIAL `useFeatureAccess` return value.
 *
 * The hook answers with eight fields. Across the suite its mock was written by
 * hand ~50 times and returned one, two, four, or five of them — four of those
 * under a comment reading "Mirror the real shape", which is why a lint rule
 * about spelling was never going to be enough. The omission is not visible at
 * the call site: a field that is never mentioned reads as `undefined`, reads as
 * falsy, and answers the question anyway.
 *
 * That has cost twice already.
 *
 *  - `useFeatureAccess` returns an OBJECT while nine pages did
 *    `const enabled = useFeatureAccess(id)` then `if (!enabled)`. Every mock
 *    that returned `true` (or `{ enabled: true }`) agreed with the misread, so
 *    the dead branch shipped.
 *  - `scheduled-chats` had no `access.loading` branch, so during toggle
 *    resolution it rendered a terminal "not available" card. Its mock omitted
 *    `loading` — and `undefined` is exactly the value that missing branch would
 *    have skipped — so nothing could have gone red.
 *
 * The fix is `featureToggles/__testing__/makeFeatureAccess`, typed as the hook's
 * own return type. This file pins that the corpus uses it (or spells out all
 * eight fields deliberately), and pins the factory's own shape so the module
 * cannot quietly start answering with six.
 *
 * SCOPE is inline mock LITERALS. A mock that returns a variable
 * (`useFeatureAccess: () => access.value`) is not readable statically, and
 * guessing at one is how a check ends up answering a different question than the
 * one it advertises — so those are named as out of scope rather than
 * half-covered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderHook } from '@testing-library/react';
import { makeFeatureAccess } from '../__testing__/makeFeatureAccess.js';
import { useFeatureAccess } from '../FeatureAccessContext.js';

const SRC = join(process.cwd(), 'src');

/** The eight fields `useFeatureAccess` really returns. (`resolutionFailed`
 *  added 2026-08-20 — TWIN-UX-1's failed-read leg.) */
const FIELDS = ['status', 'enabled', 'isBeta', 'variant', 'entitled', 'locked', 'loading', 'resolutionFailed'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * The two forms a mock's SHAPE is actually written in. Deliberately narrow, and
 * narrowed once already: a looser `useFeatureAccess[^\n]*?=>` matched the
 * DESTRUCTURING line `const { listOrgs, useFeatureAccess } = vi.hoisted(() => ({`
 * and then ran on past the newline to the first `}`, reporting three files as
 * "missing all seven fields" when what it had read was a module-mock object.
 * A check that reports a finding about something it misparsed is worse than one
 * that reports nothing.
 *
 *   A — a property mock:      `useFeatureAccess: (…) => ({ … })`
 *   B — an imperative mock:   `useFeatureAccess.mockReturnValue({ … })`
 *                             `useFeatureAccess.mockImplementation((id) => ({ … }))`
 *
 * Both stop at the first brace pair, so a nested literal is out of scope rather
 * than half-read. Anything routed through a variable
 * (`useFeatureAccess: () => access.value`) is invisible here BY DESIGN — see the
 * scope note in this file's header.
 */
const MOCKS = [
  /useFeatureAccess: *(?:vi\.fn\()?(?:\([^)]*\))? *=> *\(\{([^{}]*)\}/g,
  // `.mockReturnValue` / `.mockImplementation`, their `…Once` forms, on the
  // bare mock or through `vi.mocked(useFeatureAccess)`. (Wave 50: the `Once`
  // and `vi.mocked` forms used to escape this pattern.)
  /(?:useFeatureAccess|vi\.mocked\(useFeatureAccess\))\.mock(?:ReturnValue|Implementation)(?:Once)?\((?:\([^)]*\) *=> *)?\(?\{([^{}]*)\}/g,
];
const KEY = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g;

function keysOf(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(KEY)) out.add(m[1] as string);
  return out;
}

/** Every readable mock literal in `src`: the fields each one is missing. */
function literalsIn(src: string): string[][] {
  const out: string[][] = [];
  for (const pat of MOCKS) {
    for (const m of src.matchAll(pat)) {
      const keys = keysOf(m[1] as string);
      if (keys.size === 0) continue; // not an object literal we can read
      out.push(FIELDS.filter((f) => !keys.has(f)));
    }
  }
  return out;
}

const SELF = join('featureToggles', '__tests__', 'featureAccessMockShape.test.ts');

describe('the useFeatureAccess mock shape', () => {
  it('the factory returns exactly the eight fields the hook returns', () => {
    // If a field is added to `FeatureAccess`, `tsc` reds the factory. This is the
    // other direction: a field silently DROPPED from the factory would leave 50
    // call sites answering `undefined` again, and `tsc` would not care because
    // the return type is what it is declared to be at the boundary.
    expect(Object.keys(makeFeatureAccess()).sort()).toEqual([...FIELDS].sort());
    // …and the other side is READ, not copied: the real hook's own answer (no
    // provider ⇒ the default context, no fetch) has exactly the factory's keys.
    const { result } = renderHook(() => useFeatureAccess('any-feature'));
    expect(Object.keys(result.current).sort()).toEqual(Object.keys(makeFeatureAccess()).sort());
  });

  it('derives an internally consistent shape rather than a contradictory one', () => {
    // A mock that says `enabled: false, status: 'on'` describes a state the
    // resolver cannot produce, and a fixture nobody can reason from is worse
    // than none. These derivations are copied from the hook.
    expect(makeFeatureAccess({ enabled: false }).status).toBe('off');
    expect(makeFeatureAccess({ status: 'beta' }).isBeta).toBe(true);
    expect(makeFeatureAccess({ entitled: false }).locked).toBe(true);
    // …and an explicit value still wins, so a test may ask for an odd shape on
    // purpose, visibly.
    expect(makeFeatureAccess({ enabled: false, status: 'on' }).status).toBe('on');
    // The default is a RESOLVED answer: a test that cares about the unresolved
    // state has to say so instead of inheriting it from a forgotten field.
    expect(makeFeatureAccess().loading).toBe(false);
  });

  it('no test hand-rolls a partial return value', () => {
    // Planted violations, one per form the scan must read — so a pattern that
    // stops matching a form reds HERE, not silently in the corpus below.
    const planted = [
      "useFeatureAccess: () => ({ enabled: true }),",
      "useFeatureAccess: vi.fn(() => ({ enabled: true })),",
      "useFeatureAccess.mockReturnValue({ enabled: true });",
      "useFeatureAccess.mockReturnValueOnce({ enabled: true });",
      "useFeatureAccess.mockImplementation((id) => ({ enabled: id === 'crm' }));",
      "useFeatureAccess.mockImplementationOnce(() => ({ enabled: true }));",
      "vi.mocked(useFeatureAccess).mockReturnValue({ enabled: true });",
      "vi.mocked(useFeatureAccess).mockReturnValueOnce({ enabled: true });",
    ];
    for (const src of planted) {
      const found = literalsIn(src);
      expect(found, src).toHaveLength(1);
      expect(found[0], src).toContain('loading');
    }

    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith(join('featureToggles', '__testing__'))) continue;
      if (rel === join('featureToggles', 'FeatureAccessContext.tsx')) continue;
      if (rel === SELF) continue;
      const src = readFileSync(file, 'utf8');
      if (!src.includes('useFeatureAccess')) continue;
      for (const missing of literalsIn(src)) {
        if (missing.length > 0) offenders.push(`${rel}: missing ${missing.join(', ')}`);
      }
    }
    expect(offenders, 'use featureToggles/__testing__/makeFeatureAccess').toEqual([]);
  });

  it('the scan actually READS mocks (a broken walk or pattern would assert nothing)', () => {
    // Without this the assertion above degenerates to "no offenders among zero
    // literals inspected" the moment the walk or a pattern drifts — passing by
    // describing nothing, which is the exact silence this file exists to end.
    // Floors are MEASURED (wave 50, e3c2492be): 128 files call the factory, and
    // the patterns read 20 full eight-field literals outside this file. A drop
    // below either means the walk or a pattern broke — or a mass migration, in
    // which case lower the floor in the same PR and say why.
    // Wave 52 (420fe1891): 20 → 14 literals. Six wave files replaced their
    // hand-written literal with makeFeatureAccess (dealers failedReads and
    // writePathHonesty, podcasts and webinars orgsFailedNotEmpty, webinars
    // formBinding, sales-commissions statements). The drop was counted per file
    // with an independent re-implementation of MOCKS, and no pattern broke.
    let adopters = 0;
    let literals = 0;
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      const src = readFileSync(file, 'utf8');
      if (src.includes('makeFeatureAccess(')) adopters += 1;
      if (rel === SELF) continue;
      literals += literalsIn(src).length;
    }
    expect(adopters, 'no adopter found — the factory or the walk moved').toBeGreaterThanOrEqual(127);
    expect(literals, 'the mock patterns read nothing — a pattern broke').toBeGreaterThanOrEqual(14);
  });
});
