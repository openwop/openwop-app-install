#!/usr/bin/env node
/**
 * Publishes the VIDEO (film) identity tokens (ADR 0510 Phase 10, DESIGN.md §6.1).
 *
 * The films on openwop.dev are rendered in another repo (`openwop-site/video`),
 * so they cannot import `src/styles/tokens.json`. This writes the film subset to
 * `public/`, which Hosting serves as static files:
 *
 *   /design-tokens.json   the `video` group + its colours and type families
 *   /design-tokens.css    the same colours and families as custom properties
 *
 * Source of truth is `src/styles/tokens.json` (colours also live in
 * `foundations/tokens.css`, held in lockstep by check-dtcg-parity). Both outputs
 * are committed; `--check` (in `build`) fails when either is stale, so a token
 * edit cannot ship without the published copy moving with it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const graph = JSON.parse(readFileSync(join(ROOT, 'src/styles/tokens.json'), 'utf8'));
const { $description, ...video } = graph.video ?? {};
if (!video.canvas) {
  console.error('✗ gen-design-tokens: tokens.json has no `video` group');
  process.exit(1);
}

const PREFIX = 'video-';
const color = {};
for (const [key, entry] of Object.entries(graph.tokens)) {
  if (key.startsWith(PREFIX)) color[key.slice(PREFIX.length)] = entry.$value;
}
const fontFamily = {};
for (const role of ['headline', 'body', 'label']) {
  const entry = graph.tokens[video.type[role]];
  if (!entry) {
    console.error(`✗ gen-design-tokens: video.type.${role} names no token`);
    process.exit(1);
  }
  fontFamily[role] = entry.$value;
}
if (Object.keys(color).length === 0) {
  console.error('✗ gen-design-tokens: no video-* colour tokens found');
  process.exit(1);
}

const json = `${JSON.stringify({
  $description: 'OpenWOP video (film) identity tokens. Generated from the app design system — do not edit. Rules and specimens: /design-system (Video).',
  video: { ...video, color, fontFamily },
}, null, 2)}\n`;

const css = [
  '/* OpenWOP video (film) identity tokens. Generated from the app design system — do not edit. */',
  ':root {',
  ...Object.entries(color).map(([k, v]) => `  --${PREFIX}${k}: ${v};`),
  ...Object.entries(fontFamily).map(([k, v]) => `  --${PREFIX}font-${k}: ${v};`),
  '}',
  '',
].join('\n');

const outputs = [['public/design-tokens.json', json], ['public/design-tokens.css', css]];
if (process.argv.includes('--check')) {
  const stale = outputs.filter(([p, body]) => !existsSync(join(ROOT, p)) || readFileSync(join(ROOT, p), 'utf8') !== body);
  if (stale.length > 0) {
    console.error(`✗ gen-design-tokens: stale ${stale.map(([p]) => p).join(', ')} — run \`node scripts/gen-design-tokens.mjs\``);
    process.exit(1);
  }
  console.log(`✓ gen-design-tokens: ${Object.keys(color).length} film colours + ${Object.keys(fontFamily).length} families published in lockstep.`);
} else {
  for (const [p, body] of outputs) writeFileSync(join(ROOT, p), body);
  console.log(`✓ gen-design-tokens: wrote ${outputs.map(([p]) => p).join(', ')}`);
}
