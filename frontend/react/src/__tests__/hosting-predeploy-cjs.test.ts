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
 *
 * `.js` is refused too: `frontend/react/package.json` is `"type": "module"`, so a
 * `.js` hook there is an ES module and dies the same way (/grade-tests w50 probe
 * `hp-js-dodge` was green before). And the hook list itself is pinned: dropping
 * `prepare-hosting-shell.cjs` (ADR 0384 P4 — it renames dist/index.html so `/`
 * falls through to the backend's document rewrite) breaks `/` on the next deploy
 * while every other check stays green (`hp-shell-dropped`).
 */
const ROOT = resolve(__dirname, '../../../..');

describe('firebase.json predeploy hooks', () => {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'firebase.json'), 'utf8')) as {
    hosting?: { predeploy?: string[] } | Array<{ predeploy?: string[] }>;
  };
  const blocks = Array.isArray(cfg.hosting) ? cfg.hosting : [cfg.hosting ?? {}];
  const hooks = blocks.flatMap((b) => b?.predeploy ?? []);

  it('has hooks to check — an empty list would make the rule below vacuous', () => {
    // Both hooks, by name and in order: the wire-rewrite check, then the shell
    // rename that `/` depends on. A missing one fails only at deploy time.
    expect(hooks, 'firebase.json predeploy must run both hosting hooks').toEqual([
      'node frontend/react/scripts/check-hosting-wire-rewrites.cjs',
      'node frontend/react/scripts/prepare-hosting-shell.cjs',
    ]);
  });

  it('every node-invoked hook is .cjs, never .mjs', () => {
    // Positive form: anything that is not `.cjs` (`.mjs`, or `.js` under a
    // `"type": "module"` package) is loaded as ESM by the CLI's require().
    const esm = hooks.filter((h) => /\bnode\b/.test(h) && !/^node\s+\S+\.cjs(\s|$)/.test(h.trim()));
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
