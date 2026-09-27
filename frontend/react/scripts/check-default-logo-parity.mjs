#!/usr/bin/env node
/**
 * Default-logo parity gate (ADR 0510 §6, DSA-017).
 *
 * The default OpenWOP mark exists in TWO deliberate forms with different
 * THEMING mechanisms — the inline `currentColor` SVG in `brand/OpenwopLogo.tsx`
 * (follows the app's effective mode) and `public/OpenWOP.svg` (a standalone
 * asset with an `@media (prefers-color-scheme)` style, for contexts outside
 * the app's CSS: favicons, README embeds, email). The theming split is by
 * design; the GEOMETRY drifting apart is not — a shape edit in one file that
 * misses the other ships two different logos.
 *
 * This gate compares the ordered `d="…"` path data (whitespace-normalized) of
 * both sources and fails on any divergence.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const paths = (svg) => [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());

const tsx = readFileSync(join(__dirname, '../src/brand/OpenwopLogo.tsx'), 'utf8');
const inlineSvg = tsx.match(/const OPENWOP_MARK = `([\s\S]*?)`;/)?.[1] ?? '';
const publicSvg = readFileSync(join(__dirname, '../public/OpenWOP.svg'), 'utf8');

const a = paths(inlineSvg);
const b = paths(publicSvg);

const problems = [];
if (!a.length) problems.push('OPENWOP_MARK not found / holds no paths (OpenwopLogo.tsx)');
if (!b.length) problems.push('public/OpenWOP.svg holds no paths');
if (a.length && b.length) {
  if (a.length !== b.length) problems.push(`path count differs: inline ${a.length} vs public ${b.length}`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) problems.push(`path #${i + 1} geometry differs:\n    inline: ${a[i].slice(0, 60)}…\n    public: ${b[i].slice(0, 60)}…`);
  }
}

if (problems.length) {
  console.error(`✗ check-default-logo-parity: the two default-logo sources have DRIFTED (${problems.length} issue(s)):`);
  for (const p of problems.slice(0, 6)) console.error(`  - ${p}`);
  console.error('  Edit BOTH sources in one change: src/brand/OpenwopLogo.tsx (inline, currentColor) and public/OpenWOP.svg (standalone, media-query themed).');
  process.exit(1);
}
console.log(`✓ check-default-logo-parity: ${a.length} paths in lockstep (OpenwopLogo.tsx ↔ public/OpenWOP.svg).`);
