#!/usr/bin/env node
/**
 * check-build-chain-split (issue #3627) — no steward-only gate is reachable from
 * plain `build`.
 *
 * `build` is what an ADOPTER of the white-label bundle runs. `build:steward` is
 * that plus the governance gates that assert on `docs/steward/`, the showcase's
 * own `.env.production`, or a git working copy — none of which exist in a
 * shipped bundle.
 *
 * The split alone does not hold. Four gates leaked into the adopter chain
 * (#3610) and every one was written by someone who KNEW the bundle strips
 * `docs/steward/` — `check-network-recorder-posture`'s own header says that file
 * "is STRIPPED from every adopter bundle" and then asserted on it anyway. The
 * knowledge was present; the chain gave it nowhere to go. So a split that is
 * only a convention regrows the same defect the next time a governance gate is
 * written, and it regrows SILENTLY: it fails in an adopter's terminal months
 * later, not in steward CI.
 *
 * This asserts the negative. A script reachable from `build` MUST NOT depend on
 * a steward-only path.
 *
 * ## What counts as a dependency, and why a grep is not enough
 *
 * Mentioning `docs/steward/` is not depending on it. `check-bundle-budget.mjs`
 * cites `docs/steward/CODEBASE-ASSESSMENT.md` in a comment as the rationale for
 * a number, and `write-build-info.mjs` shells out to git but falls back when
 * there is no working copy. Both belong in `build`. Flagging them would make
 * this gate cry wolf, and a gate that cries wolf gets bypassed.
 *
 * So a match is a dependency only when it appears outside a COMMENT. String
 * literals are deliberately KEPT: a path dependency lives in a string by
 * necessity (`join(root, 'docs/steward', …)`), so stripping strings blinds the
 * detector to exactly the case it exists for. That was this gate's own first
 * defect — it passed while `check-hv-citations.mjs` sat back in `build`,
 * because #3610's rewrite left that path in comments and strings only. A gate
 * that cannot fail on the thing it guards is worse than no gate.
 *
 * Whole-line comments and docblock lines are dropped; inline `//` is left alone
 * so a URL inside a string is not truncated. Imperfect in the safe direction: a
 * path built by concatenation slips through, which under-reports rather than
 * blocking a legitimate gate.
 *
 * Exit 0 when plain `build` is adopter-clean; 1 naming the script and the path.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', 'package.json');

/** Paths that do not exist in a stripped adopter bundle. */
const STEWARD_ONLY = [
  // Both the literal path AND the segment-wise form. `check-hv-citations.mjs`
  // builds it as `join(…, 'docs', 'steward')`, which a path-shaped regex alone
  // does not see — and that was the ONE case this gate most had to catch, so the
  // blind spot this docblock admitted to was live on the example that motivated
  // the whole issue.
  { re: /docs\/steward\b|['"]docs['"]\s*,\s*['"]steward['"]/, name: 'docs/steward (stripped by build-whitelabel-zip.sh)' },
  { re: /\.env\.production/, name: ".env.production (the steward's own, never shipped)" },
  // `git ls-files` ONLY, not any git call. `write-build-info.mjs` shells out to
  // git and falls back to `'unknown'` in a catch — it USES git, it does not
  // depend on it, and flagging it would make this gate cry wolf on a script that
  // is adopter-correct. `git ls-files` is the issue's actual case and the one
  // that returns a WRONG ANSWER rather than an error when there is no working
  // copy: an empty file list silently passes a gate that should have run.
  { re: /\bgit\s+ls-files\b|'ls-files'/, name: 'git ls-files (adopters unpack a zip, not a working copy)' },
];

/**
 * Drop comments, KEEP string literals — a path dependency lives in a string.
 * Only whole-line comments and docblock lines go, so an inline `//` inside a
 * URL string survives intact.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

const scripts = JSON.parse(readFileSync(PKG, 'utf8')).scripts ?? {};
const build = scripts.build;
if (!build) {
  process.stdout.write('  FAIL — package.json has no `build` script to check.\n');
  process.exit(1);
}
if (!scripts['build:steward']) {
  process.stdout.write(
    '  FAIL — `build:steward` is missing. The split is the mechanism this gate protects;\n' +
      '  without it every governance gate is back in the adopter chain by default (#3627).\n',
  );
  process.exit(1);
}

process.stdout.write('=== check-build-chain-split — is plain `build` adopter-clean? ===\n');

const reachable = [...build.matchAll(/scripts\/([A-Za-z0-9._-]+\.(?:mjs|cjs|js))/g)].map((m) => m[1]);
const problems = [];
let scanned = 0;

const SELF = basename(fileURLToPath(import.meta.url));
for (const name of reachable) {
  // The gate scans itself when it sits in `build` — and its own source holds
  // the very regex literals it looks for, so it flagged itself on the first
  // run after #3732 landed and `npm run build` was red on main. The checker is
  // not an adopter dependency; every OTHER script in the chain still is.
  if (name === SELF) continue;
  const f = join(HERE, name);
  if (!existsSync(f)) continue;
  scanned++;
  const code = codeOnly(readFileSync(f, 'utf8'));
  for (const { re, name: what } of STEWARD_ONLY) {
    if (re.test(code)) problems.push(`  ${name} depends on ${what}`);
  }
}

process.stdout.write(`  ${reachable.length} script(s) in \`build\`, ${scanned} readable.\n`);

if (problems.length > 0) {
  process.stdout.write(`\n${problems.join('\n')}\n\n`);
  process.stdout.write(
    '  A gate that asserts on a steward-only path belongs in `build:steward`.\n' +
      '  Leaving it in `build` makes the shipped bundle unpassable by construction, and\n' +
      '  the adopter finds out in their terminal instead of this CI finding out here.\n',
  );
  process.exit(1);
}

process.stdout.write('\n=== check-build-chain-split OK — `build` is adopter-clean ===\n');
process.exit(0);
