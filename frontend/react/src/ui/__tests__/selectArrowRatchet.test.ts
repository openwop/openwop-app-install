/**
 * RATCHET (#5883) — a single-line `<select>` draws its own arrow inside the field
 * (global.css `select:not([multiple]):not([size])`), because the native arrow sat on
 * the right border. That rule removes the native arrow (`appearance: none`), so a
 * later rule that OUTRANKS it and restyles a select with a `background` shorthand
 * erases the drawn arrow too, leaving a select with no arrow at all; a `padding`
 * shorthand runs the text under it. Found at build time on the CMS form card
 * (`.fp-formcard__card .form-card :is(…, select)`, specificity (0,4,1)).
 *
 * So: every rule in src/**\/*.css that targets a select (by type, or by a class a TSX
 * `<select>` carries) at a specificity of at least
 * the base rule's (0,2,1) may not set `background:`, and any inline-end padding it sets
 * keeps `var(--select-arrow-room)`. Single-line selects only: `[multiple]`/`[size]`
 * selects have no arrow. The forced-colors block restores the system arrow and is exempt.
 *
 * Sabotage, restored, red: put `select` back into the form card's `:is(…)` rule with
 * its `background:` and `padding:` shorthands; or add `.a .b .nb-transform__select
 * { background: … }`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');
const BASE = '.select-arrow-base'; // label only

/** Class names put on a `<select>` in markup: a rule can target a select by class alone. */
function selectClassNames(dir: string, out = new Set<string>()): Set<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') selectClassNames(p, out); continue; }
    if (!name.endsWith('.tsx') || name.endsWith('.test.tsx')) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/<select\b[^>]*?className=(?:"([^"]+)"|\{`([^`]+)`\}|\{'([^']+)'\})/g)) {
      const text = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      for (const c of text.split(/\s+/)) if (/^[A-Za-z_][\w-]*$/.test(c)) out.add(c);
    }
  }
  return out;
}

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') cssFiles(p, out); }
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

interface Rule { ctx: string[]; selector: string; body: string }
function rules(css: string, ctx: string[] = [], out: Rule[] = []): Rule[] {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const selector = s.slice(i, open).trim();
    let depth = 1; let k = open + 1;
    while (k < s.length && depth) { if (s[k] === '{') depth += 1; else if (s[k] === '}') depth -= 1; k += 1; }
    const body = s.slice(open + 1, k - 1);
    if (selector.startsWith('@')) rules(body, [...ctx, selector], out);
    else out.push({ ctx, selector, body });
    i = k;
  }
  return out;
}

function splitTop(s: string): string[] {
  const parts: string[] = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

type Spec = [number, number, number];
const cmp = (a: Spec, b: Spec): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
/** Selectors Level 4 specificity, enough for this stylesheet: `:is`/`:not`/`:has` take
 *  their most specific argument, `:where` counts nothing. */
function specificity(sel: string): Spec {
  let s = sel.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '');
  for (;;) {
    const m = /:(is|not|has)\(/.exec(s);
    if (!m) break;
    let depth = 1; let k = m.index + m[0].length;
    while (depth) { if (s[k] === '(') depth += 1; else if (s[k] === ')') depth -= 1; k += 1; }
    const inner = s.slice(m.index + m[0].length, k - 1);
    const best = splitTop(inner).reduce((a, b) => (cmp(specificity(a), specificity(b)) >= 0 ? a : b), '');
    s = `${s.slice(0, m.index)} ${best} ${s.slice(k)}`;
  }
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!:)[\w-]+/g) ?? []).length;
  const types = (s.match(/(?:^|[\s>+~(])[a-zA-Z][\w-]*/g) ?? []).length + (s.match(/::[\w-]+/g) ?? []).length;
  return [ids, classes, types];
}

/** The last compound targets a single-line select: a `select` type, or a class used on a
 *  `<select>` in markup; not `[multiple]`/`[size]`. */
const targetsSingleLineSelect = (sel: string, selectClasses: ReadonlySet<string> = new Set()): boolean => {
  const last = sel.trim().split(/[\s>+~]+(?![^(]*\))/).pop() ?? '';
  const flat = last.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '');
  if (/\[(multiple|size)\b/.test(flat)) return false;
  if (/(?:^|[(,\s])select\b/.test(flat)) return true;
  // A compound that names another element (`a.btn-sm`) is not a select, whatever its classes.
  if (/^[a-zA-Z][\w-]*/.test(flat)) return false;
  return [...flat.matchAll(/\.([\w-]+)/g)].some((m) => selectClasses.has(m[1] ?? ''));
};

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m?.[1] !== undefined ? m[1].trim() : null;
};

function offenders(): string[] {
  const floor: Spec = [0, 2, 1];
  const selectClasses = selectClassNames(SRC);
  const out: string[] = [];
  for (const file of cssFiles(SRC)) {
    for (const r of rules(readFileSync(file, 'utf8'))) {
      if (r.ctx.some((c) => /forced-colors/.test(c))) continue;
      for (const sel of splitTop(r.selector)) {
        if (!targetsSingleLineSelect(sel, selectClasses) || cmp(specificity(sel), floor) < 0) continue;
        const where = `${relative(SRC, file)} :: ${sel}`;
        if (decl(r.body, 'background') !== null) out.push(`${where} sets background:`);
        for (const prop of ['padding', 'padding-inline', 'padding-inline-end', 'padding-right', 'padding-left']) {
          const v = decl(r.body, prop);
          if (v !== null && !v.includes('--select-arrow-room')) out.push(`${where} sets ${prop}: ${v}`);
        }
      }
    }
  }
  return out;
}

describe(`#5883 — the drawn select arrow survives the cascade (${BASE})`, () => {
  const css = readFileSync(join(SRC, 'styles', 'global.css'), 'utf8');

  it('the base rule draws the arrow, mirrors it in RTL, and gives forced-colors the system arrow', () => {
    const all = rules(css);
    const base = all.find((r) => r.ctx.length === 0 && r.selector === 'select:not([multiple]):not([size])');
    expect(base?.body).toMatch(/appearance:\s*none/);
    expect(decl(base?.body ?? '', 'padding-inline-end')).toBe('var(--select-arrow-room)');
    expect(base?.body).toMatch(/background-image:[\s\S]*currentColor/);
    expect(all.some((r) => r.selector === '[dir="rtl"] select:not([multiple]):not([size])' && /background-position/.test(r.body))).toBe(true);
    expect(all.some((r) => r.ctx.some((c) => /forced-colors/.test(c)) && /select:not\(\[multiple\]\)/.test(r.selector) && /appearance:\s*auto/.test(r.body))).toBe(true);
  });

  it('no rule that outranks it erases the arrow or its padding', () => {
    expect(offenders()).toEqual([]);
  });

  it('the scanner sees an outranking select rule (guards a vacuous green)', () => {
    expect(specificity('.fp-formcard__card .form-card :is(input:not([type="checkbox"]):not([type="radio"]), textarea, select)')).toEqual([0, 4, 1]);
    expect(targetsSingleLineSelect('.fp-formcard__card .form-card select')).toBe(true);
    expect(targetsSingleLineSelect('.x :is(select[multiple], select[size])')).toBe(false);
    // A class put on a <select> in markup counts too; an anchor's does not.
    expect(selectClassNames(SRC).has('nb-transform__select')).toBe(true);
    expect(targetsSingleLineSelect('.a .b .nb-transform__select', selectClassNames(SRC))).toBe(true);
    expect(targetsSingleLineSelect('a.btn.btn-sm', selectClassNames(SRC))).toBe(false);
  });
});
