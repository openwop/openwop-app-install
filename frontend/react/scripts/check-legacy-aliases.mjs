#!/usr/bin/env node
/**
 * Legacy alias ZERO-gate (ADR 0510 Phase 3, DSA-006). The `--color-*` /
 * `--font-*` compatibility aliases were migrated to their canonical tokens and
 * DELETED on 2026-08-01 (995 references at the time of the assessment). A new
 * reference OR a re-introduced definition would resolve to nothing (unstyled
 * UI) — fail loudly. The canonical vocabulary is `tokens.json`; the
 * white-label seam (`brand.css`) always offered canonical names only.
 *
 * DSYS-2 (2026-08-16): comment exclusion is exact now. The old per-line regex
 * could false-positive on a multi-line `/* … *​/` block whose interior line
 * named a retired token without a leading `*`, and could blank real code on a
 * line where `/*` sat inside a string. TS/TSX comment ranges come from a
 * real TypeScript PARSE (a bare scanner desyncs on JSX — measured); CSS
 * comments from a string-aware state machine. STRINGS DELIBERATELY STILL MATCH — a retired
 * token inside a string literal (`'var(--color-bg)'`) is a real reference
 * that resolves to nothing at runtime, which is exactly what this gate
 * exists to catch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = process.env.OPENWOP_GATE_SRC
  ? join(process.env.OPENWOP_GATE_SRC, '/')
  : new URL('../src/', import.meta.url).pathname;
const RETIRED = [
  '--color-bg', '--color-surface', '--color-surface-2', '--color-border',
  '--color-text', '--color-text-muted', '--color-accent', '--color-accent-hover',
  '--font-sans', '--font-mono',
];

const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(css|ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
};

/** Blank every comment (multi-line aware, string-aware) with spaces so
 *  offsets/line numbers are preserved. */
function blankComments(src, isCss) {
  const out = src.split('');
  const blank = (from, to) => { for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' '; };
  if (isCss) {
    // CSS: only /* */ comments; ' and " strings must not open a comment.
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'") {
        i += 1;
        while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
        i += 1;
      } else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        blank(i, stop);
        i = stop;
      } else i += 1;
    }
    return out.join('');
  }
  // TS/TSX: comment ranges from the REAL parse (the raw scanner desyncs on
  // JSX via the regex-literal ambiguity — measured: it missed a plain `//`
  // comment 365 lines into a JSX-heavy file). Every comment is the leading
  // trivia of SOME token (line-trailing comments lead the next token; EOF
  // comments lead the EndOfFile token), so walking tokens covers them all.
  const sf = ts.createSourceFile('f.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const seen = new Set();
  const visitTok = (node) => {
    if (node.getChildCount(sf) === 0) {
      for (const r of ts.getLeadingCommentRanges(src, node.getFullStart()) ?? []) {
        const key = `${r.pos}:${r.end}`;
        if (!seen.has(key)) { seen.add(key); blank(r.pos, r.end); }
      }
    } else {
      for (const c of node.getChildren(sf)) visitTok(c);
    }
  };
  visitTok(sf);
  return out.join('');
}

// Anti-vacuity: an empty walk is a broken gate, never a clean bill.
const files = walk(SRC);
if (files.length === 0) {
  console.error('✗ check-legacy-aliases: the walk found ZERO css/ts/tsx files — the gate is broken, not the code clean.');
  process.exit(1);
}

const violations = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const code = blankComments(src, file.endsWith('.css'));
  const rawLines = src.split('\n');
  code.split('\n').forEach((line, i) => {
    for (const name of RETIRED) {
      // `var(--color-text)` must not flag `var(--color-text-muted)` etc. —
      // require a non-word boundary after the name.
      const re = new RegExp(`${name.replace(/[-]/g, '\\-')}(?![\\w-])`);
      if (re.test(line)) violations.push(`${relative(SRC, file)}:${i + 1}  ${name}  ${(rawLines[i] ?? '').trim().slice(0, 80)}`);
    }
  });
}

if (violations.length) {
  console.error(`✗ check-legacy-aliases: ${violations.length} reference(s) to RETIRED alias tokens (they resolve to NOTHING):`);
  for (const v of violations.slice(0, 20)) console.error(`  src/${v}`);
  console.error('  Use the canonical token (see src/styles/tokens.json): paper/paper-2, rule, ink/ink-2/ink-3, clay-text(+-hover), sans/mono.');
  process.exit(1);
}
console.log('✓ check-legacy-aliases: zero references to the retired --color-*/--font-* aliases.');
