#!/usr/bin/env node
// ADR 0880 — self-test for scripts/tracegate.mjs (runs in the gate's self-test lane).
//
// Builds a throwaway git repo shaped like this one, records ONE footprint for a
// test file, then makes one commit per kind of change and asserts the decision.
// Both directions are asserted on purpose: a predictor that always says "run"
// fails the SKIP rows, and one that always says "skip" fails the RUN rows, so
// neither degenerate predictor can pass (the vacuity trap this repo keeps
// rediscovering — see sabotage-probe-vacuity).
import cp, { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const fileURLToPathSafe = () => fileURLToPath(import.meta.url);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-selftest-'));
const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-ledger-'));
process.env.OPENWOP_TRACEGATE_ROOT = repo;
process.env.OPENWOP_TRACEGATE_LEDGER = ledger;
process.env.OPENWOP_TRACEGATE_TEST_LIST = 'backend/typescript/test/x.test.ts';
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const SRC = 'backend/typescript/src/a.ts';
const TEST = 'backend/typescript/test/x.test.ts';

const base = `import { helper } from './b';
export interface Shape { id: string }
export type Id = string;

export const TABLE = ['alpha', 'beta'];
export const OTHER = { unused: true };

export function foo(): number {
  return TABLE.length + helper() + parseInt('0', 10);
}

export function bar(): number {
  return 42;
}

export function baz(): number {
  return TABLE.filter((x) => x === 'zz').length;
}

export const router = { get: (_p: string, h: () => number) => h };
router.get('/hit', () => foo());
router.get('/cold', () => bar());
`;
w(SRC, base);
const bBase = "export function helper(): number { return USED.size; }\nexport const USED = new Set(['x']);\nexport const IDLE = new Set(['y']);\nexport function wrongHelper(): number { return 2; }\nexport function parseInt(_text: string, _radix?: number): number { return 100; }\n";
w('backend/typescript/src/b.ts', bBase);
w(TEST, "import { foo } from '../src/a';\nfoo();\n");
w('backend/typescript/package-lock.json', '{"lockfileVersion":3}\n');
w('data/read.json', '{"x":1}\n');
w('data/unread.json', '{"y":1}\n');
g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'base', '--allow-empty');
g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');

// The tool's own lines ("1 MISS(ES)…") are part of the scenarios here, and in a
// gate log they read exactly like a real miss (slot 56). Only this script's ✓/✗
// lines are shown; set OPENWOP_TRACEGATE_SELFTEST_VERBOSE=1 to see the rest.
const realLog = console.log;
if (!process.env.OPENWOP_TRACEGATE_SELFTEST_VERBOSE) console.log = (...a) => { if (/^\s*[✓✗]|^\n?== tracegate self-test/.test(String(a[0]))) realLog(...a); };
const tg = await import('./tracegate.mjs');
const C1 = tg.head();
const lines = base.split('\n');
const lineOf = (needle) => lines.findIndex((l) => l.includes(needle)) + 1;

// One recorded run: foo, the /hit handler and b.helper executed; bar and /cold did not.
const run = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-run-'));
fs.mkdirSync(path.join(run, 'raw'));
fs.writeFileSync(path.join(run, 'raw', 'x.json'), JSON.stringify({
  v: 1, subprocess: false, testFile: TEST, node: process.version,
  loaded: [SRC, 'backend/typescript/src/b.ts', TEST],
  exec: { [SRC]: [lineOf('export function foo'), lineOf("'/hit'"), lineOf('export function baz')], 'backend/typescript/src/b.ts': [1] },
  unmapped: [], reads: ['data/read.json'],
}));
fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify({
  testResults: [{ name: path.join(repo, TEST), status: 'passed', startTime: 0, endTime: 10, assertionResults: [] }],
}));
tg.ingest({ run });

