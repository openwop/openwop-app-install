#!/usr/bin/env node
/**
 * Static inline-style RATCHET (ADR 0510 §4, DSA-011; policy = DESIGN.md §10).
 *
 * A `style={{ … }}` object whose EVERY value is a quoted string or numeric
 * literal is STATIC — it belongs in a class (`u-*` utility or a component
 * class). Objects containing any identifier/expression are dynamic (measured
 * sizes, transforms, progress widths, CSS-variable forwarding — the §10
 * allowlisted categories) and are not counted.
 *
 * Same contract as the spacing/typography gates: shrink-only. A static object
 * whose values are ONLY `var(--…)` token references is also permitted (the
 * documented token-forwarding path).
 *
 * DSYS-2 (2026-08-16): detection is a real TypeScript AST walk, not the old
 * brace-matching regex — the JSX attribute, the object literal and each
 * property are the compiler's own nodes, so comments, strings containing
 * commas, and template literals can no longer confuse the classifier. The
 * classification CONTRACT is per the docblock rule above (the cutover check
 * — both classifiers reporting 0 on the live tree — could only prove
 * agreement on the empty set; the unit tests in gates.test.ts carry the
 * non-empty cases, including the mixed token+literal object):
 * a property counts as static only when its value is a string literal
 * (quotes, not backticks — a template literal reads as authored dynamism,
 * exactly as the regex treated it) or a numeric literal (negatives
 * included); any spread, shorthand, computed name or other expression makes
 * the object dynamic; a `var(--…)` string value makes the object permitted.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { readGateBaseline } from './gateBaseline.mjs';

const SRC = process.env.OPENWOP_GATE_SRC
  ? join(process.env.OPENWOP_GATE_SRC, '/')
  : new URL('../src/', import.meta.url).pathname;
const BASELINE = readGateBaseline('check-inline-styles', 'OPENWOP_INLINE_STYLE_BASELINE', 0);

const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, acc); }
    else if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) acc.push(p);
  }
  return acc;
};

const isNumericLiteral = (node) =>
  ts.isNumericLiteral(node) ||
  (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand));

/** The regex contract, on AST nodes: static ⇔ every property is a plain
 *  assignment to a quoted-string or numeric literal, with no var() token. */
function classifyStyleObject(obj) {
  if (obj.properties.length === 0) return 'dynamic';
  let sawStatic = false;
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) return 'dynamic'; // spread / shorthand / accessor
    if (ts.isComputedPropertyName(p.name)) return 'dynamic';
    const v = p.initializer;
    if (ts.isStringLiteral(v)) {
      // Token forwarding is allowed for the TOKEN property — it must not
      // exempt the literals BESIDE it (grade-trio finding 7: an early return
      // here let `{ color: 'var(--ink)', marginTop: '12px' }` pass the gate;
      // the docblock's rule is "ONLY var() values").
      if (/^var\(--[\w-]+\)$/.test(v.text)) continue;
      sawStatic = true;
      continue;
    }
    if (isNumericLiteral(v)) { sawStatic = true; continue; }
    return 'dynamic'; // identifier, call, template literal, conditional, …
  }
  return sawStatic ? 'static' : 'dynamic';
}

// Anti-vacuity (the check-failure-card-announce precedent): a broken SRC or
// walk yields an empty file list, and an empty scan must read as a BROKEN
// GATE, never as a clean bill.
const files = walk(SRC);
if (files.length === 0) {
  console.error(`✗ ${process.argv[1]?.split('/').pop()}: the walk found ZERO ${'%s'} — the gate is broken, not the code clean.`.replace('%s', 'tsx files'));
  process.exit(1);
}

let count = 0;
const perFile = new Map();
for (const f of files) {
  const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) && node.name.text === 'style' &&
      node.initializer && ts.isJsxExpression(node.initializer) &&
      node.initializer.expression && ts.isObjectLiteralExpression(node.initializer.expression)
    ) {
      if (classifyStyleObject(node.initializer.expression) === 'static') {
        count++;
        const rel = relative(SRC, f);
        perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (count > BASELINE) {
  const rows = [...perFile.entries()].sort((a, b) => b[1] - a[1]);
  console.error(`✗ check-inline-styles: ${count} STATIC inline-style objects (baseline ${BASELINE}). You ADDED ${count - BASELINE}.`);
  console.error('  Static geometry/typography belongs in a class (DESIGN.md §10). Top holders:');
  for (const [f, n] of rows.slice(0, 8)) console.error(`    ${f}: ${n}`);
  process.exit(1);
}
const note = count < BASELINE ? ` — down ${BASELINE - count}; lower BASELINE to ${count}.` : '';
console.log(`✓ check-inline-styles: ${count} static inline-style objects (baseline ${BASELINE}, ratchet holds).${note}`);
