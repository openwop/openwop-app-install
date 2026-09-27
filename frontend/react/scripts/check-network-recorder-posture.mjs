#!/usr/bin/env node
/**
 * Network-recorder posture gate (ADR 0195 DUR-4, corrected 2026-07-15).
 *
 * The in-app Network inspector's FULL capture mirrors request/response bodies
 * into sessionStorage (credential-redacted via `redactRequestBody`, but still
 * body content). Two audiences, two opposite correct answers:
 *
 *   - app.openwop.dev (the SHOWCASE) WANTS it on — the inspector is the demo.
 *   - a white-label ADOPTER must NOT get body capture out of the box.
 *
 * Both are satisfied because `frontend/react/.env.production` is the steward's
 * OWN file and is STRIPPED from every adopter bundle. That is a load-bearing
 * assumption, so this gate pins all three legs of it. Previously the opt-in
 * lived ONLY on a DEPLOY.md command line, which a deploy silently dropped —
 * twice (2026-07-14, 2026-07-15: the panel shipped in liveness-only mode,
 * rendering "0 calls"). Documentation could not hold it; this gate can.
 *
 * Run from the `build` chain. Exit 1 on any breach.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FE = join(HERE, '..');
const REPO = join(FE, '..', '..');
const VAR = 'VITE_ENABLE_NETWORK_RECORDER';

const problems = [];

/** Value of `VAR` in an env file, or undefined when absent/commented. */
function envValue(file) {
  if (!existsSync(file)) return { missing: true };
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === VAR) return { value: m[2].trim() };
  }
  return { value: undefined };
}

// ── 1. The SHOWCASE opt-in must be present. ──
// Without it a bare `npm run build` ships liveness-only and the inspector reads
// "0 calls" — the exact regression this gate exists to end.
//
// STEWARD-ONLY leg. `.env.production` is the steward's own file and is stripped
// from every adopter bundle (that is this gate's own stated premise), and an
// adopter who writes their own per Phase 2.1 will never set a showcase debug
// flag in it. So asserting leg 1 outside the steward repo makes `npm run build`
// unpassable for every adopter. `docs/steward/` is stripped by the same script,
// so its absence is the marker for "not the steward repo". Legs 2 and 3 below
// stay unconditional — they protect the adopter and must always run.
// A white-label FORK that keeps `docs/steward/` for reference (PracticeMatch does —
// upstream's engineering history is useful) is still an adopter: it ships its own
// brand as the DEFAULT identity. So the steward marker is `docs/steward/` present
// AND the shipped brand still being OpenWOP. (Recorded in docs/UPSTREAM-ISSUES.md.)
const DEFAULTS_SRC = readFileSync(join(FE, 'src', 'brand', 'defaults.ts'), 'utf8');
// Look only inside BRAND_DEFAULTS — STOCK_OPENWOP_IDENTITY (the guard's reference
// values) legitimately carries the OpenWOP strings in every fork.
// FAIL LOUDLY IF THE ANCHOR MOVES. `indexOf` returns -1 when the anchor is gone,
// and `.slice(-1)` is not an error — it returns the file's LAST CHARACTER. That
// then has no `};`, so the inner slice yields `''`, the regex is false,
// SHIPS_OPENWOP_BRAND is false, IS_STEWARD_REPO is false, and leg 1 stops running
// ENTIRELY while this script still exits 0. A rename of `BRAND_DEFAULTS` would have
// silently disabled the showcase check with no output — the inert-check class this
// repo keeps rediscovering (an empty result that reads as a pass).
const ANCHOR = 'export const BRAND_DEFAULTS';
const anchorAt = DEFAULTS_SRC.indexOf(ANCHOR);
if (anchorAt < 0) {
  console.error(`check-network-recorder-posture: cannot find \`${ANCHOR}\` in src/brand/defaults.ts.`);
  console.error('  This check identifies the steward repo by reading that block. Without it the');
  console.error('  steward leg would be skipped silently, so this is a hard failure, not a skip.');
  console.error('  If the constant was renamed, update ANCHOR here in the same change.');
  process.exit(1);
}
const blockEnd = DEFAULTS_SRC.indexOf('};', anchorAt);
if (blockEnd < 0) {
  console.error(`check-network-recorder-posture: found \`${ANCHOR}\` but no closing \`};\` after it.`);
  process.exit(1);
}
const DEFAULTS_BLOCK = DEFAULTS_SRC.slice(anchorAt, blockEnd);
const SHIPS_OPENWOP_BRAND = /^\s*productName:\s*'OpenWOP'/m.test(DEFAULTS_BLOCK);
const IS_STEWARD_REPO = existsSync(join(REPO, 'docs', 'steward')) && SHIPS_OPENWOP_BRAND;
const prod = envValue(join(FE, '.env.production'));
if (!IS_STEWARD_REPO) {
  // adopter bundle — leg 1 not applicable
} else if (prod.missing) {
  problems.push('.env.production is missing — the showcase build config must exist.');
} else if (prod.value !== '1') {
  problems.push(
    `.env.production must set ${VAR}=1 (found ${prod.value === undefined ? 'nothing' : `"${prod.value}"`}). `
    + 'This file is the SHOWCASE\'s own config and is stripped from adopter bundles, so the opt-in belongs here — '
    + 'NOT on a DEPLOY.md command line a deploy can forget (it did, twice).',
  );
}

