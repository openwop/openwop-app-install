import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every `firebase.json` predeploy hook MUST be CommonJS (`.cjs`).
 *
 * The Firebase CLI ships as a pkg-bundled Node that `require()`s the command it
 * is handed, so an `.mjs` hook dies with `ERR_REQUIRE_ESM` before a single
 * assertion in it runs.
 *
 * MEASURED 2026-09-08: `check-hosting-wire-rewrites.mjs` failed the frontend half
 * of a real deploy this way, while `prepare-hosting-shell.cjs` — the sibling hook
 * two lines below it in the same array — had run fine for months. The working
 * shape was already in the file next to the broken one.
 *
 * WHY A TEST AND NOT A COMMENT: the failure is invisible everywhere except a live
 * `firebase deploy`. `node scripts/check-hosting-wire-rewrites.mjs` runs fine
 * locally, `npm run build` runs it fine, and CI runs it fine — Node's own loader
 * handles `.mjs` correctly. Only the CLI's bundled runtime does not, so the
 * cheapest place to learn about a rename is here, not in the deploy that
 * discovers it.
 */
const ROOT = resolve(__dirname, '../../../..');

describe('firebase.json predeploy hooks', () => {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'firebase.json'), 'utf8')) as {
    hosting?: { predeploy?: string[] } | Array<{ predeploy?: string[] }>;
  };
  const blocks = Array.isArray(cfg.hosting) ? cfg.hosting : [cfg.hosting ?? {}];
  const hooks = blocks.flatMap((b) => b?.predeploy ?? []);

  it('has hooks to check — an empty list would make the rule below vacuous', () => {
    expect(hooks.length, 'no predeploy hooks found; this test would assert nothing').toBeGreaterThan(0);
  });

  it('every node-invoked hook is .cjs, never .mjs', () => {
    const esm = hooks.filter((h) => /\bnode\b/.test(h) && /\.mjs(\s|$)/.test(h));
    expect(
      esm,
      `these predeploy hooks are ES modules: ${esm.join(', ')}. The Firebase CLI require()s them and dies with `
        + 'ERR_REQUIRE_ESM before running any check — it fails ONLY at deploy time, never locally or in CI. '
        + 'Rename to .cjs and convert the imports (see check-hosting-wire-rewrites.cjs).',
    ).toEqual([]);
  });

  it('every hook script actually exists at the path firebase.json names', () => {
    // The rename that fixes the extension is exactly the change that can leave a
    // dangling path, and a missing hook also fails only at deploy time.
    for (const h of hooks) {
      const m = /node\s+(\S+)/.exec(h);
      if (!m) continue;
      expect(() => readFileSync(resolve(ROOT, m[1]!), 'utf8'), `predeploy hook not found: ${m[1]}`).not.toThrow();
    }
  });
});
