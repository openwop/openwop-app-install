#!/usr/bin/env node
/**
 * test-census — Tier 1 of the /grade-tests skill: a mechanical census of EVERY
 * test case in the app (backend + frontend vitest, Playwright e2e, clients,
 * tools), so a grading pass covers the whole suite instead of a sample.
 *
 * Why it exists: the suite is ~3,500 files / ~25,000 cases. The skill's deep
 * tier (read the subject, sabotage it, see what goes red) costs minutes per
 * file, so it cannot be the only instrument. This census reads every case's AST
 * and flags the shapes that make a test unable to fail or not worth its cost:
 *
 *   NO_ASSERT        — the case asserts nothing (no expect/assert/assert-helper)
 *   CONDITIONAL      — every assertion sits under an if / ?: / catch / &&
 *   WEAK_ONLY        — only toBeDefined / toBeTruthy / not.toBeNull / …
 *   STATUS_ONLY      — only asserts a `.status` / `.statusCode`
 *   MOCK_ONLY        — only asserts toHaveBeenCalled*
 *   SNAPSHOT_ONLY    — only toMatchSnapshot / toMatchInlineSnapshot
 *   SKIPPED / TODO / ONLY — not running, or hiding the rest of the file
 *   DUPLICATE_BODY   — byte-identical (normalised) case body in another case
 *
 * and per file: laundering casts (`as any`, `as unknown as`, @ts-ignore),
 * fixed sleeps without fake timers (wall-clock reads are a note — the clock-shift
 * lane is the measurement), a `createApp` boot, a
 * header that names no ADR / RFC / gap id, and (with --durations) runtime.
 *
 * It assigns each file a CEILING — the best grade the census allows — not a
 * grade. Reading alone never deletes (SKILL.md Step 4); a ceiling of D/F only
 * queues a file for the deep tier first. A clean census is necessary for an A,
 * never sufficient.
 *
 * Usage:
 *   node scripts/test-census.mjs [--json <ledger.json>] [--full-json <dump.json>] [--md <out.md>]
 *        [--durations <vitest-json>[,<vitest-json>…]] [path-prefix …]
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';

// The repo is the one you run from (your own worktree), not the one this file
// lives in — a probe applied to the wrong checkout edits and tests the wrong code.
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
function loadTypeScript() {
  for (const ws of ['backend/typescript', 'frontend/react']) {
    try { return createRequire(join(ROOT, ws, 'package.json'))('typescript'); } catch { /* try the next workspace */ }
  }
  console.error('test-census: no `typescript` found — install a workspace first (`npx -y npm@10.9.8 ci` in backend/typescript).');
  process.exit(2);
}
const ts = loadTypeScript();

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const jsonOut = opt('--json');
const fullJsonOut = opt('--full-json');
const mdOut = opt('--md');
const durationsArg = opt('--durations');
const prefixes = args;

const TEST_RE = /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/;
const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => TEST_RE.test(f) && !f.includes('node_modules/'))
  .filter((f) => prefixes.length === 0 || prefixes.some((p) => f.startsWith(p)));

// ---------------------------------------------------------------- durations
const durations = new Map();
if (durationsArg) {
  for (const p of durationsArg.split(',')) {
    const r = JSON.parse(readFileSync(p, 'utf8'));
    for (const t of r.testResults ?? []) {
      const rel = relative(ROOT, resolve(t.name));
      durations.set(rel, ((t.endTime ?? 0) - (t.startTime ?? 0)) / 1000);
    }
  }
}

// ---------------------------------------------------------------- AST helpers
const CASE_ROOTS = new Set(['it', 'test']);
const MODIFIERS = new Set(['skip', 'todo', 'only', 'skipIf', 'runIf', 'fails', 'each', 'concurrent', 'sequential', 'fixme', 'slow']);
const WEAK = new Set(['toBeDefined', 'toBeTruthy', 'not.toBeNull', 'not.toBeUndefined', 'toBeInstanceOf', 'not.toBeFalsy', 'not.toThrow']);
const MOCK = new Set(['toHaveBeenCalled', 'toHaveBeenCalledWith', 'toHaveBeenCalledTimes', 'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith', 'toBeCalled', 'toBeCalledWith', 'toBeCalledTimes']);
const SNAP = new Set(['toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchFileSnapshot', 'toHaveScreenshot']);
const QUERY_RE = /^(get|find)(All)?By[A-Z]\w*$/;
const ASSERT_NAME_RE = /^(expect|assert|check|verify|must|ensure|witness)/i;
const REF_RE = /\b(ADR|RFC)[ -]?\d{2,4}\b|\bGAP-ANALYSIS\s+[A-Z]\d{1,3}\b|\b[A-Z][A-Z0-9]{1,12}-[A-Z]?\d{1,4}\b|\bGap [A-Z]-\d{1,3}\b|incident|regression|#\d{3,5}\b/;

