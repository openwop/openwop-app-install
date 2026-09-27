#!/usr/bin/env node
/**
 * Render every ```mermaid block in a markdown file to a self-contained,
 * offline HTML page.
 *
 *   node tools/mermaid/render.mjs docs/research/deep-research-cdp.md --open
 *
 * The mermaid bundle is taken from `frontend/react/node_modules` (mermaid is
 * already a frontend dependency — the chat renders diagrams with it), so this
 * needs no extra install, no npx download, and no network access.
 *
 * @module tools/mermaid/render
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { buildHtml, extractMermaidBlocks } from './helpers.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MERMAID_PKG = join(REPO_ROOT, 'frontend/react/node_modules/mermaid');
const MERMAID_BUNDLE = join(MERMAID_PKG, 'dist/mermaid.min.js');

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    [
      'usage: node tools/mermaid/render.mjs <input.md> [--out <dir>] [--open]',
      '',
      '  --out <dir>  output directory (default: .mermaid-out/<input-basename>/)',
      '  --open       open the rendered page in the default browser',
    ].join('\n')
  );
  process.exit(message ? 1 : 0);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) usage();

let input = '';
let outDir = '';
let openAfter = false;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--open') openAfter = true;
  else if (argv[i] === '--out') {
    outDir = argv[i + 1] ?? '';
    i += 1;
    if (!outDir) usage('--out needs a directory');
  } else if (argv[i].startsWith('-')) usage(`unknown flag ${argv[i]}`);
  else if (!input) input = argv[i];
  else usage('only one input file at a time');
}
if (!input) usage('no input file');

let markdown;
try {
  markdown = readFileSync(input, 'utf8');
} catch {
  usage(`cannot read ${input}`);
}

let mermaidVersion;
try {
  mermaidVersion = JSON.parse(readFileSync(join(MERMAID_PKG, 'package.json'), 'utf8')).version;
  readFileSync(MERMAID_BUNDLE); // presence check before we create anything
} catch {
  console.error(
    `error: mermaid bundle not found at ${MERMAID_BUNDLE}\n` +
      '       run: npm --prefix frontend/react install'
  );
  process.exit(1);
}

const blocks = extractMermaidBlocks(markdown);
if (!blocks.length) {
  console.error(`no \`\`\`mermaid blocks found in ${input}`);
  process.exit(1);
}

const stem = basename(input).replace(/\.mdx?$/i, '');
const target = outDir || join(REPO_ROOT, '.mermaid-out', stem);
mkdirSync(target, { recursive: true });
copyFileSync(MERMAID_BUNDLE, join(target, 'mermaid.min.js'));

const page = join(target, 'index.html');
writeFileSync(page, buildHtml({ title: basename(input), blocks, mermaidVersion }));

console.log(`wrote ${page}`);
for (const [index, block] of blocks.entries()) {
  const kind = block.code.split('\n')[0].trim();
  console.log(`  ${index + 1}. ${block.heading || '(untitled)'} — line ${block.line}, ${kind}`);
}

if (openAfter) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [page], { detached: true, stdio: 'ignore' }).unref();
}