// ── 2. The ADOPTER template must stay silent (or explicitly off). ──
// This is the file adopters actually copy; silence ⇒ they inherit the code
// default, which is prod ⇒ liveness-only.
const example = envValue(join(FE, '.env.production.example'));
if (!example.missing && example.value !== undefined && example.value !== '0') {
  problems.push(
    `.env.production.example must NOT enable ${VAR} (found "${example.value}"). `
    + 'Adopters copy this file; enabling body capture by default is the DUR-4 breach.',
  );
}

// ── 3. The STRIP must still strip — the leg that makes leg 1 safe. ──
// `.env.production` may say =1 ONLY because it never reaches an adopter. If the
// white-label strip ever regresses, this fails BEFORE the showcase's opt-in
// becomes an adopter leak.
//
// This tests BEHAVIOUR, not source text: it lifts the two grep patterns out of
// the script and RUNS them over synthetic archive members. A first cut asserted
// on the script's text with regexes and silently passed a sabotaged strip — an
// assertion about source is not an assertion about behaviour.
const zipper = join(REPO, 'scripts', 'build-whitelabel-zip.sh');
if (!existsSync(zipper)) {
  problems.push('scripts/build-whitelabel-zip.sh is missing — the strip that makes .env.production=1 safe is gone.');
} else {
  const sh = readFileSync(zipper, 'utf8');
  const select = /grep -E '([^']+)'/.exec(sh)?.[1];
  const reject = /grep -vE '([^']+)'/.exec(sh)?.[1];
  if (!select || !reject) {
    problems.push(
      'scripts/build-whitelabel-zip.sh no longer exposes the two-grep strip (select real .env*, keep *.example). '
      + '.env.production=1 is ONLY safe while that strip holds.',
    );
  } else {
    // Reproduce the pipeline: members matching `select`, minus those matching `reject`.
    const strip = (members) => {
      try {
        const s = new RegExp(select);
        const r = new RegExp(reject);
        return members.filter((m) => s.test(m) && !r.test(m));
      } catch {
        return null;
      }
    };
    const MUST_STRIP = 'openwop-demo-app/frontend/react/.env.production';
    const MUST_KEEP = [
      'openwop-demo-app/frontend/react/.env.production.example',
      'openwop-demo-app/backend/typescript/.env.example',
      'openwop-demo-app/frontend/react/src/environment.ts', // must not be caught by the .env pattern
    ];
    const stripped = strip([MUST_STRIP, ...MUST_KEEP]);
    if (stripped === null) {
      problems.push('scripts/build-whitelabel-zip.sh strip patterns are not valid regexes — cannot verify adopter safety.');
    } else {
      if (!stripped.includes(MUST_STRIP)) {
        problems.push(
          `the white-label strip NO LONGER removes ${MUST_STRIP} (patterns: select=/${select}/, reject=/${reject}/). `
          + '.env.production sets VITE_ENABLE_NETWORK_RECORDER=1, which is safe ONLY because that file never reaches an '
          + 'adopter — restore the strip, or set the var back to 0. This is the DUR-4 breach the flip depends on avoiding.',
        );
      }
      for (const keep of MUST_KEEP) {
        if (stripped.includes(keep)) {
          problems.push(`the white-label strip now removes ${keep}, which adopters need (patterns: select=/${select}/, reject=/${reject}/).`);
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('✗ check-network-recorder-posture:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('✓ check-network-recorder-posture: showcase opt-in on, adopter template silent, white-label strip intact.');