// Execute the two binding regressions as well as checking the predictor. A
// fabricated footprint alone must not be the evidence that behavior changed.
const ts = createRequire(new URL('../backend/typescript/package.json', import.meta.url))('typescript');
const executeFoo = (source) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-binding-'));
  try {
    for (const [name, text] of [['a', source.replaceAll("'./b'", "'./b.cjs'")], ['b', bBase]]) {
      fs.writeFileSync(path.join(dir, `${name}.cjs`), ts.transpileModule(text, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
    }
    return Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(require(process.argv[1]).foo()))', path.join(dir, 'a.cjs')], { encoding: 'utf8' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const baselineValue = executeFoo(base);
const cases = [
  ['body of a function the test never ran', 'skip', () => w(SRC, base.replace('return 42;', 'return 43;'))],
  ['handler the test never hit', 'skip', () => w(SRC, base.replace("() => bar());", "() => bar() + 1);"))],
  ['constant the test never references', 'skip', () => w(SRC, base.replace('unused: true', 'unused: false'))],
  ['interface (erased by the transform)', 'skip', () => w(SRC, base.replace('id: string', 'id: number'))],
  ['import line only', 'skip', () => w(SRC, base.replace("import { helper } from './b';", "import { helper } from './b';\nimport type { Thing } from './c';"))],
  // The #5359 hole: a value import pulls a module graph into load, which can
  // reorder vi.mock(importOriginal) resolution. Loaded membership alone cannot
  // prove binding or evaluation-order neutrality, so value imports always run.
  ['value import of a module the test never loaded', 'run', () => w(SRC, base.replace("import { helper } from './b';", "import { helper } from './b';\nimport { toModelToolResult } from './c.js';"))],
  ['value re-export of a module the test never loaded', 'run', () => w(SRC, base + "export { toModelToolResult } from './c';\n")],
  ['value import of a module the test already loaded', 'run', () => w(SRC, base.replace("import { helper } from './b';", "import { helper } from './b';\nimport { USED } from './b.js';"))],
  // Both programs remain valid. The first edit is insertion-only, so its old
  // character span is empty. The second adds a new binding over a used global.
  // foo's body is unchanged; b.ts was already loaded in the recorded run.
  ['pure insertion retargets an executed import binding', 'run', () => w(SRC, base.replace('import { helper }', 'import { wrongHelper as helper }')), 4],
  ['new import shadows a global used by an executed function', 'run', () => w(SRC, "import { parseInt } from './b';\n" + base), 103],
  // Removing or re-pointing a value import always runs, even when its old target
  // was loaded: a side-effect module may stop evaluating, or vi.mock may reorder.
  ['value import of an already-loaded module removed', 'run', () => w(SRC, base.replace("import { helper } from './b';\n", ''))],
  ['value import specifier edited between two loaded modules', 'run', () => w(SRC, base.replace("from './b';", "from './a';"))],
  ['type-only declaration removed', 'skip', () => w(SRC, base.replace('export type Id = string;\n', ''))],
  ['a repo file the test never read', 'skip', () => w('data/unread.json', '{"y":2}\n')],
  ['body of a function the test ran', 'run', () => w(SRC, base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 1'))],
  ['handler the test hit', 'run', () => w(SRC, base.replace("() => foo());", "() => foo() * 2);"))],
  ['constant an executed function reads', 'run', () => w(SRC, base.replace("'beta'", "'beta', 'gamma'"))],
  // Regressions from building this: a line shared by an executed function and a
  // callback that never ran, and a new top-level call whose only text is a callback.
  ['executed function, on a line shared with a callback', 'run', () => w(SRC, base.replace(".length;\n}\n\nexport const router", ".length + 1;\n}\n\nexport const router"))],
  ['callback body only, on that shared line', 'skip', () => w(SRC, base.replace("x === 'zz'", "x === 'yy'"))],
  ['top-level statement of a loaded module', 'run', () => w(SRC, base + "router.get('/new', () => 1);\n")],
  ['function in another loaded module the test ran', 'run', () => w('backend/typescript/src/b.ts', 'export function helper(): number { return 2; }\n')],
  // `new Set([...])` is a constant (isPureInit), not a top-level statement.
  ['Set member of a constant the test never references', 'skip', () => w('backend/typescript/src/b.ts', bBase.replace("'y'", "'z'"))],
  ['Set member of a constant an executed function reads', 'run', () => w('backend/typescript/src/b.ts', bBase.replace("'x'", "'w'"))],
  ['a new empty Map cache nothing names yet', 'skip', () => w(SRC, base + 'const cache = new Map<string, number>();\n')],
  // The local binding is a parameter of a function the test never runs, not an
  // import: a value import runs on its own (#5363), which would hide this rule.
  ['a Set built by a LOCALLY bound constructor', 'run', () => w('backend/typescript/src/b.ts', bBase.replace("'y'", "'z'") + 'export function shadow(Set: unknown): unknown { return Set; }\n')],
  ['a repo file the test read', 'run', () => w('data/read.json', '{"x":2}\n')],
  ['the test file itself', 'run', () => w(TEST, "import { foo } from '../src/a';\nfoo();\nfoo();\n")],
  ['a setup file (global input)', 'run', () => w('backend/typescript/test/setup/seam.ts', 'export const x = 1;\n')],
  ['a test file that lives in the setup directory', 'skip', () => w('backend/typescript/test/setup/__tests__/seam.test.ts', 'it.todo(\'x\');\n')],
  ['the lockfile (global input)', 'run', () => w('backend/typescript/package-lock.json', '{"lockfileVersion":3,"x":1}\n')],
];

let fail = 0; let pass = 0;
if (baselineValue !== 3) { fail++; console.log(`  ✗ binding witness baseline — got ${baselineValue}`); }
else { pass++; console.log('  ✓ binding witness baseline executes to 3'); }
for (const [name, want, mutate, expectedValue] of cases) {
  g('checkout', '-q', C1, '--', '.');
  g('checkout', '-q', '--detach', C1);
  mutate();
  if (expectedValue !== undefined) {
    const actual = executeFoo(fs.readFileSync(path.join(repo, SRC), 'utf8'));
    const changed = actual === expectedValue && actual !== baselineValue;
    if (changed) pass++; else fail++;
    console.log(`  ${changed ? '✓' : '✗'} executed binding witness: ${name} — ${baselineValue} -> ${actual} (expected ${expectedValue})`);
  }
  g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', name);
  const d = tg.decide(TEST, tg.head(), process.version, tg.lockHash());
  // ADR 0968 P2: on a footprint with no boot data the shadow verdict must be
  // decide()'s, reason for reason (its non-boot branches are a copy).
  const sd = tg.shadowDecide(TEST, tg.head(), process.version, tg.lockHash());
  if (sd.run !== d.run || (d.run && sd.reason !== d.reason)) { fail++; console.log(`  ✗ boot-shadow parity: ${name} — decide ${d.run}/${d.reason}, shadow ${sd.run}/${sd.reason}`); }
  const got = d.run ? 'run' : 'skip';
  const ok = got === want;
  if (!ok) fail++; else pass++;
  console.log(`  ${ok ? '✓' : '✗'} ${want.toUpperCase().padEnd(4)} ${name}${ok ? '' : `  — got ${got} (${d.reason})`}`);
}
// Unchanged tree: the footprint's own commit must be reusable.
g('checkout', '-q', '--detach', C1);
const same = tg.decide(TEST, C1, process.version, tg.lockHash());
if (same.run) { fail++; console.log(`  ✗ SKIP unchanged commit — got run (${same.reason})`); } else { pass++; console.log('  ✓ SKIP unchanged commit'); }
// A different Node is a different runtime: never reuse across it.
const other = tg.decide(TEST, C1, 'v0.0.0', tg.lockHash());
if (!other.run) { fail++; console.log('  ✗ RUN  different node version — got skip'); } else { pass++; console.log('  ✓ RUN  different node version'); }

// ── v2: composition, enforcement, the entry bar, sync ────────────────────────
const check = (name, cond, detail = '') => { if (!cond) fail++; else pass++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  — ${detail}`}`); };
const commit = (msg) => { g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg); return tg.head(); };
const recordAt = (exec) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-run-'));
  fs.mkdirSync(path.join(r, 'raw'));
  fs.writeFileSync(path.join(r, 'raw', 'x.json'), JSON.stringify({ v: 1, subprocess: false, testFile: TEST, node: process.version, loaded: [SRC, 'backend/typescript/src/b.ts', TEST], exec, unmapped: [], reads: ['data/read.json'] }));
  fs.writeFileSync(path.join(r, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, TEST), status: 'passed', startTime: 0, endTime: 10, assertionResults: [] }] }));
  tg.ingest({ run: r });
  return r;
};
const execAt = (text) => { const ls = text.split('\n'); const at = (n) => ls.findIndex((l) => l.includes(n)) + 1; return { [SRC]: [at('export function foo'), at("'/hit'"), at('export function baz')], 'backend/typescript/src/b.ts': [1] }; };
// A global input later in Git's path order already invalidates the verdict.
// It must not first parse unrelated source edits to reach that same decision.
{
  g('checkout', '-q', '--detach', C1);
  w(SRC, base.replace('return 42;', 'return 43;'));
  w('scripts/lib/tracegate-recorder.mjs', '// changed recorder\n');
  const H = commit('global input after an unrelated loaded source edit');
  const original = cp.execFileSync;
  const perFileReads = [];
  let d;
  cp.execFileSync = function (cmd, argv, ...rest) {
    if (cmd === 'git' && (argv.includes('show') || argv.includes('-U0'))) perFileReads.push(argv);
    return original.call(this, cmd, argv, ...rest);
  };
  syncBuiltinESMExports();
  try { d = tg.decide(TEST, H, process.version, tg.lockHash()); }
  finally { cp.execFileSync = original; syncBuiltinESMExports(); }
  check('RUN global input short-circuits per-file Git reads',
    d.run && d.reason === 'global input scripts/lib/tracegate-recorder.mjs' && perFileReads.length === 0,
    `${JSON.stringify(d)}; per-file reads=${perFileReads.length}`);
}

