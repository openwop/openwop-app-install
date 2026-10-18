#!/usr/bin/env node
// ADR 0880 — self-test for scripts/tracegate.mjs (runs in the gate's self-test lane).
//
// Builds a throwaway git repo shaped like this one, records ONE footprint for a
// test file, then makes one commit per kind of change and asserts the decision.
// Both directions are asserted on purpose: a predictor that always says "run"
// fails the SKIP rows, and one that always says "skip" fails the RUN rows, so
// neither degenerate predictor can pass (the vacuity trap this repo keeps
// rediscovering — see sabotage-probe-vacuity).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  return TABLE.length + helper();
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
const bBase = "export function helper(): number { return USED.size; }\nexport const USED = new Set(['x']);\nexport const IDLE = new Set(['y']);\n";
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
  v: 1, testFile: TEST, node: process.version,
  loaded: [SRC, 'backend/typescript/src/b.ts', TEST],
  exec: { [SRC]: [lineOf('export function foo'), lineOf("'/hit'"), lineOf('export function baz')], 'backend/typescript/src/b.ts': [1] },
  unmapped: [], reads: ['data/read.json'],
}));
fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify({
  testResults: [{ name: path.join(repo, TEST), status: 'passed', startTime: 0, endTime: 10, assertionResults: [] }],
}));
tg.ingest({ run });

const cases = [
  ['body of a function the test never ran', 'skip', () => w(SRC, base.replace('return 42;', 'return 43;'))],
  ['handler the test never hit', 'skip', () => w(SRC, base.replace("() => bar());", "() => bar() + 1);"))],
  ['constant the test never references', 'skip', () => w(SRC, base.replace('unused: true', 'unused: false'))],
  ['interface (erased by the transform)', 'skip', () => w(SRC, base.replace('id: string', 'id: number'))],
  ['import line only', 'skip', () => w(SRC, base.replace("import { helper } from './b';", "import { helper } from './b';\nimport type { Thing } from './c';"))],
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
  ['a Set built by a LOCALLY bound constructor', 'run', () => w('backend/typescript/src/b.ts', "import { Set } from './c';\n" + bBase.replace("'y'", "'z'"))],
  ['a repo file the test read', 'run', () => w('data/read.json', '{"x":2}\n')],
  ['the test file itself', 'run', () => w(TEST, "import { foo } from '../src/a';\nfoo();\nfoo();\n")],
  ['a setup file (global input)', 'run', () => w('backend/typescript/test/setup/seam.ts', 'export const x = 1;\n')],
  ['a test file that lives in the setup directory', 'skip', () => w('backend/typescript/test/setup/__tests__/seam.test.ts', 'it.todo(\'x\');\n')],
  ['the lockfile (global input)', 'run', () => w('backend/typescript/package-lock.json', '{"lockfileVersion":3,"x":1}\n')],
];

let fail = 0;
for (const [name, want, mutate] of cases) {
  g('checkout', '-q', C1, '--', '.');
  g('checkout', '-q', '--detach', C1);
  mutate();
  g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', name);
  const d = tg.decide(TEST, tg.head(), process.version, tg.lockHash());
  const got = d.run ? 'run' : 'skip';
  const ok = got === want;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${want.toUpperCase().padEnd(4)} ${name}${ok ? '' : `  — got ${got} (${d.reason})`}`);
}
// Unchanged tree: the footprint's own commit must be reusable.
g('checkout', '-q', '--detach', C1);
const same = tg.decide(TEST, C1, process.version, tg.lockHash());
if (same.run) { fail++; console.log(`  ✗ SKIP unchanged commit — got run (${same.reason})`); } else console.log('  ✓ SKIP unchanged commit');
// A different Node is a different runtime: never reuse across it.
const other = tg.decide(TEST, C1, 'v0.0.0', tg.lockHash());
if (!other.run) { fail++; console.log('  ✗ RUN  different node version — got skip'); } else console.log('  ✓ RUN  different node version');

// ── v2: composition, enforcement, the entry bar, sync ────────────────────────
const check = (name, cond, detail = '') => { if (!cond) fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  — ${detail}`}`); };
const commit = (msg) => { g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg); return tg.head(); };
const recordAt = (exec) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-run-'));
  fs.mkdirSync(path.join(r, 'raw'));
  fs.writeFileSync(path.join(r, 'raw', 'x.json'), JSON.stringify({ v: 1, testFile: TEST, node: process.version, loaded: [SRC, 'backend/typescript/src/b.ts', TEST], exec, unmapped: [], reads: ['data/read.json'] }));
  fs.writeFileSync(path.join(r, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, TEST), status: 'passed', startTime: 0, endTime: 10, assertionResults: [] }] }));
  tg.ingest({ run: r });
  return r;
};
const execAt = (text) => { const ls = text.split('\n'); const at = (n) => ls.findIndex((l) => l.includes(n)) + 1; return { [SRC]: [at('export function foo'), at("'/hit'"), at('export function baz')], 'backend/typescript/src/b.ts': [1] }; };
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

// A miss triaged as a flake does not suspend enforcement; a `hole` would.
// The gate's re-run triages with --head <first 12 of HEAD>; that key must match the ledger's.
tg.triage({ lane: 'backend', file: TEST, verdict: 'flake', head: C1.slice(0, 12) });
check('a miss triaged as a FLAKE no longer counts against the entry bar', tg.entryBar('backend').recentMiss === false);
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
  fs.writeFileSync(path.join(r, 'raw', 'x.json'), JSON.stringify({ v: 1, testFile: TEST, node: process.version, loaded: [SRC], exec: { [SRC]: [1] }, unmapped: [], reads: [] }));
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
  fs.writeFileSync(path.join(r, 'raw', 'y.json'), JSON.stringify({ v: 1, testFile: FT, node: process.version, loaded: [FT], exec: {}, unmapped: [], reads: [AL] }));
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
      v: 2, testFile: T(n), node: process.version, loaded: [TABLE, 'frontend/react/src/i18n/resources.ts', ...extra, T(n)].sort(),
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

// Sync (P4): two ledgers become their union; each keeps its own log name.
const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-other-'));
fs.mkdirSync(path.join(peer, 'blobs')); fs.writeFileSync(path.join(peer, 'blobs', 'feedface.json.gz'), 'x');
fs.writeFileSync(path.join(peer, 'shadow-othermac.tsv'), 'at\tlane\n');
tg.sync({ remote: peer });
check('sync pulls the other machine\'s blobs and log', fs.existsSync(path.join(ledger, 'blobs', 'feedface.json.gz')) && fs.existsSync(path.join(ledger, 'shadow-othermac.tsv')));
check('sync pushes ours to it', fs.readdirSync(path.join(peer, 'blobs')).length > 1 && fs.readdirSync(peer).some((f) => f.startsWith('shadow-') && f !== 'shadow-othermac.tsv'));
fs.rmSync(peer, { recursive: true, force: true });

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(run, { recursive: true, force: true });
fs.rmSync(ledger, { recursive: true, force: true });
realLog(fail ? `\n== tracegate self-test: ${fail} FAILED ==` : `\n== tracegate self-test: ${cases.length + 46} passed ==`);
process.exit(fail ? 1 : 0);
