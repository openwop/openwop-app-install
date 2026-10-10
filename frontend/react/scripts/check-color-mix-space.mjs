#!/usr/bin/env node
/**
 * Color-mix interpolation-space gate — refuses `color-mix(in <polar space>, …)`
 * anywhere in `src/` (CSS and TS/TSX inline styles alike).
 *
 * Why: our neutrals (`--paper`, `--paper-2`, `--rule`, `--ink`, …) are hex
 * literals with very low chroma. Mixing them in a POLAR space (oklch / lch /
 * hsl / hwb) makes the result's hue depend on the browser's "is the hue
 * powerless?" rule. MEASURED 2026-10-07 on HeadlessChrome 147:
 *   color-mix(in oklch, var(--paper) 72%, var(--paper-2))
 *     → oklch(0.9509 0.0110 none)
 * The hue resolves to `none`, which renders as hue 0, so every warm-paper
 * surface (the workspace switcher, the public header, …) turned PINK.
 * `oklch(from var(--paper) l c h)` keeps its hue; only the mix loses it.
 *
 * A rectangular space (oklab / srgb / srgb-linear / xyz) has no hue channel,
 * so it cannot fail this way. Mixes involving the accent look the same in
 * oklab to the eye. Use `color-mix(in oklab, …)`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const POLAR = /color-mix\(\s*in\s+(oklch|lch|hsl|hwb)\b/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(css|tsx?|mjs)$/.test(name)) yield p;
  }
}

const hits = [];
let scanned = 0;
for (const file of walk(SRC)) {
  scanned++;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(POLAR)) hits.push(`${relative(ROOT, file)}:${i + 1}  in ${m[1]}`);
  });
}

if (scanned === 0) {
  console.error('\n✗ check-color-mix-space: scanned 0 files — the src path is wrong, so this gate cannot fail.\n');
  process.exit(1);
}
if (hits.length > 0) {
  console.error(`\n✗ check-color-mix-space: ${hits.length} color-mix() in a polar space (low-chroma neutrals lose their hue → pink).`);
  console.error('  Use `color-mix(in oklab, …)` instead. See the header of this script.\n');
  for (const h of hits.slice(0, 20)) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`✓ check-color-mix-space: ${scanned} files, no polar-space color-mix()`);