// PR A edits foo (which the test runs); PR B edits bar (which it does not).
g('checkout', '-q', '--detach', C1);
const aText = base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 2');
w(SRC, aText); const A = commit('pr A');
recordAt(execAt(aText)); // the daemon pre-gated A's head
g('checkout', '-q', '--detach', C1);
w(SRC, base.replace('return 42;', 'return 7;')); const B = commit('pr B');
g('checkout', '-q', '--detach', A);
g('-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '--no-edit', B);
const T = tg.head();
const dT = tg.decide(TEST, T, process.version, tg.lockHash());
check('SKIP train A+B: reuses the footprint recorded at A (B touches nothing it ran)', !dT.run && dT.from === A, `${dT.run ? 'run' : 'skip'} (${dT.reason})`);
// Without A's footprint the base footprint alone must say RUN (A changed foo).
const fpDir = path.join(ledger, 'fp', 'backend'); const testHashDir = fs.readdirSync(fpDir)[0];
fs.rmSync(path.join(fpDir, testHashDir, `${A}.json.gz`));
const dT2 = tg.decide(TEST, T, process.version, tg.lockHash());
check('RUN  train A+B without A\'s footprint (the base one is invalidated by A)', dT2.run, dT2.reason);

// Why files run: the gate prints and logs the reasons with per-test detail folded
// away, so a wide selection names the changed FILE that drove it.
check('reasonKey folds the function name, keeping the file', tg.reasonKey('executed function foo@3 in src/a.ts') === 'executed code in src/a.ts');
check('reasonKey folds the constant name, keeping the file', tg.reasonKey('constant MANIFEST in src/b.ts') === 'constant in src/b.ts');
check('reasonKey leaves a reason without per-test detail alone', tg.reasonKey('lockfile changed') === 'lockfile changed');
{
  const head0 = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '--detach', T);
  const wr = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-why-'));
  tg.select({ lane: 'backend', run: wr, mode: 'shadow' });
  const rl = fs.readdirSync(ledger).find((f) => f.startsWith('reasons-'));
  const row = rl ? fs.readFileSync(path.join(ledger, rl), 'utf8').trim().split('\n').pop().split('\t') : [];
  const top = (() => { try { return JSON.parse(row[6]); } catch { return []; } })();
  const want = tg.reasonKey(dT2.reason);
  check('select logs one reasons row per gate, keyed on the folded reason of the file that must run', row[3] === T.slice(0, 12) && top.some(([k, n]) => k === want && n >= 1), `${row.join(' | ')} (want ${want})`);
  fs.rmSync(wr, { recursive: true, force: true });
  g('checkout', '-q', '--detach', head0);
}

// Enforce: an audited reuse that FAILS is a miss — logged, footprint dropped, bar suspended.
g('checkout', '-q', '--detach', C1);
const er = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-run-'));
tg.select({ lane: 'backend', run: er, mode: 'enforce', audit: '1' });
const pred = JSON.parse(fs.readFileSync(path.join(er, 'predict.json'), 'utf8'));
check('enforce + audit 1.0: the reusable file is selected as an AUDIT', pred.decisions[TEST]?.audit === true && fs.readFileSync(path.join(er, 'selected.txt'), 'utf8').includes(TEST), JSON.stringify(pred.decisions[TEST]));
fs.writeFileSync(path.join(er, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, TEST), status: 'failed', startTime: 0, endTime: 5, assertionResults: [] }] }));
tg.report({ lane: 'backend', run: er });
const missLog = fs.readdirSync(ledger).find((f) => f.startsWith('misses-'));
check('the failed audit is logged as a MISS', !!missLog && fs.readFileSync(path.join(ledger, missLog), 'utf8').includes(TEST));
check('...and listed in the run\'s misses.txt, which the gate re-runs alone', (() => { try { return fs.readFileSync(path.join(er, 'misses.txt'), 'utf8').includes(TEST); } catch { return false; } })());
check('...and the footprint that lied is dropped', tg.decide(TEST, C1, process.version, tg.lockHash()).reason === 'no footprint');
check('...and the lane is barred from enforcement', tg.entryBar('backend').recentMiss === true && tg.effectiveMode('backend') === 'shadow');

// A miss triaged as a `hole` keeps the suspension; only a `flake` lifts it.
// The gate's re-run triages with --head <first 12 of HEAD>; that key must match the ledger's.
tg.triage({ lane: 'backend', file: TEST, verdict: 'hole', head: C1.slice(0, 12) });
check('a miss triaged as a HOLE still suspends enforcement', tg.entryBar('backend').recentMiss === true);
tg.triage({ lane: 'backend', file: TEST, verdict: 'flake', head: C1.slice(0, 12) });
check('a miss triaged as a FLAKE no longer counts against the entry bar', tg.entryBar('backend').recentMiss === false);
// A file the prediction said to RUN that fails is not a miss, but its footprints
// must go too: they may be reused again on a later tree that reverts the change.
// (Back-ported from tracegate-ci, where removing report()'s failed-file drop
// stayed green: the miss path and ingest drop the same footprints.)
{
  recordAt(execAt(base));
  w(SRC, base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 3')); commit('an edit the test ran');
  const fr = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-run-'));
  tg.select({ lane: 'backend', run: fr, mode: 'shadow' });
  fs.writeFileSync(path.join(fr, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, TEST), status: 'failed', startTime: 0, endTime: 5, assertionResults: [] }] }));
  tg.report({ lane: 'backend', run: fr });
  const missed = fs.readFileSync(path.join(fr, 'misses.txt'), 'utf8');
  g('checkout', '-q', '--detach', C1);
  const why = tg.decide(TEST, C1, process.version, tg.lockHash()).reason;
  check('report drops the footprints of a failed file that was predicted to run (not a miss)', missed === '' && why === 'no footprint', `misses.txt=${JSON.stringify(missed)} reason=${why}`);
  fs.rmSync(fr, { recursive: true, force: true });
}
// Footprints older than MAX_AGE_HOURS are never reused (the clock is not an observed input).
recordAt(execAt(base));
const fpFile = fs.readdirSync(path.join(ledger, 'fp', 'backend', fs.readdirSync(path.join(ledger, 'fp', 'backend'))[0])).map((f) => path.join(ledger, 'fp', 'backend', fs.readdirSync(path.join(ledger, 'fp', 'backend'))[0], f))[0];
const zz = await import('node:zlib');
const old = JSON.parse(zz.gunzipSync(fs.readFileSync(fpFile)).toString()); old.recordedAt = new Date(Date.now() - (tg.MAX_AGE_HOURS + 1) * 3_600_000).toISOString();
fs.writeFileSync(fpFile, zz.gzipSync(JSON.stringify(old)));
const aged = tg.decide(TEST, C1, process.version, tg.lockHash());
check(`RUN  a footprint older than ${tg.MAX_AGE_HOURS} h, even on an unchanged tree`, aged.run && /older than/.test(aged.reason), aged.reason);

