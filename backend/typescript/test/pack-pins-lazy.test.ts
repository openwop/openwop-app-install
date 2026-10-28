/**
 * ADR 0919 — pack pins are resolved lazily from ONE table, never at boot.
 *
 * What would silently undo it, and the case that catches each:
 *  - a descriptor carrying a version again (`{ name, version }` in requiredPacks)
 *    → "descriptors declare names only";
 *  - the registry resolving the pins eagerly → "the registry thunk is not called
 *    until a reader asks". This file proves the REGISTRY is lazy (its own thunk).
 *    The registration SITE (`features/index.ts` passing a thunk, not a resolved
 *    list) is witnessed by `pack-pins-boot.test.ts` › "a createApp() boot resolves
 *    zero pins…" (wave 64 probe 8fw5g2-pp-index-eager-cover; the same sabotage
 *    stays green here, 8fw5g2-pp-index-eager), so it is not re-booted here;
 *  - `PACK_PINS` stops being a pure literal (a spread, a call, a computed key),
 *    which makes it a module-load statement to Tracegate and re-runs every boot
 *    on a pin bump again → "PACK_PINS stays a pure object literal of strings";
 *  - a required name with no pin → `pack_pin_missing`, failing closed.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { PACK_PINS, featureRequiredPacks, pinnedPackRef } from '../src/features/packPins.js';
import { registerFeaturePacks, getFeaturePacks, __resetFeaturePacks } from '../src/host/featureToggles/registry.js';

const PINS_FILE = join(dirname(fileURLToPath(import.meta.url)), '../src/features/packPins.ts');

describe('ADR 0919 — pack pins resolved lazily', () => {
  it('descriptors declare names only (no version in any requiredPacks entry)', () => {
    const withPacks = BACKEND_FEATURES.filter((f) => (f.requiredPacks ?? []).length > 0);
    // Floor = the measured count, wave 64 (2026-10-24, 19d13e682): 78 feature.ts
    // files declare a non-empty `requiredPacks: [...]` (round 1 counted 79 by grep,
    // but the 79th match is a doc comment in packPins.ts). A floor far below the
    // truth (it was 20) lets a feature silently drop its packs.
    expect(withPacks.length).toBeGreaterThanOrEqual(78);
    const notNames = withPacks.flatMap((f) => (f.requiredPacks ?? []).filter((r) => typeof r !== 'string').map(() => f.id));
    expect(notNames).toEqual([]);
  });

  it('every required name resolves to its pin; an unknown name fails closed', () => {
    for (const f of BACKEND_FEATURES) {
      for (const ref of featureRequiredPacks(f)) expect(ref.version).toBe((PACK_PINS as Record<string, string>)[ref.name]);
    }
    expect(() => pinnedPackRef('feature.never-pinned.nodes')).toThrow(/pack_pin_missing: feature\.never-pinned\.nodes/);
  });

  it('the registry thunk is not called until a reader asks, and is re-read each time', () => {
    __resetFeaturePacks();
    try {
      const thunk = vi.fn(() => [{ name: 'feature.x.nodes', version: '1.0.0' }]);
      registerFeaturePacks('x', thunk);
      expect(thunk).not.toHaveBeenCalled();
      expect(getFeaturePacks('x')).toEqual([{ name: 'feature.x.nodes', version: '1.0.0' }]);
      expect(getFeaturePacks('x')).toEqual([{ name: 'feature.x.nodes', version: '1.0.0' }]);
      expect(thunk).toHaveBeenCalledTimes(2);
      // Plain refs still work (the kicktodo readiness test registers them directly).
      registerFeaturePacks('y', [{ name: 'feature.y.nodes', version: '2.0.0' }]);
      expect(getFeaturePacks('y')).toEqual([{ name: 'feature.y.nodes', version: '2.0.0' }]);
    } finally {
      __resetFeaturePacks();
    }
  });

  it('PACK_PINS stays a pure object literal of string literals (a Tracegate constant)', () => {
    const sf = ts.createSourceFile(PINS_FILE, readFileSync(PINS_FILE, 'utf8'), ts.ScriptTarget.Latest, true);
    const decl = sf.statements
      .filter(ts.isVariableStatement)
      .flatMap((s) => [...s.declarationList.declarations])
      .find((d) => ts.isIdentifier(d.name) && d.name.text === 'PACK_PINS');
    expect(decl?.initializer, 'PACK_PINS must be declared with an initializer').toBeTruthy();
    let init = decl!.initializer!;
    while (ts.isSatisfiesExpression(init) || ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
    expect(ts.isObjectLiteralExpression(init), 'PACK_PINS must be an object literal (no call, no Object.freeze)').toBe(true);
    const bad = (init as ts.ObjectLiteralExpression).properties
      .filter((p) => !(ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name) && ts.isStringLiteral(p.initializer)))
      .map((p) => p.getText(sf));
    expect(bad, 'every entry must be `\'<pack>\': \'<version>\'` — no spread, computed key or expression').toEqual([]);
    expect((init as ts.ObjectLiteralExpression).properties.length).toBe(Object.keys(PACK_PINS).length);
  });
});