/** Walk a call chain like it.skip.each(rows)(title, fn) down to its root. */
function caseCallInfo(node) {
  if (!ts.isCallExpression(node)) return null;
  const mods = [];
  let callee = node.expression;
  for (let guard = 0; guard < 8; guard++) {
    if (ts.isIdentifier(callee)) {
      return CASE_ROOTS.has(callee.text) ? { root: callee.text, mods } : null;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      if (!MODIFIERS.has(name)) return null;
      mods.push(name);
      callee = callee.expression;
      continue;
    }
    if (ts.isCallExpression(callee)) {
      callee = callee.expression; // it.each(rows)(…) / it.skipIf(cond)(…)
      continue;
    }
    return null;
  }
  return null;
}

function literalText(n) {
  if (!n) return '';
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + '${…}';
  return n.getText().slice(0, 80);
}

/** For an `expect(x)` call, find the matcher chain applied to it. */
function matcherOf(expectCall) {
  const parts = [];
  let cur = expectCall;
  while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur) {
    parts.push(cur.parent.name.text);
    cur = cur.parent;
  }
  const filtered = parts.filter((p) => p !== 'resolves' && p !== 'rejects' && p !== 'soft');
  return filtered.join('.');
}

function isExpectCall(n) {
  if (!ts.isCallExpression(n)) return false;
  const e = n.expression;
  if (ts.isIdentifier(e)) return e.text === 'expect';
  // expect.soft(x) / expect.poll(fn)
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'expect'
    && (e.name.text === 'soft' || e.name.text === 'poll');
}

function isConditional(node, stopAt) {
  for (let p = node.parent; p && p !== stopAt; p = p.parent) {
    if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isCatchClause(p)) return true;
    if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || p.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return true;
    // Nested callback that may never run (e.g. inside .then / a listener). Loops are fine.
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isCallExpression(p.parent)) {
      const callee = p.parent.expression.getText();
      if (!/^(expect|it|test|describe|waitFor|vi\.waitFor|act|step|test\.step)\b/.test(callee)
        && !/\.(forEach|map|every|some|filter|reduce)$/.test(callee)) return true;
    }
  }
  return false;
}

function normalise(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
}

// ---------------------------------------------------------------- per file
const bodyIndex = new Map(); // hash -> [{file, title}]
const results = [];