// The ingest budget: past it, nothing more is recorded (never a partial footprint).
{
  g('checkout', '-q', '--detach', C1);
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-run-'));
  fs.mkdirSync(path.join(r, 'raw'));
  fs.writeFileSync(path.join(r, 'raw', 'x.json'), JSON.stringify({ v: 1, subprocess: false, testFile: TEST, node: process.version, loaded: [SRC], exec: { [SRC]: [1] }, unmapped: [], reads: [] }));
  fs.writeFileSync(path.join(r, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, TEST), status: 'passed', startTime: 0, endTime: 1, assertionResults: [] }] }));
  const fpd = path.join(ledger, 'fp', 'backend'); fs.rmSync(fpd, { recursive: true, force: true });
  tg.ingest({ run: r, 'budget-s': '-1' });
  check('ingest past its time budget records nothing (no partial footprint)', !fs.existsSync(fpd) || fs.readdirSync(fpd).length === 0);
  fs.rmSync(r, { recursive: true, force: true });
}

// Projected read (frontend): every test reads the live-fetch allowlist, but only
// "is THIS file listed?" can change it. Another file's line must not re-run it.
{
  const FT = 'frontend/react/src/y.test.ts', AL = 'frontend/react/test-live-fetch-allowlist.txt';
  g('checkout', '-q', '--detach', C1);
  w(FT, 'export {};\n'); w('frontend/react/package-lock.json', '{"lockfileVersion":3}\n');
  w(AL, '# header\nsrc/other.test.ts\n');
  const F0 = commit('frontend base');
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-run-'));
  fs.mkdirSync(path.join(r, 'raw'));
  fs.writeFileSync(path.join(r, 'raw', 'y.json'), JSON.stringify({ v: 1, subprocess: false, testFile: FT, node: process.version, loaded: [FT], exec: {}, unmapped: [], reads: [AL] }));
  fs.writeFileSync(path.join(r, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, FT), status: 'passed', startTime: 0, endTime: 10, assertionResults: [] }] }));
  tg.ingest({ run: r, lane: 'frontend' });
  const flock = tg.lockHash(tg.LANES.frontend);
  w(AL, '# header\nsrc/other.test.ts\nsrc/third.test.ts  # reason\n'); const F1 = commit('another file listed');
  const d1 = tg.decide(FT, F1, process.version, flock, 'frontend');
  check('SKIP projected read: the allowlist gained ANOTHER file', !d1.run, d1.reason);
  g('checkout', '-q', '--detach', F0);
  w(AL, '# header\nsrc/other.test.ts\nsrc/y.test.ts\n'); const F2 = commit('this file listed');
  const d2 = tg.decide(FT, F2, process.version, flock, 'frontend');
  check('RUN  projected read: the allowlist gained THIS file', d2.run && /projected/.test(d2.reason), d2.reason);
  g('checkout', '-q', '--detach', F0);
  w(AL, '# header\nsrc/y.test.ts  # now with a reason\nsrc/other.test.ts\n'); const F3 = commit('this file listed with a comment');
  const d3 = tg.decide(FT, F3, process.version, flock, 'frontend');
  check('RUN  projected read: "path  # reason" still counts as listed', d3.run, d3.reason);
  fs.rmSync(r, { recursive: true, force: true });
}

// Entry bar: ≥ 20 observations over ≥ 14 days and no recent miss.
fs.rmSync(path.join(ledger, missLog));
const shadow = fs.readdirSync(ledger).find((f) => f.startsWith('shadow-'));
const rows = Array.from({ length: 20 }, (_, i) => [new Date(Date.now() - (15 - i * 0.7) * 86_400_000).toISOString(), 'backend', 'shadow', 'x', 10, 1, 9, 0, '10.0', 0].join('\t'));
fs.writeFileSync(path.join(ledger, shadow), 'at\tlane\tmode\thead\tfiles\tmust_run\treusable\taudited\trun_time_pct\tmisses\n' + rows.join('\n') + '\n');
const prevMode = process.env.OPENWOP_TRACEGATE; delete process.env.OPENWOP_TRACEGATE;
// A recent complete full run, so these entry-bar cases see the bar, not the backstop.
const fullLog = path.join(ledger, 'full-selftest.tsv');
const fullRow = (laneName, hoursAgo) => [new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), laneName, 'x'].join('\t');
fs.writeFileSync(fullLog, 'at\tlane\thead\n' + [fullRow('backend', 1), fullRow('frontend', 1)].join('\n') + '\n');
check('entry bar MET after 20 clean observations over 15 days → auto = enforce', tg.entryBar('backend').ok && tg.effectiveMode('backend') === 'enforce', JSON.stringify(tg.entryBar('backend')));
check('...and a lane past the default 14-day bar audits at the normal 5%', tg.entryBar('backend').auditRate === 0.05, JSON.stringify(tg.entryBar('backend')));
// The same record with an un-triaged miss from an hour ago: suspended, whatever
// the bar. (Back-ported from tracegate-ci: the "barred" check above holds even
// without the !recentMiss rule, because that lane had not met the bar anyway.)
{
  const ml = path.join(ledger, 'misses-zz-backport.tsv');
  fs.writeFileSync(ml, 'at\tlane\thead\tfile\treason\n' + [new Date(Date.now() - 3_600_000).toISOString(), 'backend', 'deadbeef0000', TEST, 'x'].join('\t') + '\n');
  check('...but a recent un-triaged MISS suspends a lane that otherwise meets the bar', !tg.entryBar('backend').ok && tg.effectiveMode('backend') === 'shadow', JSON.stringify(tg.entryBar('backend')));
  fs.rmSync(ml);
}
fs.writeFileSync(path.join(ledger, shadow), 'at\tlane\tmode\thead\tfiles\tmust_run\treusable\taudited\trun_time_pct\tmisses\n' + rows.slice(-10).join('\n') + '\n');
check('entry bar NOT met with 10 observations → auto = shadow', !tg.entryBar('backend').ok && tg.effectiveMode('backend') === 'shadow');
// Early entry (both lanes; frontend since ADR 0918): 20 clean observations over 2 days.
const early = (laneName) => Array.from({ length: 20 }, (_, i) => [new Date(Date.now() - (2 - i * 0.09) * 86_400_000).toISOString(), laneName, 'shadow', 'x', 10, 1, 9, 0, '10.0', 0].join('\t'));
fs.writeFileSync(path.join(ledger, shadow), 'at\tlane\tmode\thead\tfiles\tmust_run\treusable\taudited\trun_time_pct\tmisses\n' + [...early('backend'), ...early('frontend')].join('\n') + '\n');
check('backend enters EARLY: 20 clean observations over 2 days → enforce', tg.entryBar('backend').ok && tg.effectiveMode('backend') === 'enforce', JSON.stringify(tg.entryBar('backend')));
check('...auditing 20% until the 14-day bar would have been met', tg.entryBar('backend').auditRate === 0.2);
check('frontend enters EARLY on the same record, auditing 20% (ADR 0918)', tg.entryBar('frontend').ok && tg.effectiveMode('frontend') === 'enforce' && tg.entryBar('frontend').auditRate === 0.2, JSON.stringify(tg.entryBar('frontend')));
// ...but not before the 1-day floor: 20 clean observations inside 12 hours.
const sameDay = (laneName) => Array.from({ length: 20 }, (_, i) => [new Date(Date.now() - (0.5 - i * 0.02) * 86_400_000).toISOString(), laneName, 'shadow', 'x', 10, 1, 9, 0, '10.0', 0].join('\t'));
fs.writeFileSync(path.join(ledger, shadow), 'at\tlane\tmode\thead\tfiles\tmust_run\treusable\taudited\trun_time_pct\tmisses\n' + [...early('backend'), ...sameDay('frontend')].join('\n') + '\n');
check('frontend does NOT enter on 20 observations inside 12 hours (the 1-day floor)', !tg.entryBar('frontend').ok && tg.effectiveMode('frontend') === 'shadow', JSON.stringify(tg.entryBar('frontend')));
// Full-run backstop: an enforce-eligible lane runs FULL when its last complete
// full run is ≥ 24 h old, or was never recorded — and enforces again once one is.
fs.writeFileSync(fullLog, 'at\tlane\thead\n' + fullRow('backend', 31) + '\n');
const dOld = tg.modeDecision('backend');
check('backstop: last full run 31h ago → this gate runs FULL (shadow), and says why', dOld.mode === 'shadow' && dOld.full && /31h ago/.test(dOld.why), JSON.stringify(dOld));
fs.writeFileSync(fullLog, 'at\tlane\thead\n');
check('backstop: no full run ever recorded → FULL', tg.modeDecision('backend').full === true && /never recorded/.test(tg.modeDecision('backend').why));
tg.fullDone({ lane: 'backend' });
check('backstop: full-done records one → enforce again', tg.effectiveMode('backend') === 'enforce', JSON.stringify(tg.modeDecision('backend')));
process.env.OPENWOP_TRACEGATE = 'enforce'; fs.writeFileSync(fullLog, 'at\tlane\thead\n');
check('backstop: an explicit OPENWOP_TRACEGATE=enforce still wins', tg.effectiveMode('backend') === 'enforce');
delete process.env.OPENWOP_TRACEGATE;
for (const f of fs.readdirSync(ledger).filter((n) => n.startsWith('full-'))) fs.rmSync(path.join(ledger, f));
if (prevMode !== undefined) process.env.OPENWOP_TRACEGATE = prevMode;

