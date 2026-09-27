#!/usr/bin/env node
/** ADR 0510 Phase 0 — reproducible design-system facts. Human documentation owns
 * rules; this command owns volatile counts. `--json` emits machine-readable data. */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const walk = (dir, pred) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walk(path, pred) : pred(path) ? [path] : [];
});
const cssFiles = walk(SRC, (path) => path.endsWith('.css'));
const tsxFiles = walk(SRC, (path) => path.endsWith('.tsx'));
const pageFiles = tsxFiles.filter((path) => /Page\.tsx$/.test(path));
const css = cssFiles.map((path) => readFileSync(path, 'utf8')).join('\n');
const tsx = tsxFiles.map((path) => readFileSync(path, 'utf8')).join('\n');
const count = (text, pattern) => [...text.matchAll(pattern)].length;
const values = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
const aliases = [
  '--color-bg', '--color-surface', '--color-surface-2', '--color-border',
  '--color-text', '--color-text-muted', '--color-accent', '--color-accent-hover',
  '--font-sans', '--font-mono',
];
const aliasReferences = Object.fromEntries(aliases.map((alias) => [
  alias,
  css.split(`var(${alias})`).length - 1,
]));
const breakpoints = [...new Set(values(css, /@media[^\n{]*\((?:min|max)-width:\s*([0-9.]+(?:px|rem|em))/g))].sort();
const keyframes = [...new Set(values(css, /@keyframes\s+([\w-]+)/g))].sort();
const result = {
  generatedAt: new Date().toISOString(),
  css: {
    files: cssFiles.map((path) => relative(ROOT, path)),
    bytes: cssFiles.reduce((total, path) => total + statSync(path).size, 0),
    approximateRules: count(css, /[^@{}][^{]*\{/g),
    keyframes,
    breakpoints,
  },
  components: {
    tsxFiles: tsxFiles.length,
    pageFiles: pageFiles.length,
    pagesUsingPageHeader: pageFiles.filter((path) => readFileSync(path, 'utf8').includes('PageHeader')).length,
  },
  tokens: {
    definitions: new Set(values(css, /(--[\w-]+)\s*:/g)).size,
    referencedNames: new Set(values(`${css}\n${tsx}`, /var\((--[\w-]+)/g)).size,
    aliasReferences,
    aliasReferenceTotal: Object.values(aliasReferences).reduce((left, right) => left + right, 0),
  },
  inlineStyles: { directObjects: count(tsx, /style\s*=\s*\{\{/g) },
};

/** The durable markdown report (ADR 0510 Phase 3, DSA-004/008/024) — generated
 *  facts replace hand-maintained registries. `--write` regenerates it; `--check`
 *  fails when the committed copy has drifted from the source tree (the
 *  generated-at line is excluded from comparison, everything else is not). */
const REPORT = join(ROOT, '..', '..', 'docs', 'steward', 'DESIGN-SYSTEM-INVENTORY.md');
function renderReport() {
  return [
    '# Design-system inventory — GENERATED, do not hand-edit',
    '',
    '> Regenerate: `cd frontend/react && node scripts/design-system-inventory.mjs --write` ·',
    '> Drift-gated in `npm run build` (`--check`). Rules and exceptions live in `DESIGN.md`;',
    '> this file owns the volatile facts (ADR 0510 §10).',
    '',
    `## Counters`,
    '',
    `| Fact | Value |`,
    `|---|---:|`,
    `| Authored CSS files | ${result.css.files.length} (${result.css.files.join(', ')}) |`,
    `| Authored CSS bytes | ${result.css.bytes} |`,
    `| Approximate rules | ${result.css.approximateRules} |`,
    `| TSX files | ${result.components.tsxFiles} |`,
    `| Page components | ${result.components.pageFiles} |`,
    `| Pages using PageHeader | ${result.components.pagesUsingPageHeader} |`,
    `| Token definitions | ${result.tokens.definitions} |`,
    `| Referenced token names | ${result.tokens.referencedNames} |`,
    `| Legacy alias references | ${result.tokens.aliasReferenceTotal} |`,
    `| Direct inline-style objects | ${result.inlineStyles.directObjects} |`,
    '',
    `## Legacy alias references (target: 0, then the aliases are deleted)`,
    '',
    `| Alias | References |`,
    `|---|---:|`,
    ...aliases.map((a) => `| \`${a}\` | ${aliasReferences[a]} |`),
    '',
    `## Keyframe registry (${keyframes.length})`,
    '',
    ...keyframes.map((k) => `- \`${k}\``),
    '',
    `## Media-query width thresholds (${breakpoints.length})`,
    '',
    ...breakpoints.map((b) => `- \`${b}\``),
    '',
  ].join('\n') + '\n';
}

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else if (process.argv.includes('--write')) {
  writeFileSync(REPORT, renderReport());
  console.log(`wrote ${relative(process.cwd(), REPORT)}`);
} else if (process.argv.includes('--check')) {
  // The report lives under `docs/steward/`, which `build-whitelabel-zip.sh` strips
  // from the adopter bundle. An ABSENT report therefore means "not the steward repo"
  // — not drift — and must pass, or the shipped bundle's `npm run build` is
  // unpassable by construction for every adopter. Drift stays a hard failure
  // wherever the report IS present, which is the steward repo and its CI.
  let committed = null;
  try { committed = readFileSync(REPORT, 'utf8'); } catch { /* absent — see above */ }
  if (committed === null) {
    console.log('✓ design-system-inventory: no committed report (adopter bundle) — check not applicable.');
  } else if (committed !== renderReport()) {
    console.error('✗ design-system-inventory --check: docs/steward/DESIGN-SYSTEM-INVENTORY.md has drifted from the source tree.');
    console.error('  Regenerate + commit it: cd frontend/react && node scripts/design-system-inventory.mjs --write');
    process.exit(1);
  } else {
    console.log('✓ design-system-inventory: committed report matches the source tree.');
  }
} else {
  console.log('Design-system inventory (ADR 0510)');
  console.log(`CSS: ${result.css.files.length} files · ${result.css.bytes} bytes · ${result.css.approximateRules} approximate rules`);
  console.log(`TSX: ${result.components.tsxFiles} · pages: ${result.components.pageFiles} · PageHeader: ${result.components.pagesUsingPageHeader}`);
  console.log(`Tokens: ${result.tokens.definitions} definitions · ${result.tokens.referencedNames} referenced names · ${result.tokens.aliasReferenceTotal} legacy references`);
  console.log(`Keyframes: ${keyframes.length} · breakpoints: ${breakpoints.length} · direct inline-style objects: ${result.inlineStyles.directObjects}`);
}