for (const file of files) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, 'utf8');
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

  // Local assertion helpers: functions whose body contains an assertion/throw.
  const assertFns = new Set();
  const visitFns = (n) => {
    let name; let body;
    if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; body = n.body; }
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      name = n.name.text; body = n.initializer.body;
    }
    if (name && body && /\bexpect\s*[(.]|\bassert[\w.]*\s*\(|\bthrow\b/.test(body.getText())) assertFns.add(name);
    ts.forEachChild(n, visitFns);
  };
  visitFns(sf);

  // Top-level const initializers, for the duplicate-body hash.
  const topLevel = new Map();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) topLevel.set(d.name.text, d.initializer.getText().slice(0, 400));
      }
    }
  }

  // File-level signals.
  // The header is the first comment block before the first describe/it — a
  // file may open with imports or a `// @vitest-environment` pragma first
  // (calibration: firebase.test.ts read as "no header" with one above its suite).
  const firstCase = text.search(/^\s*(describe|it|test)(\.\w+)*\(/m);
  const preamble = text.slice(0, firstCase === -1 ? 6000 : Math.min(firstCase, 6000));
  const header = (preamble.match(/\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/.*\n){2,}/m) ?? [''])[0];
  const casts = (text.match(/\bas any\b/g) ?? []).length
    + (text.match(/\bas unknown as\b/g) ?? []).length
    + (text.match(/@ts-(ignore|nocheck|expect-error)/g) ?? []).length;
  const fakeTimers = /useFakeTimers|setSystemTime|clockShift/.test(text);
  const clockUses = (text.match(/\bDate\.now\(\)|new Date\(\)|Math\.random\(\)|performance\.now\(\)/g) ?? []).length;
  const sleeps = (text.match(/setTimeout\([^,)]*,\s*[1-9]\d*\s*\)|\bsleep\(\s*[1-9]|waitForTimeout\(/g) ?? []).length;
  const boots = (text.match(/\bcreateApp\(/g) ?? []).length;

  const cases = [];
  // An env-gated suite skips in the gate even though no case says `.skip`:
  // `const run = KEY ? describe : describe.skip; run(…)` or the inline
  // `(KEY ? describe : describe.skip)(…)`. Its cases are SKIPPED here
  // (calibration: live-gemini-media read as 3 running cases, wave 5).
  const gatedAliases = new Set([...text.matchAll(/(?:const|let)\s+(\w+)\s*=[^;\n]*\?\s*(?:describe|it|test)(?:\.\w+)?\s*:\s*(?:describe|it|test)\.skip\b/g)].map((m) => m[1]));
  const isGatedCall = (n) => ts.isCallExpression(n) && (
    (ts.isIdentifier(n.expression) && gatedAliases.has(n.expression.text))
    || (ts.isParenthesizedExpression(n.expression) && ts.isConditionalExpression(n.expression.expression) && /\.skip\b/.test(n.expression.expression.getText())));
  let gatedDepth = 0;
  const visit = (n) => {
    const info = caseCallInfo(n);
    if (info) {
      const call = n;
      const titleArg = call.arguments[0];
      const fn = [...call.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      const c = { title: literalText(titleArg), line: sf.getLineAndCharacterOfPosition(call.getStart()).line + 1, flags: [] };
      if (gatedDepth > 0 || info.mods.includes('skip') || info.mods.includes('skipIf') || info.mods.includes('fixme')) c.flags.push('SKIPPED');
      if (info.mods.includes('todo')) c.flags.push('TODO');
      if (info.mods.includes('only')) c.flags.push('ONLY');
      if (fn && !info.mods.includes('todo')) {
        const asserts = []; // {matcher, conditional, status}
        const walk = (m) => {
          if (isExpectCall(m)) {
            const arg = m.arguments[0];
            const argText = arg ? arg.getText() : '';
            asserts.push({
              matcher: matcherOf(m),
              conditional: isConditional(m, fn),
              status: /\.(status|statusCode)$/.test(argText) || /^(res|r|resp|response)\w*\.status$/.test(argText),
            });
          } else if (ts.isCallExpression(m)) {
            const e = m.expression;
            const name = ts.isIdentifier(e) ? e.text
              : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) ? `${e.expression.text}.${e.name.text}` : '';
            const head = name.split('.')[0];
            const member = ts.isPropertyAccessExpression(e) ? e.name.text : name;
            if (head === 'assert' || assertFns.has(head) || (head !== 'expect' && ASSERT_NAME_RE.test(head))) {
              asserts.push({ matcher: `helper:${name}`, conditional: isConditional(m, fn), status: false });
            } else if (QUERY_RE.test(member)) {
              // Testing Library getBy*/findBy* THROW when nothing matches: an implicit presence assertion.
              asserts.push({ matcher: `query:${member}`, conditional: isConditional(m, fn), status: false });
            }
          } else if (ts.isThrowStatement(m)) {
            asserts.push({ matcher: 'throw', conditional: true, status: false });
          }
          ts.forEachChild(m, walk);
        };
        walk(fn.body);
        const real = asserts.filter((a) => a.matcher !== 'throw');
        if (real.length === 0) c.flags.push('NO_ASSERT');
        else {
          if (real.every((a) => a.conditional)) c.flags.push('CONDITIONAL');
          const plain = real.filter((a) => !a.matcher.startsWith('helper:') && !a.matcher.startsWith('query:'));
          if (plain.length === real.length) {
            if (plain.every((a) => WEAK.has(a.matcher))) c.flags.push('WEAK_ONLY');
            if (plain.every((a) => a.status)) c.flags.push('STATUS_ONLY');
            if (plain.every((a) => MOCK.has(a.matcher) || MOCK.has(a.matcher.replace(/^not\./, '')))) c.flags.push('MOCK_ONLY');
            if (plain.every((a) => SNAP.has(a.matcher))) c.flags.push('SNAPSHOT_ONLY');
          }
        }
        c.assertions = real.length;
        // Identical text over DIFFERENT file-level bindings (a per-pack PACK
        // constant) is not redundancy (calibration: users- vs orgs-node-replay):
        // fold the initializers of referenced top-level consts into the hash.
        const used = new Set();
        const collect = (m) => { if (ts.isIdentifier(m)) used.add(m.text); ts.forEachChild(m, collect); };
        collect(fn.body);
        const bound = [...used].filter((id) => topLevel.has(id)).sort().map((id) => `${id}=${topLevel.get(id)}`).join(';');
        const norm = normalise(fn.body.getText()) + '|' + normalise(bound);
        if (norm.length > 120) {
          // Hash per LANE: the same body in backend and frontend proves each lane
          // separately (calibration: the two clockshift-armed witnesses).
          const laneKey = file.startsWith('backend/') ? 'backend' : file.includes('/e2e/') ? 'e2e' : file.startsWith('frontend/') ? 'frontend' : 'other';
          const h = createHash('sha1').update(laneKey + '\0' + norm).digest('hex');
          c.hash = h;
          if (!bodyIndex.has(h)) bodyIndex.set(h, []);
          bodyIndex.get(h).push({ file, title: c.title, line: c.line });
        }
      }
      cases.push(c);
      return; // do not descend into a case looking for nested cases
    }
    const gated = isGatedCall(n);
    if (gated) gatedDepth++;
    ts.forEachChild(n, visit);
    if (gated) gatedDepth--;
  };
  visit(sf);

  results.push({
    file,
    lane: file.startsWith('backend/') ? 'backend' : file.includes('/e2e/') ? 'e2e' : file.startsWith('frontend/') ? 'frontend' : 'other',
    cases,
    casts,
    clockUses: fakeTimers ? 0 : clockUses,
    sleeps: fakeTimers ? 0 : sleeps,
    boots,
    headerRef: REF_RE.test(header),
    hasHeader: header.trim().length > 0,
    duration: durations.get(file),
  });
}

// Duplicate bodies (cross-case, possibly cross-file).
for (const r of results) {
  for (const c of r.cases) {
    if (c.hash && bodyIndex.get(c.hash).length > 1) {
      c.flags.push('DUPLICATE_BODY');
      c.duplicates = bodyIndex.get(c.hash).filter((d) => !(d.file === r.file && d.line === c.line)).slice(0, 3);
    }
    delete c.hash;
  }
}

// ---------------------------------------------------------------- ceilings
// Can-it-fail-at-all flags drive D/F ceilings; weak-claim flags (the case CAN
// fail, but asserts less than its claim) cap at C/B — incompleteness is an
// upgrade, never a deletion signal on its own.
const SEVERE = new Set(['NO_ASSERT', 'CONDITIONAL', 'DUPLICATE_BODY']);
const WEAKCLAIM = new Set(['WEAK_ONLY', 'STATUS_ONLY', 'MOCK_ONLY', 'SNAPSHOT_ONLY']);
for (const r of results) {
  const live = r.cases.filter((c) => !c.flags.includes('TODO') && !c.flags.includes('SKIPPED'));
  const severe = live.filter((c) => c.flags.some((f) => SEVERE.has(f)));
  const weak = live.filter((c) => c.flags.some((f) => SEVERE.has(f) || WEAKCLAIM.has(f)));
  const skipped = r.cases.length - live.length;
  const reasons = [];
  let ceiling = 'A';
  const cap = (g, why) => { if (g > ceiling) ceiling = g; reasons.push(why); }; // 'B' > 'A' lexically
  if (r.cases.length === 0) cap('F', 'no test cases');
  else if (live.length === 0) cap('F', 'every case skipped/todo');
  else if (live.every((c) => c.flags.includes('NO_ASSERT'))) cap('F', 'no case asserts anything');
  else if (severe.length === live.length) cap('D', 'every live case has a can-it-fail flag');
  else if (severe.length / live.length >= 0.3) cap('C', `${severe.length}/${live.length} cases may be unable to fail`);
  else if (weak.length === live.length) cap('C', 'every live case asserts less than a full claim');
  else if (weak.length > 0) cap('B', `${weak.length}/${live.length} cases flagged`);
  if (skipped > 0) cap('C', `${skipped} skipped/todo`);
  if (r.cases.some((c) => c.flags.includes('ONLY'))) cap('C', '.only hides the rest of the file');
  if (r.casts > 0) cap('B', `${r.casts} laundering cast(s)`);
  // A fixed sleep is a race by construction: cap. A wall-clock read is only a
  // RISK — relative-time use (JWT iat/exp) is fine — and the clock-shift lane
  // (OPENWOP_CI_CLOCKSHIFT=1) is the measurement, so it is a note for Tier 2,
  // not a cap (calibration: 13 wave-1 files read the clock and all passed it).
  if (r.sleeps > 0) cap('B', `${r.sleeps} fixed sleep(s) without fake timers`);
  if (r.clockUses > 0) reasons.push(`note: ${r.clockUses} wall-clock/random read(s) — verify under OPENWOP_CI_CLOCKSHIFT=1`);
  if (!r.headerRef) cap('B', r.hasHeader ? 'header names no ADR/RFC/gap id' : 'no header');
  r.ceiling = ceiling;
  r.ceilingReasons = reasons;
}

// ---------------------------------------------------------------- output
const allCases = results.flatMap((r) => r.cases);
const flagCounts = {};
for (const c of allCases) for (const f of c.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
const ceilingCounts = {};
for (const r of results) ceilingCounts[r.ceiling] = (ceilingCounts[r.ceiling] ?? 0) + 1;
const byLane = {};
for (const r of results) {
  byLane[r.lane] ??= { files: 0, cases: 0 };
  byLane[r.lane].files++;
  byLane[r.lane].cases += r.cases.length;
}
const summary = {
  generatedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  files: results.length,
  cases: allCases.length,
  byLane,
  flagCounts,
  ceilingCounts,
  filesWithCasts: results.filter((r) => r.casts > 0).length,
  filesWithSleeps: results.filter((r) => r.sleeps > 0).length,
  filesReadingClock: results.filter((r) => r.clockUses > 0).length,
  filesBootingApp: results.filter((r) => r.boots > 0).length,
  filesWithoutHeaderRef: results.filter((r) => !r.headerRef).length,
};

// The committed ledger (--json) keeps only what a grader acts on: every file's
// ceiling + reasons, and the flagged cases. The full per-case dump (~5 MB) is
// --full-json, for local analysis only.
if (jsonOut) {
  const ledger = results.map((r) => ({
    file: r.file,
    ceiling: r.ceiling,
    cases: r.cases.length,
    reasons: r.ceilingReasons,
    ...(r.duration !== undefined ? { seconds: Number(r.duration.toFixed(1)) } : {}),
    flagged: r.cases.filter((c) => c.flags.length > 0).map((c) => ({
      line: c.line, title: c.title.slice(0, 80), flags: c.flags,
      ...(c.duplicates ? { duplicates: c.duplicates.map((d) => `${d.file}:${d.line}`) } : {}),
    })),
  }));
  writeFileSync(jsonOut, JSON.stringify({ summary, files: ledger }, null, 0).replace(/\},\{"file"/g, '},\n{"file"') + '\n');
}
if (fullJsonOut) writeFileSync(fullJsonOut, JSON.stringify({ summary, files: results }, null, 1));
if (mdOut) {
  const lines = [
    `# Test census — ${summary.commit} (${summary.generatedAt.slice(0, 10)})`,
    '',
    `${summary.files} files · ${summary.cases} cases`,
    '',
    '| Lane | Files | Cases |', '|---|---|---|',
    ...Object.entries(byLane).map(([k, v]) => `| ${k} | ${v.files} | ${v.cases} |`),
    '',
    '| Flag | Cases |', '|---|---|',
    ...Object.entries(flagCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| Ceiling | Files |', '|---|---|',
    ...['A', 'B', 'C', 'D', 'F'].map((g) => `| ${g} | ${ceilingCounts[g] ?? 0} |`),
  ];
  writeFileSync(mdOut, lines.join('\n') + '\n');
}
console.log(JSON.stringify(summary, null, 1));