// ── i18n: a catalog edit invalidates only the tests that looked the key up ───
{
  g('checkout', '-q', '--detach', C1);
  const FE = 'frontend/react/src/features/csm';
  const TABLE = `${FE}/i18n/en.ts`;
  const enBase = `/** csm copy */
export const messages = {
  title: 'CSM',
  table: { colA: 'A', colB: 'B' },
  later: 'L',
  pseudoKey: 'P',
} as const;
`;
  w(TABLE, enBase);
  w('frontend/react/src/i18n/resources.ts', "const mods = import.meta.glob('../features/*/i18n/en.ts', { eager: true });\nexport const all = Object.values(mods).map((m) => (m as { messages: unknown }).messages);\n");
  w(`${FE}/Page.tsx`, 'export function Page(): number { return 1; }\n');
  w(`${FE}/direct.ts`, "import { messages } from './i18n/en.js';\nexport function title(): string { return messages.title; }\n");
  const T = (n) => `${FE}/__tests__/${n}.test.tsx`;
  const tests = {
    keys: { imp: '../Page.js', i18n: { keys: ['en\0csm\0title', 'en\0csm\0later', 'en-XA\0csm\0pseudoKey'], whole: [] } },
    direct: { imp: '../direct.js', i18n: { keys: ['en\0csm\0title'], whole: [] } },
    whole: { imp: '../Page.js', i18n: { keys: [], whole: ['en\0csm'] } },
    unrecorded: { imp: '../Page.js', i18n: undefined },
    aggregator: { imp: '../../../i18n/resources.js', i18n: { keys: [], whole: [] } },
  };
  for (const [n, t] of Object.entries(tests)) w(T(n), `import '${t.imp}';\n`);
  const CF = commit('frontend i18n fixture');
  const fr = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-run-'));
  fs.mkdirSync(path.join(fr, 'raw'));
  for (const [n, t] of Object.entries(tests)) {
    const extra = t.imp === '../direct.js' ? [`${FE}/direct.ts`] : t.imp.includes('resources') ? [] : [`${FE}/Page.tsx`];
    fs.writeFileSync(path.join(fr, 'raw', `${n}.json`), JSON.stringify({
      v: 2, subprocess: false, testFile: T(n), node: process.version, loaded: [TABLE, 'frontend/react/src/i18n/resources.ts', ...extra, T(n)].sort(),
      exec: { [TABLE]: [], 'frontend/react/src/i18n/resources.ts': [], ...Object.fromEntries(extra.map((f) => [f, [1]])) }, unmapped: [], reads: [],
      ...(t.i18n ? { i18n: t.i18n } : {}),
    }));
  }
  fs.writeFileSync(path.join(fr, 'results.json'), JSON.stringify({ testResults: Object.keys(tests).map((n) => ({ name: path.join(repo, T(n)), status: 'passed', startTime: 0, endTime: 10, assertionResults: [] })) }));
  tg.ingest({ run: fr, lane: 'frontend' });
  const flock = tg.lockHash(tg.LANES.frontend);
  const decideAll = () => Object.fromEntries(Object.keys(tests).map((n) => [n, tg.decide(T(n), tg.head(), process.version, flock, 'frontend')]));
  // [name, edit to the table, expected run/skip per test]
  const fcases = [
    ['a key nobody looked up', (x) => x.replace("colB: 'B'", "colB: 'Bee'"), { keys: 'skip', direct: 'run', whole: 'run', unrecorded: 'run', aggregator: 'run' }],
    ['a key the test looked up', (x) => x.replace("title: 'CSM'", "title: 'Customer success'"), { keys: 'run', whole: 'run' }],
    ['a key read through the pseudo-locale (derived from en)', (x) => x.replace("pseudoKey: 'P'", "pseudoKey: 'Q'"), { keys: 'run' }],
    ['a comment inside the table', (x) => x.replace("  later: 'L',", "  // copy note\n  later: 'L',"), { keys: 'skip', whole: 'skip' }],
    ['a NEW key nobody looked up', (x) => x.replace("  later: 'L',", "  later: 'L',\n  fresh: 'F',"), { keys: 'skip', whole: 'run' }],
    ['a removed key the test looked up', (x) => x.replace("  later: 'L',\n", ''), { keys: 'run' }],
    ['a spread (not plain data → constant rule)', (x) => x.replace("  later: 'L',", "  ...{ later: 'L' },"), { keys: 'run' }],
  ];
  for (const [name, edit, want] of fcases) {
    g('checkout', '-q', '--detach', CF);
    w(TABLE, edit(enBase)); commit(`i18n: ${name}`);
    const got = decideAll();
    for (const [n, exp] of Object.entries(want)) {
      const d = got[n];
      check(`i18n ${exp.toUpperCase().padEnd(4)} ${name} — ${n} test`, (d.run ? 'run' : 'skip') === exp, `${d.run ? 'run' : 'skip'} (${d.reason})`);
    }
  }
  fs.rmSync(fr, { recursive: true, force: true });
}

