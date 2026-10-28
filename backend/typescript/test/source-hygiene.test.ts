/**
 * Source hygiene (grade pass 2026-07-12, XCH-CODE-1) — no raw control bytes
 * in tracked source.
 *
 * Seven files (agentTools + six older ones) had a literal NUL byte where a
 * '\u0000' ESCAPE was intended (composite-key separators). The runtime value
 * is identical, but a raw NUL makes grep/git-grep treat the whole file as
 * binary — silently blinding every text search over it (this pass found the
 * class only because a grep came back inexplicably empty). This tripwire
 * keeps the class extinct.
 *
 * What breaks it: a raw NUL in any tracked text file under the five trees
 * (sabotage-witnessed by inserting one into smtpEgress.ts, 8fw3g1-hyg-nul).
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_TREES = ['backend/typescript/src', 'backend/typescript/test', 'packs', 'examples', 'frontend/react/src'];
// Text source only — the trees above may vendor the odd image/binary asset.
const TEXT_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|md|css|html|yml|yaml|txt|svg)$/;

describe('source hygiene — control bytes', () => {
  it('no tracked text source file contains a raw NUL byte', () => {
    const files = execFileSync('git', ['ls-files', '--', ...SOURCE_TREES], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && TEXT_EXT.test(f));
    // The scan actually saw the trees: MEASURED 9,913 tracked text files at
    // 0151a8bb2 (/grade-tests wave 61). A floor of 100 let a scan that lost
    // whole trees pass; ~9% headroom absorbs any deletion wave.
    expect(files.length).toBeGreaterThan(9001);
    const offenders = files.filter((f) => {
      try {
        return readFileSync(join(repoRoot, f), 'latin1').includes('\u0000');
      } catch {
        return false; // deleted-but-tracked race; git status owns that problem
      }
    });
    expect(offenders, 'raw NUL bytes make these files invisible to grep — use the \\u0000 escape instead').toEqual([]);
  });
});
