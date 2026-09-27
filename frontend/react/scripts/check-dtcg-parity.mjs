#!/usr/bin/env node
/**
 * DTCG token-graph parity gate (ADR 0510 §2, DSA-032).
 *
 * `src/styles/tokens.json` is the DTCG-format identity/contract source for the
 * foundation tokens; `src/styles/global.css` `:root` / `:root.theme-dark` still
 * own the runtime values until Phase 5 generates the CSS from the graph. Until
 * then the two MUST agree byte-for-byte — a divergent pair means either an
 * undeclared design decision (CSS edited, graph not) or a lying contract
 * (graph edited, CSS not). Both directions fail.
 *
 * Scope: every custom property declared in the top-level `:root` block and the
 * `:root.theme-dark` block. New tokens must be added to BOTH files in one
 * change; deletions likewise.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, '../src/styles/foundations/tokens.css'), 'utf8');
const graph = JSON.parse(readFileSync(join(__dirname, '../src/styles/tokens.json'), 'utf8'));

function block(startRe) {
  const m = css.match(startRe);
  if (!m) return null;
  const open = css.indexOf('{', m.index);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) {
      const body = css.slice(open + 1, j);
      const out = {};
      for (const dm of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
        out[dm[1]] = dm[2].trim().replace(/\s+/g, ' ');
      }
      return out;
    }
  }
  return null;
}

const light = block(/\n:root \{/);
const dark = block(/\n:root\.theme-dark[^{]*\{/);
// DSYS-1: the system-dark duplicate map (`@media (prefers-color-scheme: dark)
// { :root:not(.theme-light) { … } }`) must agree with the manual-dark block —
// a token changed in one but not the other renders DIFFERENT dark palettes for
// system-dark vs forced-dark users.
const mediaDark = block(/@media \(prefers-color-scheme: dark\)[^{]*\{\s*\n\s*:root:not\(\.theme-light\)[^{]*\{/);
if (!light || !dark) {
  console.error('✗ check-dtcg-parity: could not locate :root / :root.theme-dark blocks');
  process.exit(1);
}

const problems = [];
const graphTokens = graph.tokens ?? {};
const byCssName = new Map();
for (const [key, entry] of Object.entries(graphTokens)) {
  const cssName = entry.$extensions?.openwop?.cssName ?? `--${key}`;
  byCssName.set(cssName, entry);
}

for (const [name, value] of Object.entries(light)) {
  const entry = byCssName.get(name);
  if (!entry) { problems.push(`CSS declares ${name} but tokens.json has no entry`); continue; }
  if (entry.$value !== value) problems.push(`${name}: css="${value}" ≠ tokens.json="${entry.$value}"`);
}
for (const [name, value] of Object.entries(dark)) {
  const entry = byCssName.get(name);
  if (!entry) { problems.push(`.theme-dark declares ${name} but tokens.json has no entry`); continue; }
  const darkVal = entry.$extensions?.openwop?.darkOnly ? entry.$value : entry.$extensions?.openwop?.dark;
  if (darkVal !== value) problems.push(`${name} (dark): css="${value}" ≠ tokens.json="${darkVal}"`);
}
if (mediaDark) {
  for (const [name, value] of Object.entries(mediaDark)) {
    if (!(name in dark)) { problems.push(`system-dark declares ${name} but .theme-dark does not`); continue; }
    if (dark[name] !== value) problems.push(`${name}: system-dark "${value}" ≠ .theme-dark "${dark[name]}" (the two dark maps have FORKED)`);
  }
  for (const name of Object.keys(dark)) {
    if (!(name in mediaDark)) problems.push(`.theme-dark declares ${name} but the system-dark media block does not`);
  }
}
for (const [name, entry] of byCssName) {
  const inLight = name in light;
  const inDark = name in dark;
  if (!inLight && !inDark) problems.push(`tokens.json declares ${name} but global.css does not`);
  if (entry.$extensions?.openwop?.dark !== undefined && !inDark) problems.push(`tokens.json declares a dark value for ${name} but .theme-dark does not`);
}

if (problems.length) {
  console.error(`✗ check-dtcg-parity: ${problems.length} divergence(s) between tokens.json and foundations/tokens.css:`);
  for (const p of problems.slice(0, 25)) console.error(`  - ${p}`);
  if (problems.length > 25) console.error(`  … and ${problems.length - 25} more`);
  console.error('  Edit BOTH files in one change — the graph is the declared contract, the CSS is the runtime.');
  process.exit(1);
}
console.log(`✓ check-dtcg-parity: ${byCssName.size} tokens in lockstep (tokens.json ↔ foundations/tokens.css :root/.theme-dark).`);
