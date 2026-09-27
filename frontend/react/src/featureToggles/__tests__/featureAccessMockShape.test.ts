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
 * seven fields deliberately), and pins the factory's own shape so the module
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
import { makeFeatureAccess } from '../__testing__/makeFeatureAccess.js';

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
  /useFeatureAccess\.mock(?:ReturnValue|Implementation)\((?:\([^)]*\) *=> *)?\(?\{([^{}]*)\}/g,
];
const KEY = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g;

function keysOf(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(KEY)) out.add(m[1] as string);
  return out;
}

describe('the useFeatureAccess mock shape', () => {
  it('the factory returns exactly the eight fields the hook returns', () => {
    // If a field is added to `FeatureAccess`, `tsc` reds the factory. This is the
    // other direction: a field silently DROPPED from the factory would leave 50
    // call sites answering `undefined` again, and `tsc` would not care because
    // the return type is what it is declared to be at the boundary.
    expect(Object.keys(makeFeatureAccess()).sort()).toEqual([...FIELDS].sort());
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
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith(join('featureToggles', '__testing__'))) continue;
      if (rel === join('featureToggles', 'FeatureAccessContext.tsx')) continue;
      if (rel === join('featureToggles', '__tests__', 'featureAccessMockShape.test.ts')) continue;
      const src = readFileSync(file, 'utf8');
      if (!src.includes('useFeatureAccess')) continue;
      for (const pat of MOCKS) {
        for (const m of src.matchAll(pat)) {
          const keys = keysOf(m[1] as string);
          if (keys.size === 0) continue; // not an object literal we can read
          const missing = FIELDS.filter((f) => !keys.has(f));
          if (missing.length > 0) offenders.push(`${rel}: missing ${missing.join(', ')}`);
        }
      }
    }
    expect(offenders, 'use featureToggles/__testing__/makeFeatureAccess').toEqual([]);
  });

  it('the scan actually finds mocks (a broken walk would assert nothing)', () => {
    // Without this the assertion above degenerates to "no offenders among zero
    // files inspected" the moment the walk or the regex drifts — passing by
    // describing nothing, which is the exact silence this file exists to end.
    let seen = 0;
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('makeFeatureAccess(')) seen += 1;
    }
    expect(seen, 'no adopter found — the factory or the walk moved').toBeGreaterThanOrEqual(40);
  });
});
