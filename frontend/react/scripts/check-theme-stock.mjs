/**
 * check-theme-stock (ADR 0171 Phase B) — token-tier drift guard.
 *
 * The brand theme generator's STOCK constants (src/brand/theme/generate.ts) and the
 * stock token literals in src/styles/global.css are mirrors across the JS↔CSS
 * boundary (CSS can't import the TS constants). This gate fails if they drift, so
 * changing a stock token in one file forces the matching change in the other — the
 * "default seed-set reproduces the current literals" invariant, enforced at the
 * source. Runs in Node against the RAW files (no Vite transform), so it's a precise
 * byte compare (both files use identical literal strings by construction).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles/global.css'), 'utf8');
const gen = readFileSync(join(root, 'src/brand/theme/generate.ts'), 'utf8');

// Tokens the generator OWNS (alpha-derived accent variants stay CSS relative-color).
const GENERATED = ['--clay', '--paper', '--paper-2', '--rule', '--rule-2', '--ink', '--ink-2', '--ink-3'];
const DARK = GENERATED.filter((t) => t !== '--clay'); // --clay inherited from :root in dark

const norm = (v) => v.trim().replace(/\s+/g, ' ');

/** Extract `--token: value;` from the first `selector { … }` block. */
function cssBlock(selector) {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  const out = {};
  if (m) for (const t of m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[t[1]] = norm(t[2]);
  return out;
}
/** Extract a STOCK_* object literal's `'--token': 'value'` entries from generate.ts. */
function genStock(name) {
  const m = new RegExp(`${name}[^=]*=\\s*\\{([^}]*)\\}`).exec(gen);
  const out = {};
  if (m) for (const t of m[1].matchAll(/'(--[a-z0-9-]+)':\s*'([^']+)'/g)) out[t[1]] = norm(t[2]);
  return out;
}

const cssLight = cssBlock(':root'), cssDark = cssBlock(':root.theme-dark');
const genLight = genStock('STOCK_LIGHT'), genDark = genStock('STOCK_DARK');
// STOCK_ACCENT feeds STOCK_LIGHT['--clay'] indirectly; pull it too.
const accentM = /STOCK_ACCENT\s*=\s*'([^']+)'/.exec(gen);
if (accentM) genLight['--clay'] = norm(accentM[1]);

const drift = [];
for (const t of GENERATED) {
  if (cssLight[t] !== genLight[t]) drift.push(`light ${t}: global.css "${cssLight[t]}" ≠ generate.ts "${genLight[t]}"`);
}
for (const t of DARK) {
  if (cssDark[t] !== genDark[t]) drift.push(`dark ${t}: global.css "${cssDark[t]}" ≠ generate.ts "${genDark[t]}"`);
}

if (drift.length) {
  console.error(`✗ check-theme-stock: ${drift.length} stock-token drift(s) between generate.ts and global.css:`);
  for (const d of drift) console.error(`  ${d}`);
  console.error('  → keep the generator STOCK constants and the global.css stock literals in lockstep (ADR 0171).');
  process.exit(1);
}
console.log(`✓ check-theme-stock: ${GENERATED.length} stock tokens in lockstep (generate.ts ↔ global.css).`);
