#!/usr/bin/env node
/**
 * SITE-1 / WHD-35 — the ADR 0027 default home page exists TWICE and must agree.
 *
 * `host/systemSite.ts` seeds it into the CMS (served publicly when seeding is
 * on); `features/site/FrontPage.tsx` renders the SPA fallback when no CMS page
 * is configured. Both docstrings claim to be "the ADR 0027 default home page",
 * and the 3080f2f24 facelift changed one and not the other — a visitor's
 * headline then depended on which path rendered, invisibly from either side.
 *
 * Deleting one is NOT the fix: the SPA fallback is the only home page a clean
 * or white-label install (seeding off) has. A generated shared constant would
 * couple two things with different lifecycles — the SPA copy is `demo`-gated
 * where the seed is not.
 *
 * So this gate is deliberately a DETECTOR, not a cure. It cannot prevent drift;
 * it refuses to ship it, and forces a divergence to be a decision someone makes
 * rather than one that happens. If the two are ever meant to differ, update
 * this file and say why.
 */
import { readFileSync } from 'node:fs';

const BACKEND = 'backend/typescript/src/host/systemSite.ts';
const FRONTEND = 'frontend/react/src/features/site/i18n/en.ts';

function extract(file, re, label) {
  const src = readFileSync(file, 'utf8');
  const m = src.match(re);
  if (!m) {
    // A silent no-match would make this gate pass by finding nothing, which is
    // this repo's most reliable tell that a check is inert. Fail loudly instead.
    console.error(`check-default-page-drift: FAILED — could not locate ${label} in ${file}.`);
    console.error('  The gate cannot compare what it cannot find; fix the pattern rather than deleting the check.');
    process.exit(2);
  }
  return m[1];
}

const backendHero = extract(BACKEND, /DEFAULT_HERO_HEADINGS\s*=\s*\{\s*\n\s*en:\s*'([^']+)'/, 'DEFAULT_HERO_HEADINGS.en');
const frontendHero = extract(FRONTEND, /heroHeading:\s*'([^']+)'/, 'site:heroHeading');

if (backendHero !== frontendHero) {
  console.error('check-default-page-drift: FAILED — the two ADR 0027 default home pages disagree.\n');
  console.error(`  ${BACKEND}\n    DEFAULT_HERO_HEADINGS.en = ${JSON.stringify(backendHero)}`);
  console.error(`  ${FRONTEND}\n    site:heroHeading         = ${JSON.stringify(frontendHero)}\n`);
  console.error('  A visitor sees one or the other depending on whether the CMS seed ran.');
  console.error('  Update both, or update this gate and record why they differ.');
  process.exit(1);
}
console.log(`✓ check-default-page-drift: both ADR 0027 default pages agree (${JSON.stringify(backendHero)}).`);