// Replay (ADR 0968 P1): a past gate re-decided offline, with causes removed.
{
  g('checkout', '-q', '--detach', C1);
  // A fresh footprint at C1 (earlier sections dropped or superseded TEST's).
  const rr = recordAt({ [SRC]: [lineOf('export function foo')], 'backend/typescript/src/b.ts': [1] });
  fs.rmSync(rr, { recursive: true, force: true });
  w('backend/typescript/package-lock.json', '{"lockfileVersion":3,"replay":1}\n');
  w(SRC, base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 7'));
  const RH = commit('replay: a lockfile bump and an edit the test ran');
  const now = new Date().toISOString();
  const live = tg.decide(TEST, RH, process.version, tg.lockHash());
  const r0 = tg.replay({ lane: 'backend', head: RH, at: now });
  check('replay reproduces decide() at the same head and clock', live.reason === 'lockfile changed' && r0.mustRun === 1 && r0.top[0]?.[0] === 'lockfile changed', JSON.stringify({ live, r0: r0.top }));
  const r1 = tg.replay({ lane: 'backend', head: RH, at: now, 'ignore-lock': true, drop: 'package-lock\\.json$' });
  check('replay without the lockfile still RUNS for the edit the test ran', r1.mustRun === 1 && (r1.top[0]?.[0] ?? '') === 'executed code in backend/typescript/src/a.ts', JSON.stringify(r1.top));
  const r2 = tg.replay({ lane: 'backend', head: RH, at: now, 'ignore-lock': true, drop: '(package-lock\\.json|src/a\\.ts)$' });
  check('replay with both causes removed SKIPS', r2.mustRun === 0, JSON.stringify(r2.top));
  const r3 = tg.replay({ lane: 'backend', head: RH, at: '2000-01-01T00:00:00Z' });
  check('replay before any footprint existed sees none, and counts it as replaced', r3.mustRun === 1 && r3.top[0]?.[0] === 'no footprint' && r3.evicted === 1, JSON.stringify(r3));
  const after = tg.decide(TEST, RH, process.version, tg.lockHash());
  check('replay leaves the live decision untouched', after.run === live.run && after.reason === live.reason, JSON.stringify({ live, after }));
}

// Boot shadow (ADR 0968 P2): a change seen ONLY through app boot is absorbed when
// the boot digest is unchanged, never when the test phase also used it.
{
  const digestOf = (ds) => crypto.createHash('sha256').update(ds.join('\n')).digest('hex').slice(0, 32);
  const bootRun = (boot, status = 'passed') => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-run-'));
    fs.mkdirSync(path.join(r, 'raw'));
    fs.writeFileSync(path.join(r, 'raw', 'x.json'), JSON.stringify({
      v: 1, subprocess: false, testFile: TEST, node: process.version, loaded: [SRC, 'backend/typescript/src/b.ts', TEST],
      exec: { [SRC]: [lineOf('export function foo'), lineOf("'/hit'")], 'backend/typescript/src/b.ts': [1] },
      unmapped: [], reads: ['data/read.json'], boot,
    }));
    fs.writeFileSync(path.join(r, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, TEST), status, startTime: 0, endTime: 10, assertionResults: [] }] }));
    tg.ingest({ run: r });
    fs.rmSync(r, { recursive: true, force: true });
  };
  // Boot ran the /hit handler and read data/read.json; the test body ran foo and b.helper.
  const boot = (d) => ({ n: 1, exec: { [SRC]: [lineOf("'/hit'")] }, testExec: { [SRC]: [lineOf('export function foo')], 'backend/typescript/src/b.ts': [1] }, reads: ['data/read.json'], testReads: [], digests: [d] });
  g('checkout', '-q', '--detach', C1);
  bootRun(boot('D1'));
  const at = (name, mutate) => { g('checkout', '-q', '--detach', C1); mutate(); return commit(`boot shadow: ${name}`); };
  const sh = (H, d) => tg.shadowDecide(TEST, H, process.version, tg.lockHash(), 'backend', d);
  const HB = at('a handler only boot ran', () => w(SRC, base.replace("() => foo());", "() => foo() * 3);")));
  check('boot shadow: decide() still RUNS a handler edit', tg.decide(TEST, HB, process.version, tg.lockHash()).run);
  check('boot shadow SKIPS a boot-only handler edit when the boot digest is unchanged', !sh(HB, digestOf(['D1'])).run, JSON.stringify(sh(HB, digestOf(['D1']))));
  check('boot shadow RUNS it when the boot outcome changed', /boot outcome changed/.test(sh(HB, digestOf(['D2'])).reason ?? ''), JSON.stringify(sh(HB, digestOf(['D2']))));
  check('boot shadow RUNS it with no digest to compare', /no boot digest/.test(sh(HB, null).reason ?? ''), JSON.stringify(sh(HB, null)));
  const HF = at('a function the test body ran', () => w(SRC, base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 2')));
  check('boot shadow RUNS an edit the test phase ran, digest or not', sh(HF, digestOf(['D1'])).run && /executed function/.test(sh(HF, digestOf(['D1'])).reason), JSON.stringify(sh(HF, digestOf(['D1']))));
  const HR = at('a file only boot read', () => w('data/read.json', '{"x":9}\n'));
  check('boot shadow SKIPS a boot-only read when the digest is unchanged', !sh(HR, digestOf(['D1'])).run, JSON.stringify(sh(HR, digestOf(['D1']))));
  // End to end through ingest: the shadow row, and a would-skip that FAILED.
  const rows = () => fs.readFileSync(path.join(ledger, fs.readdirSync(ledger).find((f) => f.startsWith('boot-shadow-'))), 'utf8').trim().split('\n').map((l) => l.split('\t'));
  g('checkout', '-q', '--detach', HB);
  bootRun(boot('D1'));
  let last = rows().at(-1);
  check('ingest logs a would-skip for a boot-only change with an unchanged digest', last[7] === '1' && last[8] === '0', last.join(' | '));
  bootRun(boot('D2'));
  last = rows().at(-1);
  check('ingest logs no would-skip when the boot outcome changed', last[7] === '0' && last[6] === '1', last.join(' | '));
  bootRun(boot('D1'), 'failed');
  last = rows().at(-1);
  check('ingest logs a would-skip that FAILED (the soundness signal)', last[8] === '1' && last[11].includes('x.test.ts'), last.join(' | '));
  // ADR 0968 correction (2026-10-27): the IMPORT window. This app's features register
  // as their modules evaluate, before createApp's first mark. Filed as test phase, that
  // made every feature module test-used and absorbed nothing in a week (0 of 2,752).
  // App source evaluated on import is now boot; a footprint without the window keeps
  // the old reading. Legacy first: footprints accumulate, and a skip needs only one.
  const HT = at('a new top-level statement in a feature module', () => w(SRC, base + "router.get('/new', () => 1);\n"));
  g('checkout', '-q', '--detach', C1);
  bootRun({ n: 1, exec: { [SRC]: [lineOf("'/hit'")] }, testExec: { [SRC]: [lineOf('export function foo')], 'backend/typescript/src/b.ts': [1] }, reads: [], testReads: [], digests: ['D1'] });
  check('boot shadow (old reading, no import window): a top-level change in a module the test phase evaluated RUNS', /top-level change/.test(sh(HT, digestOf(['D1'])).reason ?? ''), JSON.stringify(sh(HT, digestOf(['D1']))));
  // The constant rule: TABLE is named by foo. While foo ran in the TEST PHASE (every
  // footprint so far), a TABLE edit must run; only an import-only foo lets it absorb.
  const HK = at('a constant a test-phase function names', () => w(SRC, base.replace("['alpha', 'beta']", "['alpha', 'beta', 'gamma']")));
  check('boot shadow RUNS a constant that a function the test phase ran names (digest unchanged)', /constant TABLE/.test(sh(HK, digestOf(['D1'])).reason ?? ''), JSON.stringify(sh(HK, digestOf(['D1']))));
  bootRun({ n: 1, exec: { [SRC]: [lineOf("'/hit'")] }, testExec: { 'backend/typescript/src/b.ts': [1] }, impExec: { [SRC]: [lineOf('export function foo')] }, impReads: [], reads: [], testReads: [], digests: ['D1'] });
  check('boot shadow: app source evaluated on IMPORT is boot — its top-level change is absorbed when the digest is unchanged', !sh(HT, digestOf(['D1'])).run, JSON.stringify(sh(HT, digestOf(['D1']))));
  check('...and still RUNS when the boot outcome changed', /boot outcome changed/.test(sh(HT, digestOf(['D2'])).reason ?? ''), JSON.stringify(sh(HT, digestOf(['D2']))));
  check('...and that constant is absorbed once the function naming it ran only on IMPORT', !sh(HK, digestOf(['D1'])).run, JSON.stringify(sh(HK, digestOf(['D1']))));
}

// Sync (P4): two ledgers become their union; each keeps its own log name.
const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-other-'));
fs.mkdirSync(path.join(peer, 'blobs')); fs.writeFileSync(path.join(peer, 'blobs', 'feedface.json.gz'), 'x');
fs.writeFileSync(path.join(peer, 'shadow-othermac.tsv'), 'at\tlane\n');
tg.sync({ remote: peer });
check('sync pulls the other machine\'s blobs and log', fs.existsSync(path.join(ledger, 'blobs', 'feedface.json.gz')) && fs.existsSync(path.join(ledger, 'shadow-othermac.tsv')));
check('sync pushes ours to it', fs.readdirSync(path.join(peer, 'blobs')).length > 1 && fs.readdirSync(peer).some((f) => f.startsWith('shadow-') && f !== 'shadow-othermac.tsv'));
fs.rmSync(peer, { recursive: true, force: true });


// A real recorder + subprocess, not a hand-labelled footprint: git history can
// change on an EMPTY commit. Also preserve promisify(execFile)'s stdout/stderr
// shape and reset the marker before the next, filesystem-only test file.
{
  const GT = 'backend/typescript/test/history.test.ts';
  const AT = 'backend/typescript/test/async-history.test.ts';
  const NT = 'backend/typescript/test/fs-only.test.ts';
  const LT = 'backend/typescript/test/legacy-history.test.ts';
  for (const file of [GT, AT, LT]) w(file, "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['log', '--format=%s']);\n");
  w(NT, "import { readFileSync } from 'node:fs';\nreadFileSync('data/read.json', 'utf8');\n");
  const H = commit('record subprocess fixtures');
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-recorder-probe-'));
  const out = path.join(probeDir, 'run'); fs.mkdirSync(out);
  const recorder = new URL('./lib/tracegate-recorder.mjs', import.meta.url).href;
  const probe = `import fs from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installRecorder } from ${JSON.stringify(recorder)};
const [repoRoot, outDir] = process.argv.slice(2);
process.env.OPENWOP_TRACEGATE_RECORD = outDir;
let finish;
async function record(file, action) {
  await installRecorder({ afterAll: (fn) => { finish = fn; }, expect: { getState: () => ({ testPath: repoRoot + '/' + file }) }, repoRoot, laneDir: 'backend/typescript' });
  const result = await action(); await finish(); return result;
}
const args = ['-C', repoRoot, 'log', '--format=%s'];
const sync = await record(${JSON.stringify(GT)}, () => execFileSync('git', args, { encoding: 'utf8' }));
const asyncResult = await record(${JSON.stringify(AT)}, () => promisify(execFile)('git', args, { encoding: 'utf8' }));
await record(${JSON.stringify(NT)}, () => fs.readFileSync(repoRoot + '/data/read.json', 'utf8'));
fs.writeFileSync(outDir + '/probe-result.json', JSON.stringify({ sync, asyncResult }));
process.exit(0);
`;
  const probeFile = path.join(probeDir, 'probe.mjs'); fs.writeFileSync(probeFile, probe);
  execFileSync(process.execPath, [probeFile, repo, out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = JSON.parse(fs.readFileSync(path.join(out, 'probe-result.json'), 'utf8'));
  const raws = fs.readdirSync(path.join(out, 'raw')).map((f) => JSON.parse(fs.readFileSync(path.join(out, 'raw', f), 'utf8')));
  check('recorder captures a synchronous git-history subprocess', raws.find((r) => r.testFile === GT)?.subprocess === true);
  check('recorder captures promisified execFile without changing stdout/stderr', raws.find((r) => r.testFile === AT)?.subprocess === true && capture.asyncResult.stdout === capture.sync && capture.asyncResult.stderr === '');
  check('recorder resets subprocess state for a filesystem-only test', raws.find((r) => r.testFile === NT)?.subprocess === false);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ testResults: [GT, AT, NT].map((file) => ({ name: path.join(repo, file), status: 'passed', startTime: 0, endTime: 10, assertionResults: [] })) }));
  tg.ingest({ run: out });
  check('opaque subprocess is not reusable even on the SAME head', tg.decide(GT, H, process.version, tg.lockHash()).run);
  check('filesystem-only footprint remains reusable on the same head', !tg.decide(NT, H, process.version, tg.lockHash()).run);
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fix(brand): new implementing subject (ADR 0970)', '--allow-empty');
  const next = tg.head();
  const decision = tg.decide(GT, next, process.version, tg.lockHash());
  check('an empty-tree history commit RUNS the history reader', decision.run && decision.reason === 'opaque subprocess input', JSON.stringify(decision));
  check('boot shadow cannot absorb an opaque subprocess dependency', tg.shadowDecide(GT, next, process.version, tg.lockHash(), 'backend', 'unchanged').run);
  check('an empty-tree history commit still SKIPS the filesystem-only reader', !tg.decide(NT, next, process.version, tg.lockHash()).run);
  // Old raw data lacks proof that no process ran; it must also fail closed.
  fs.writeFileSync(path.join(out, 'raw', 'legacy.json'), JSON.stringify({ v: 1, testFile: LT, node: process.version, loaded: [], exec: {}, unmapped: [], reads: [] }));
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, LT), status: 'passed', startTime: 0, endTime: 10, assertionResults: [] }] }));
  tg.ingest({ run: out });
  check('raw data from an old recorder cannot grant subprocess reuse', tg.decide(LT, next, process.version, tg.lockHash()).run);
  fs.rmSync(probeDir, { recursive: true, force: true });
}

