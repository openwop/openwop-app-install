#!/usr/bin/env node
/**
 * CSP script-hash gate — runs AFTER `vite build`, against `dist/index.html`.
 *
 * The CSP in `firebase.json` pins `script-src` to the sha256 of the single
 * inline theme-bootstrap script (instead of `'unsafe-inline'`, which would
 * defeat the policy). That script's content is brand-stamped at build time
 * (`{{BRAND_DEFAULT_THEME}}`), so a white-label rebrand changes the hash. This
 * gate recomputes the hash from the BUILT html and fails the build if it no
 * longer matches the CSP — telling the operator the exact value to update
 * rather than silently shipping a CSP that would block the script once
 * enforced. (CSP is currently report-only; this keeps it accurate so promotion
 * to enforcing is a safe, known step.)
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync('dist/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  // No inline script → nothing to pin. (Theme bootstrap was externalized.)
  console.log('✓ check-csp-script-hash: no inline script in dist/index.html (skipped).');
  process.exit(0);
}
const computed = 'sha256-' + createHash('sha256').update(m[1], 'utf8').digest('base64');

const fb = readFileSync('../../firebase.json', 'utf8');
const cspMatch = fb.match(/script-src[^";]*/);
if (!cspMatch || !cspMatch[0].includes(computed)) {
  console.error(
    `✗ check-csp-script-hash: firebase.json script-src does not contain the ` +
    `inline theme-bootstrap hash.\n  Expected: '${computed}'\n  Update firebase.json script-src to include it (replace the stale 'sha256-…').`,
  );
  process.exit(1);
}
console.log(`✓ check-csp-script-hash: firebase.json script-src pins the inline script (${computed}).`);