// ADR 0980 P1 — Red Reader packets and escalate-only opinions. Every guarantee
// below is a reason the feature is safe to put in the gate: an opinion can only
// make a lane STRICTER, only for a MISS, only above the confidence floor, never by
// writing a triage row, and a person's later triage has the last word.
{
  const pause = () => new Promise((r) => setTimeout(r, 5)); // distinct ISO timestamps
  const RF = 'backend/typescript/test/red-miss.test.ts', NF = 'backend/typescript/test/red-plain.test.ts';
  const HR = tg.head();
  const host = (process.env.OPENWOP_TRACEGATE_HOST || os.hostname().split('.')[0] || 'host').replace(/[^A-Za-z0-9_-]/g, '_');
  const ml = path.join(ledger, `misses-${host}.tsv`);
  if (!fs.existsSync(ml)) fs.writeFileSync(ml, 'at\tlane\thead\tfile\treason\n');
  fs.appendFileSync(ml, [new Date().toISOString(), 'backend', HR.slice(0, 12), RF, 'green at x, nothing it depends on changed'].join('\t') + '\n');
  const missed = () => tg.entryBar('backend').missesTotal;
  const m0 = missed();
  await pause(); tg.triage({ lane: 'backend', file: RF, verdict: 'flake', head: HR.slice(0, 12) });
  check('red: the recheck FLAKE lifts the miss (baseline)', missed() === m0 - 1, `${m0} → ${missed()}`);
  // A red run dir as the gate leaves it: prediction, report, misses. The failing
  // files exist, as in a real gate: the packet resolves each one's real path, and
  // on macOS the temp dir sits behind /var → /private/var.
  w(RF, 'export {};\n'); w(NF, 'export {};\n');
  // A red run dir as the gate leaves it: prediction, report, misses.
  const rr = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-red-'));
  fs.writeFileSync(path.join(rr, 'predict.json'), JSON.stringify({ head: HR, mode: 'enforce', decisions: { [RF]: { run: false, audit: true, reason: 'green at x' }, [NF]: { run: true, reason: 'changed' } } }));
  fs.writeFileSync(path.join(rr, 'results.json'), JSON.stringify({ testResults: [RF, NF].map((file) => ({ name: path.join(repo, file), status: 'failed', message: '', assertionResults: [{ status: 'failed', fullName: `${file} case`, failureMessages: ['\x1b[31mExpected 1, received 2\x1b[0m'] }] })) }));
  fs.writeFileSync(path.join(rr, 'misses.txt'), `${RF}\n`);
  fs.writeFileSync(path.join(rr, 'rechecks.tsv'), `${RF}\tpassed\n`);
  const pk = await tg.redCmd('write', { lane: 'backend', run: rr, rechecks: path.join(rr, 'rechecks.tsv') });
  const pf = (f) => pk.failed.find((x) => x.file === f);
  check('red: a red run writes a packet naming each failing file', pk.failedCount === 2 && !!pf(RF) && !!pf(NF), JSON.stringify(pk.failed?.map((x) => x.file)));
  check('red: the packet marks the MISS, its recheck, and strips colour codes', pf(RF)?.miss === true && pf(RF)?.recheckAlone === 'passed' && pf(NF)?.miss === false && !/\x1b/.test(pf(RF)?.text ?? 'x'), JSON.stringify(pf(RF)));
  const triageRows = () => fs.readFileSync(path.join(ledger, `triage-${host}.tsv`), 'utf8').trim().split('\n').length;
  const tr0 = triageRows();
  const op = (o) => tg.redCmd('annotate', { verdict: 'real', escalate: 'true', confidence: '0.9', reasons: 'the Received diff is a wrong argument', ...o }, pk.id);
  await pause(); let rec = await op({ confidence: '0.5' });
  check('red: an opinion below the confidence floor escalates nothing', rec.escalated.length === 0 && missed() === m0 - 1);
  await pause(); rec = await op({ verdict: 'flake-suspect' });
  check('red: a non-`real` verdict escalates nothing, even with escalate true', rec.escalated.length === 0 && missed() === m0 - 1);
  await pause(); rec = await op({ escalate: 'false' });
  check('red: escalate false escalates nothing', rec.escalated.length === 0 && missed() === m0 - 1);
  await pause(); rec = await tg.redCmd('annotate', { verdict: 'real', escalate: 'true', confidence: '0.95', reasons: 'real failure' }, pk.id);
  check('red: an escalated `real` opinion raises only the MISS to HOLE, never the plain failure', JSON.stringify(rec.escalated) === JSON.stringify([RF]), JSON.stringify(rec.escalated));
  check('red: ...which re-suspends the lane (the stricter verdict wins)', missed() === m0, `${missed()} vs ${m0}`);
  check('red: an opinion never writes a triage row', triageRows() === tr0, `${tr0} → ${triageRows()}`);
  process.env.OPENWOP_TRACEGATE_RED_ESCALATE = 'off';
  check('red: OPENWOP_TRACEGATE_RED_ESCALATE=off ignores escalations', missed() === m0 - 1);
  delete process.env.OPENWOP_TRACEGATE_RED_ESCALATE;
  await pause(); tg.triage({ lane: 'backend', file: RF, verdict: 'flake', head: HR.slice(0, 12) });
  check("red: a person's LATER flake triage overrides the escalation", missed() === m0 - 1, `${missed()} vs ${m0 - 1}`);
  // The closed world lives in the vendored annotate (the CLI only ever passes known fields).
  const vred = await import('./vendor/tracegate-ci/src/red.mjs');
  let refused = false; try { vred.annotate({ id: pk.id, verdict: 'real', escalate: true, confidence: 0.9, reasons: 'x', triage: 'flake' }); } catch { refused = true; }
  check('red: an opinion with an unknown field (a smuggled "triage") is refused', refused);
  fs.rmSync(rr, { recursive: true, force: true });
  // The gate wires it: each lane passes its rc to tg_end (which keeps a red lane's
  // files from the background ingest's rm) and writes the packet on red.
  const ci = fs.readFileSync(path.join(path.dirname(fileURLToPathSafe()), 'ci.sh'), 'utf8');
  check('red: the gate keeps each red lane\'s files and writes its packet', ['be', 'fe'].every((l) => new RegExp(`tg_end "\\$${l}_rc"`).test(ci))
    && /\{ tg_recheck_misses backend [^}]*tg_red_packet backend;/.test(ci) && /\{ tg_recheck_misses frontend [^}]*tg_red_packet frontend;/.test(ci));
}

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(run, { recursive: true, force: true });
fs.rmSync(ledger, { recursive: true, force: true });
// The count is counted, not computed: it used to be `cases.length + 60`, and read 82 while 85 passed.
realLog(fail ? `\n== tracegate self-test: ${fail} FAILED, ${pass} passed ==` : `\n== tracegate self-test: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
