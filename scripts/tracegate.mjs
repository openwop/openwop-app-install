#!/usr/bin/env node
// ADR 0880 — Tracegate: test-impact selection from OBSERVED footprints.
//
// Every recorded vitest run deposits, per test file, a FOOTPRINT: the functions
// it executed, the modules it loaded and the repo files it read
// (scripts/lib/tracegate-recorder.mjs). A file's last green verdict is still
// valid on a later tree when nothing in its footprint changed in between, so a
// gate only has to run the files whose footprint a change touches.
//
// MODES (OPENWOP_TRACEGATE, per lane):
//   shadow   run EVERYTHING; predict, then check the prediction (P1).
//   enforce  run only what the prediction says, plus a random AUDIT sample of
//            the files it would reuse (P2). An audited file that fails is a MISS.
//   auto     (default) enforce once the lane has cleared the entry bar, else shadow.
//   off      do nothing.
// ENTRY BAR (P2): observations spanning ≥ 14 days, ≥ 20 of them, and zero misses
// in the last 14 days. A miss — a file predicted reusable that then FAILED — is a
// hole in the footprint. It drops `auto` back to shadow by itself, because the
// bar is re-checked on every gate. No human has to notice.
//
//   node scripts/tracegate.mjs mode    --lane <l>                 effective mode
//   node scripts/tracegate.mjs select  --lane <l> --run <dir> [--mode m] [--audit 0.05]
//   node scripts/tracegate.mjs ingest  --lane <l> --run <dir> [--expect-head <sha>]
//   node scripts/tracegate.mjs report  --lane <l> --run <dir>
//   node scripts/tracegate.mjs status
//   node scripts/tracegate.mjs sync    --remote <[user@]host:/abs/path/to/.git/tracegate>
//   node scripts/tracegate.mjs triage  --lane <l> --file <path> --verdict flake|hole
//
// The ledger lives in `$(git rev-parse --git-common-dir)/tracegate/`, so every
// worktree on this machine (every gate, train, daemon and peer session) shares it.
// It is a CACHE plus a log: deleting `fp/` and `blobs/` is always safe and only
// costs predictions; the `shadow-*.tsv` / `misses-*.tsv` logs are the evidence
// the entry bar reads.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isEntryModule } from './lib/entry-module.mjs';
import { ModuleMap } from './lib/tracegate-recorder.mjs';
import { AGGREGATORS, RESOURCES, changedMessageKeys, i18nHit, importsOf, tableOf } from './lib/tracegate-i18n.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// OPENWOP_TRACEGATE_ROOT points the tool at another checkout (the self-test's
// temp repo); TypeScript always comes from this checkout's backend install.
const ROOT = path.resolve(process.env.OPENWOP_TRACEGATE_ROOT || HERE);
// TypeScript from the target checkout when it has one installed (the daemon's
// tools worktree has no node_modules), else from this one. Loaded LAZILY: only
// parsing needs it, so `status`, `mode`, `sync` and `triage` work in a checkout
// with no install at all (the daemon's tools worktree — found by its first
// `status`, 2026-10-13).
let _ts = null;
const tsLib = () => {
  if (_ts) return _ts;
  for (const base of [ROOT, HERE]) { try { return (_ts = createRequire(path.join(base, 'backend/typescript/package.json'))('typescript')); } catch { /* next */ } }
  throw new Error('tracegate: no TypeScript install found (npm ci in backend/typescript)');
};
const ts = new Proxy({}, { get: (_t, k) => tsLib()[k] });
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
const COMMON = path.resolve(ROOT, git('rev-parse', '--git-common-dir').trim());
export const LEDGER = process.env.OPENWOP_TRACEGATE_LEDGER || path.join(COMMON, 'tracegate');
// 3 (2026-10-15): `new Set([...])`/`new Map()` became constants (isPureInit). A
// footprint's constant list is computed at ingest, so one ingested under the old
// rule never lists them and would SKIP an edit to one: older footprints must not
// be reused across that change.
// v4 records opaque child processes. A v3 receipt cannot prove that its
// subprocess inputs were absent, so it must not grant reuse after this repair.
const FP_VERSION = 4;
const KEEP_PER_TEST = 6; // footprints kept per test file (newest first)
const HOST = (process.env.OPENWOP_TRACEGATE_HOST || os.hostname().split('.')[0] || 'host').replace(/[^A-Za-z0-9_-]/g, '_');
export const ENTRY_BAR = { days: 14, observations: 20 };
// Per-lane overrides of the bar. BACKEND ENTERS EARLY (ADR 0880 correction,
// 2026-10-13, the user's decision): after 20 clean observations over at least
// one day, on 12 clean shadow gates plus two deliberate real-change probes that
// caught every failure. The price is a weaker track record, so until the normal
// 14-day bar would have been met the audit re-runs 20% of reused verdicts, not 5%.
// The nightly full run on main stays the backstop.
// FRONTEND FOLLOWS, same terms (ADR 0918, 2026-10-18, the user's decision): 102
// clean observations over 5.4 days with 0 misses. Its shadow gates already showed
// 97-100% of verdicts reusable while the whole lane ran every gate (5-8 min).
export const LANE_ENTRY = { backend: { days: 1, earlyAudit: 0.2 }, frontend: { days: 1, earlyAudit: 0.2 } };
export const AUDIT_RATE = 0.05;
// A miss suspends enforcement for this long, whatever the lane's entry bar.
export const MISS_SUSPEND_DAYS = 14;
export const barFor = (laneName) => ({ ...ENTRY_BAR, ...(LANE_ENTRY[laneName] ?? {}) });
// A footprint cannot see the wall clock (every app boot reads it), so a verdict
// can go stale with no change at all: a date bomb. Never reuse one older than this.
export const MAX_AGE_HOURS = Number(process.env.OPENWOP_TRACEGATE_MAX_AGE_HOURS || 72);

const RECORDER = 'scripts\\/lib\\/tracegate-recorder\\.mjs';
// A lane is one vitest project. `global` lists inputs every file in the lane
// depends on: a change there runs the whole lane.
export const LANES = {
  backend: {
    dir: 'backend/typescript',
    global: new RegExp(`^(backend/typescript/(package(-lock)?\\.json|vitest\\.config\\.ts|tsconfig[^/]*\\.json|test/setup/)|package(-lock)?\\.json|\\.nvmrc|\\.node-version|${RECORDER})`),
  },
  frontend: {
    dir: 'frontend/react',
    global: new RegExp(`^(frontend/react/(package(-lock)?\\.json|vitest\\.config\\.ts|vite\\.config\\.ts|tsconfig[^/]*\\.json|src/test/)|package(-lock)?\\.json|\\.nvmrc|\\.node-version|${RECORDER})`),
    // PROJECTED reads: a data file every test reads, but whose effect on one test
    // is a known function of its content. The ADR 0661 guard (src/test/
    // no-live-fetch.ts) reads the whole allowlist and asks one question of it:
    // is THIS test file listed? So only a change to that answer can change the
    // test. Measured 2026-10-13: whole-file reads made 4 of 12 frontend gates
    // re-run all ~1,000 files, because every grade-tests train edits this list.
    // The parse below must match the guard's; the guard lives under src/test/,
    // a global input, so changing it re-runs the whole lane anyway.
    // KEY-level i18n dependence (scripts/lib/tracegate-i18n.mjs): a modified
    // catalog invalidates only the tests that looked up a key whose value changed.
    i18n: true,
    projected: { 'frontend/react/test-live-fetch-allowlist.txt': (testFile, before, after) => liveFetchListed(before, testFile) !== liveFetchListed(after, testFile) },
  },
};
function liveFetchListed(text, testFile) {
  if (text === null) return null;
  const rel = testFile.replace(/^frontend\/react\//, '');
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => (l.includes('#') ? l.slice(0, l.indexOf('#')).trim() : l)).includes(rel);
}
// ── replay (ADR 0968 P1): re-decide a past gate offline ─────────────────────
// `replay` evaluates decide() at a past head AS OF that gate's clock, using only
// footprints recorded before it, optionally with some changed paths removed or
// the lock key ignored. It answers "what would this gate have run if <cause> were
// narrowed?" exactly, where the reasons log only says which reason was FIRST.
// It is read-only on the ledger and nothing on a gate path sets REPLAY.
const REPLAY = { at: null, drop: null, ignoreLock: false };
const nowMs = () => (REPLAY.at === null ? Date.now() : REPLAY.at);
const showAt = (commit, p) => { try { return git('show', `${commit}:${p}`); } catch { return null; } };
function lane(o) {
  const l = LANES[o.lane || 'backend'];
  if (!l) throw new Error(`unknown lane ${o.lane} (backend|frontend)`);
  return { name: o.lane || 'backend', ...l };
}

// ── keys: a stable name for every function in a TS file ─────────────────────
// Nearest named function chain; anonymous callbacks are named by callee + first
// string argument (`router.get(/x)`), so a route handler has its own key and
// editing one handler does not invalidate everything that ran the registrar.
// Type-only imports, interfaces and type aliases are erased by the transform and
// map to <import>. A value import or re-export maps to <import:SPEC>: it can pull
// a module graph into load and reorder vi.mock resolution, so it invalidates
// unless SPEC is already loaded (importLoaded). A top-level
// `const X = <literal|object|array|arrow>` maps to <const:X> (invalidates only
// tests whose executed code names X); any other top-level statement maps to <top>
// (invalidates every test that loaded the file).
function nameOf(n, sf) {
  if (n.name && ts.isIdentifier(n.name)) return n.name.text;
  if (n.name) return n.name.getText(sf);
  if (ts.isConstructorDeclaration(n)) return 'constructor';
  const p = n.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return p.name.getText(sf);
  if (p && ts.isCallExpression(p)) {
    const callee = p.expression.getText(sf).replace(/\s+/g, '').slice(-40);
    const lit = p.arguments.find((a) => ts.isStringLiteralLike(a));
    return `${callee}(${lit ? lit.text : '?'})`;
  }
  return '?';
}
const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n);
let _pure = null;
const pureKinds = () => _pure ??= new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.ArrayLiteralExpression, ts.SyntaxKind.AsExpression, ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateExpression, ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.BinaryExpression, ts.SyntaxKind.PrefixUnaryExpression,
  ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression]);

// A built-in collection made from plain data (`new Set([...])`, `new Map()`) has
// no side effect when the module loads; a test can only see it through code that
// names it. So it follows the constant rule, not the top-level one. MEASURED
// 2026-10-15: as `<top>`, one edit to the generated side-effect floor (three
// `new Set([...])` lists) selected 1,794 of 2,581 backend files, and a new empty
// `new Map()` cache in billingService.ts selected 1,316. Only the GLOBAL
// constructor counts: a file that binds its own `Set`/`Map` keeps `<top>`.
const PURE_CTORS = new Set(['Set', 'Map', 'WeakSet', 'WeakMap']);
function isPureInit(init, sf) {
  if (pureKinds().has(init.kind)) return true;
  if (!ts.isNewExpression(init) || !ts.isIdentifier(init.expression) || !PURE_CTORS.has(init.expression.text)) return false;
  const args = init.arguments ?? [];
  if (args.length > 1 || (args.length === 1 && !pureKinds().has(args[0].kind))) return false;
  return !localBindings(sf).has(init.expression.text);
}
const _bindings = new WeakMap();
function localBindings(sf) {
  let b = _bindings.get(sf);
  if (b) return b;
  b = new Set();
  const visit = (n) => {
    if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isParameter(n) ||
      ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n) || ts.isImportEqualsDeclaration(n)) &&
      n.name && ts.isIdentifier(n.name)) b.add(n.name.text);
    n.forEachChild(visit);
  };
  visit(sf);
  _bindings.set(sf, b);
  return b;
}

const _model = new Map();
/** Parse once per (file, content): spans of functions, const names, line classes. */
export function model(src, file) {
  const ck = file + '\0' + crypto.createHash('sha1').update(src).digest('hex');
  const hit = _model.get(ck);
  if (hit) return hit;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  // Every character gets ONE owner: the innermost function containing it, or the
  // class of the top-level statement it belongs to. A changed line then names
  // EVERY owner it touches. Attributing a line to its innermost function alone
  // is unsound: in `items.map((x) => x + 1)` the edit may be to `items`, which
  // belongs to the enclosing function, not to the callback (self-test witness).
  const names = ['<blank>']; const id = (k) => { let i = names.indexOf(k); if (i < 0) { i = names.length; names.push(k); } return i; };
  const owner = new Int32Array(src.length); // 0 = <blank>
  const consts = new Map();
  for (const st of sf.statements) {
    const erased = (ts.isImportDeclaration(st) && st.importClause) || (ts.isExportDeclaration(st) && st.moduleSpecifier) ||
      ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st);
    let cls = '<top>';
    if (erased) {
      const typeOnly = !st.moduleSpecifier || (ts.isImportDeclaration(st) ? st.importClause.isTypeOnly : st.isTypeOnly);
      cls = typeOnly ? '<import>' : `<import:${st.moduleSpecifier.text}>`;
    }
    else if (ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations;
      if (d.length === 1 && ts.isIdentifier(d[0].name) && d[0].initializer && isPureInit(d[0].initializer, sf)) {
        consts.set(d[0].name.text, d[0].initializer.getText(sf));
        cls = `<const:${d[0].name.text}>`;
      }
    }
    owner.fill(id(cls), st.getStart(sf), st.getEnd());
  }
  const spans = [];
  // Iterative pre-order walk (outer before inner, so inner functions overwrite):
  // some generated files nest deeply enough to overflow a recursive walk.
  const stack = [[sf, []]];
  while (stack.length) {
    const [n, chain] = stack.pop();
    let c = chain;
    if (isFn(n)) {
      c = [...chain, nameOf(n, sf)];
      const key = c.join('/');
      spans.push({ s: line(n.getStart(sf)), e: line(n.getEnd()), key });
      owner.fill(id(key), n.getStart(sf), n.getEnd());
    }
    const kids = []; n.forEachChild((k) => { kids.push(k); });
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], c]);
  }
  const lines = src.split('\n');
  const lineStart = [0]; for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStart.push(i + 1);
  /** Owners of line l, optionally only of its columns [c0, c1). */
  const keysAt = (l, c0 = 0, c1 = Infinity) => {
    const ls = lineStart[l - 1]; if (ls === undefined) return ['<blank>'];
    const le = l < lineStart.length ? lineStart[l] : src.length;
    const a = Math.min(le, ls + c0), b = Math.min(le, ls + c1);
    const text = lines[l - 1] ?? '';
    if (/^\s*(\/\/.*|\/?\*.*|\*\/)?\s*$/.test(text)) return ['<blank>'];
    const out = new Set();
    for (let i = a; i < b; i++) { const ch = src.charCodeAt(i); if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13) out.add(names[owner[i]]); }
    return out.size ? [...out] : ['<blank>'];
  };
  /** Functions whose declaration STARTS on line l (what a V8 start offset maps to). */
  const fnsStartingAt = (l) => {
    const at = spans.filter((sp) => sp.s === l).map((sp) => sp.key);
    if (at.length) return at;
    let best = null;
    for (const sp of spans) if (l >= sp.s && l <= sp.e && (!best || (sp.s >= best.s && sp.e <= best.e))) best = sp;
    return best ? [best.key] : [];
  };
  const spanOf = (key) => spans.find((sp) => sp.key === key);
  const jsonImports = [...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+\.json)['"]/g)].map((m) => m[1]);
  const m = { keysAt, fnsStartingAt, spanOf, consts, lines, jsonImports };
  _model.set(ck, m);
  return m;
}

// ── ledger io ────────────────────────────────────────────────────────────────
// fp/<lane>/<sha(testFile)>/<commit>.json.gz — up to KEEP_PER_TEST per file.
// Keeping several is what lets a merge train COMPOSE: a file invalidated only by
// PR A has a green footprint recorded at A's head (by the daemon), and the train
// tree differs from A's head only by the OTHER PRs, which it does not touch.
const testDir = (ln, testFile) => path.join(LEDGER, 'fp', ln, crypto.createHash('sha256').update(testFile).digest('hex').slice(0, 32));
const blobPath = (h) => path.join(LEDGER, 'blobs', h + '.json.gz');
function writeAtomic(p, buf) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, p);
}
const gz = (o) => zlib.gzipSync(JSON.stringify(o));
const ungz = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
function putBlob(list) {
  const h = crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 32);
  const p = blobPath(h);
  if (!fs.existsSync(p)) writeAtomic(p, gz(list));
  return h;
}
const _blobs = new Map();
function getBlob(h) { if (!_blobs.has(h)) _blobs.set(h, ungz(blobPath(h))); return _blobs.get(h); }
/** Footprints for a test file, newest first. Unreadable entries are skipped. */
function readFps(ln, testFile) {
  const d = testDir(ln, testFile);
  let names; try { names = fs.readdirSync(d).filter((f) => f.endsWith('.json.gz')); } catch { return []; }
  const out = [];
  for (const n of names) { try { out.push(ungz(path.join(d, n))); } catch { /* torn write: ignore */ } }
  // A replay sees only what the gate it replays could have seen.
  if (REPLAY.at !== null) return out.filter((f) => Date.parse(f.recordedAt ?? '') <= REPLAY.at).sort((a, b) => (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''));
  return out.sort((a, b) => (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''));
}
function writeFp(ln, fp) {
  const d = testDir(ln, fp.testFile);
  writeAtomic(path.join(d, `${fp.commit}.json.gz`), gz(fp));
  const all = fs.readdirSync(d).filter((f) => f.endsWith('.json.gz')).map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const x of all.slice(KEEP_PER_TEST)) { try { fs.rmSync(path.join(d, x.f)); } catch { /* raced */ } }
}
function dropFps(ln, testFile) { try { fs.rmSync(testDir(ln, testFile), { recursive: true, force: true }); } catch { /* none */ } }

function args() {
  const a = process.argv.slice(3); const o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1]?.startsWith('--') || a[i + 1] === undefined ? true : a[++i];
  return o;
}
function args4() {
  const a = process.argv.slice(5); const o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1]?.startsWith('--') || a[i + 1] === undefined ? true : a[++i];
  return o;
}
export const head = () => git('rev-parse', 'HEAD').trim();
export const lockHash = (ln = LANES.backend) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, ln.dir, 'package-lock.json'))).digest('hex').slice(0, 16); } catch { return 'none'; }
};
// The lane's test files, from VITEST ITSELF. A hand-written pattern was wrong
// twice while building this (it missed `scripts/__tests__/` in the frontend and
// all of `test/steward/` in the backend), and under enforce a file the selector
// does not know about would never run at all. If this fails, select fails, and
// the gate runs the whole lane.
const allTestFiles = (ln) => {
  // The self-test's throwaway repo has no vitest; it names its files instead.
  if (process.env.OPENWOP_TRACEGATE_TEST_LIST) return process.env.OPENWOP_TRACEGATE_TEST_LIST.split('\n').filter(Boolean);
  const out = execFileSync('node', ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--json'], {
    cwd: path.join(ROOT, ln.dir), encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, OPENWOP_VITEST_NO_WAIT: '1', OPENWOP_TRACEGATE_RECORD: '' },
  });
  const files = JSON.parse(out.slice(out.indexOf('['))).map((e) => path.relative(ROOT, e.file));
  if (!files.length) throw new Error(`vitest listed no test files in ${ln.dir}`);
  return files;
};

// ── ingest: raw footprints + verdicts → ledger ───────────────────────────────
export function ingest(o) {
  const ln = lane(o);
  const run = o.run; if (!run) throw new Error('--run <dir> is required');
  const H = head();
  // H101: a footprint is attributed to a commit, so it must describe THAT commit.
  const dirty = git('status', '--porcelain', '--untracked-files=no').trim();
  if (dirty) { console.log(`tracegate ingest (${ln.name}): working tree has uncommitted changes — nothing recorded (H101).`); return; }
  if (o['expect-head'] && o['expect-head'] !== H) { console.log(`tracegate ingest (${ln.name}): HEAD moved during the run — nothing recorded (H101).`); return; }
  const results = loadResults(run);
  const rawDir = path.join(run, 'raw');
  const raws = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')) : [];
  const lock = lockHash(ln);
  let recorded = 0, dropped = 0, noVerdict = 0, unmapped = 0, mapped = 0, overBudget = 0;
  // A hard time budget: ingest runs at the END of a gate (joined before the
  // final H101 check), so it must never hold that end for long. Footprints
  // written before the budget runs out are complete and valid; the rest are
  // simply not recorded this time (their files run next time). Slot 56 was held
  // 16+ min by the pre-cache ingest before this existed.
  const budgetMs = 1000 * Number(o['budget-s'] ?? process.env.OPENWOP_TRACEGATE_INGEST_BUDGET_S ?? 300);
  const t0 = Date.now();
  const shadow = { booted: 0, reusable: 0, invalidated: 0, absorbable: 0, wouldSkip: 0, wouldSkipFailed: [], noDigest: 0, errors: 0 };
  for (const f of raws) {
    if (Date.now() - t0 > budgetMs) { overBudget++; continue; }
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')); } catch { continue; }
    const verdict = results.get(raw.testFile);
    if (!verdict) { noVerdict++; continue; }
    // ADR 0968 P2 shadow: judged against the footprints that existed BEFORE this
    // run, and BEFORE a red drops them, because a would-skip that failed is the
    // soundness signal. Never throws into ingest.
    let bootFp = null;
    if (raw.boot) {
      try { bootFp = bootFields(ln, run, raw); shadowBoot(ln, raw, verdict, H, lock, bootFp, shadow); } catch { shadow.errors++; }
    }
    if (verdict.status !== 'passed') { dropFps(ln.name, raw.testFile); dropped++; continue; } // a red file must run next time
    const keys = {}; const idents = new Set();
    for (const [file, ex] of Object.entries(raw.exec)) {
      // v2 raw: { code: <sha of the compiled text>, offs: [V8 start offsets] } —
      // mapped here, once per module per run, instead of in every test worker.
      const startLines = Array.isArray(ex) ? ex : mapOffsets(run, ex);
      if (!startLines) { raw.unmapped.push(file); continue; }
      const fi = fileInfo(ln, file);
      if (!fi) continue;
      const ks = new Set();
      for (const l of startLines) {
        for (const k of fi.m.fnsStartingAt(l)) {
          ks.add(k);
          for (const w of fi.spanIdents(k)) idents.add(w);
        }
      }
      keys[file] = [...ks].sort();
    }
    unmapped += raw.unmapped.length; mapped += Object.keys(keys).length;
    // Reference closure: a referenced constant pulls in the names its initializer
    // uses. "Referenced" = named by an executed function, by any line of a
    // test-side module (assertions over a src table), or by a non-function
    // top-level statement of a loaded src module (`registerAll(FEATURES)`). The
    // last two are per-FILE facts, computed once per ingest (fileInfo) and asked
    // by name through refFiles, never re-scanned per test: the first version
    // rescanned ~1,700 files per test and took 11+ min for the backend lane.
    const loaded = new Set(raw.loaded);
    const defs = [];
    const reads = new Set(raw.reads);
    for (const file of raw.loaded) {
      const fi = /\.tsx?$/.test(file) ? fileInfo(ln, file) : null;
      if (!fi) continue;
      for (const d of fi.defs) defs.push(d);
      for (const j of fi.jsonImports) reads.add(j);
    }
    const referenced = (name) => {
      if (idents.has(name)) return true;
      const files = refFiles.get(name);
      if (files) for (const f of files) if (loaded.has(f)) return true;
      return false;
    };
    const consts = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [file, name, initIdents] of defs) {
        const id = `${file}::${name}`;
        if (consts.has(id) || !referenced(name)) continue;
        consts.add(id); grew = true;
        for (const w of initIdents) idents.add(w);
      }
    }
    // Key-level i18n reads, valid only while nothing the test loaded can see a
    // catalog without the store: a module importing the aggregator turns them off
    // for this test; one importing a table keeps the constant rule for THAT table.
    let i18n;
    if (ln.i18n && raw.i18n) {
      const direct = new Set(); let off = null;
      for (const file of raw.loaded) {
        if (AGGREGATORS.has(file) || !/\.tsx?$/.test(file)) continue;
        const fi = fileInfo(ln, file);
        for (const imp of fi?.imports ?? []) {
          if (imp === RESOURCES) off ??= file;
          else if (tableOf(imp)) direct.add(imp);
        }
      }
      i18n = off ? { off } : { keys: putBlob(raw.i18n.keys), whole: raw.i18n.whole, direct: [...direct].sort() };
    }
    writeFp(ln.name, {
      ...(i18n ? { i18n } : {}),
      // Older raw recorders could not observe a child's inputs. Unknown is
      // opaque, never evidence that no subprocess was used.
      subprocess: raw.subprocess !== false,
      v: FP_VERSION, lane: ln.name, testFile: raw.testFile, commit: H, node: raw.node, lock,
      loaded: putBlob(raw.loaded), reads: putBlob([...reads].sort()), unmapped: raw.unmapped,
      keys, consts: [...consts].sort(), durationMs: verdict.durationMs, recordedAt: new Date().toISOString(), host: HOST,
      ...(bootFp ? { boot: bootFp } : {}),
    });
    recorded++;
  }
  const share = mapped + unmapped ? (100 * unmapped / (mapped + unmapped)).toFixed(1) : '0.0';
  console.log(`tracegate ingest (${ln.name}): ${recorded} footprint(s) at ${H.slice(0, 9)} in ${Math.round((Date.now() - t0) / 1000)} s; ${dropped} dropped (not green); ${noVerdict} without a verdict; unmapped modules ${share}%.`);
  if (shadow.booted) writeBootShadow(ln, H, shadow);
  if (overBudget) console.log(`tracegate ingest (${ln.name}): time budget (${budgetMs / 1000} s) reached — ${overBudget} file(s) not recorded this run; they will simply run next time.`);
  if (Number(share) > 5) console.log(`\x1b[33mtracegate: ${share}% of loaded modules could not be mapped — the recorder's vitest seam may have moved (see scripts/lib/tracegate-recorder.mjs). Predictions stay safe (unmapped ⇒ run) but get coarse.\x1b[0m`);
}

// ── boot fields + shadow verdict (ADR 0968 P2) ───────────────────────────────
// Keys executed per phase, mapped like `exec`; the boot-only part is what the
// test touched only inside createApp. testConsts is the constant closure of the
// TEST phase alone (the same rule as `consts`, seeded only by test-phase code
// and the always-running text of loaded files). Stored as one blob; an additive
// field that decide() never reads (FP_VERSION unchanged).
function phaseKeys(ln, run, execObj, idents) {
  const out = {};
  for (const [file, ex] of Object.entries(execObj ?? {})) {
    const startLines = Array.isArray(ex) ? ex : mapOffsets(run, ex);
    if (!startLines) continue;
    const fi = fileInfo(ln, file);
    if (!fi) continue;
    const ks = new Set();
    for (const l of startLines) for (const k of fi.m.fnsStartingAt(l)) { ks.add(k); if (idents) for (const w of fi.spanIdents(k)) idents.add(w); }
    out[file] = [...ks].sort();
  }
  return out;
}
function bootFields(ln, run, raw) {
  const testIdents = new Set();
  const testKeys = phaseKeys(ln, run, raw.boot.testExec, testIdents);
  const bootKeys = phaseKeys(ln, run, raw.boot.exec, null);
  // The IMPORT window (before the first boot mark; recorder, ADR 0968 correction
  // 2026-10-27): app source evaluated on import is boot wiring, because this app's
  // features register as their modules evaluate. A test file or test helper
  // evaluated then is the test's own code. Absent in footprints recorded before the
  // correction: those keep the old reading (import = test), which only absorbs less.
  const isAppSrc = (p) => p.startsWith(ln.dir + '/src/') && !/\.(test|spec)\.tsx?$/.test(p) && !/(^|\/)(__tests__|test|tests)\//.test(p.slice(ln.dir.length + 5));
  if (raw.boot.impExec) {
    const impBoot = {}, impTest = {};
    for (const [file, e] of Object.entries(raw.boot.impExec)) (isAppSrc(file) ? impBoot : impTest)[file] = e;
    const merge = (into, from) => { for (const [file, ks] of Object.entries(from)) into[file] = [...new Set([...(into[file] ?? []), ...ks])].sort(); };
    merge(bootKeys, phaseKeys(ln, run, impBoot, null));
    merge(testKeys, phaseKeys(ln, run, impTest, testIdents));
  }
  const keys = {};
  for (const [file, ks] of Object.entries(bootKeys)) {
    const t = new Set(testKeys[file] ?? []);
    const only = ks.filter((k) => !t.has(k));
    if (only.length) keys[file] = only;
  }
  const testReads = new Set(raw.boot.testReads);
  // Import-time reads of test fixtures stay test reads; the rest (manifests, schemas
  // loaded as modules evaluate) are boot reads.
  for (const r of raw.boot.impReads ?? []) if (/(^|\/)(__tests__|test|tests|fixtures)\//.test(r) || /\.(test|spec)\.tsx?$/.test(r)) testReads.add(r);
  const bootReadsAll = [...new Set([...raw.boot.reads, ...(raw.boot.impReads ?? [])])];
  const reads = bootReadsAll.filter((r) => !testReads.has(r)).sort();
  const loaded = new Set(raw.loaded);
  const defs = [];
  for (const file of raw.loaded) { const fi = /\.tsx?$/.test(file) ? fileInfo(ln, file) : null; if (fi) for (const d of fi.defs) defs.push(d); }
  const testConsts = new Set();
  // A constant is test-used when a function the TEST PHASE ran names it (testIdents),
  // or a loaded test file or test helper names it. ADR 0968 correction (2026-10-27):
  // this used to count ANY loaded file, the defining module included, so every module
  // with a constant was test-used and nothing could be boot-only. App source that
  // names it from boot or import code is boot wiring, which the digest stands for.
  const referenced = (name) => { if (testIdents.has(name)) return true; const fs_ = refFiles.get(name); if (fs_) for (const f of fs_) if (loaded.has(f) && !isAppSrc(f)) return true; return false; };
  for (let grew = true; grew;) {
    grew = false;
    for (const [file, name, initIdents] of defs) {
      const id = `${file}::${name}`;
      if (testConsts.has(id) || !referenced(name)) continue;
      testConsts.add(id); grew = true;
      for (const w of initIdents) testIdents.add(w);
    }
  }
  const ds = raw.boot.digests ?? [];
  const digest = !raw.boot.error && ds.length && ds.length === raw.boot.n && !ds.some((d) => d.startsWith('error:'))
    ? crypto.createHash('sha256').update(ds.join('\n')).digest('hex').slice(0, 32) : null;
  return { n: raw.boot.n, digest, only: putBlob({ keys, reads, testFiles: Object.keys(testKeys).sort(), testConsts: [...testConsts].sort() }) };
}
function shadowBoot(ln, raw, verdict, H, lock, bootFp, sh) {
  sh.booted++;
  const prev = readFps(ln.name, raw.testFile).filter((fp) => fp.commit !== H && fp.boot);
  if (!prev.length) return;
  if (prev.some((fp) => !invalidates(ln, raw.testFile, fp, H, raw.node, lock))) { sh.reusable++; return; }
  sh.invalidated++;
  let best = null;
  for (const fp of prev) {
    const why = invalidatesBoot(ln, raw.testFile, fp, H, raw.node, lock, bootFp.digest);
    if (!why) { best = 'skip'; break; }
    if (/^boot-only/.test(why)) best ??= why;
  }
  if (best === 'skip') {
    sh.absorbable++; sh.wouldSkip++;
    if (verdict.status !== 'passed') sh.wouldSkipFailed.push(raw.testFile);
  } else if (best) {
    sh.absorbable++;
    if (/no boot digest/.test(best)) sh.noDigest++;
  }
}
// One row per ingest that saw a boot, so growth is bounded by gates (like reasons-*);
// rotated to .1 past BOOT_SHADOW_MAX_ROWS so it can never grow without bound.
const BOOT_SHADOW_MAX_ROWS = 10_000;
function writeBootShadow(ln, H, sh) {
  fs.mkdirSync(LEDGER, { recursive: true });
  const f = path.join(LEDGER, `boot-shadow-${HOST}.tsv`);
  const HDR = 'at\tlane\thead\tbooted\treusable\tinvalidated\tboot_absorbable\twould_skip\twould_skip_failed\tno_digest\terrors\tfailed_files\n';
  try { if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').split('\n').length > BOOT_SHADOW_MAX_ROWS) fs.renameSync(f, `${f}.1`); } catch { /* best effort */ }
  if (!fs.existsSync(f)) fs.writeFileSync(f, HDR);
  fs.appendFileSync(f, [new Date().toISOString(), ln.name, H.slice(0, 12), sh.booted, sh.reusable, sh.invalidated, sh.absorbable, sh.wouldSkip, sh.wouldSkipFailed.length, sh.noDigest, sh.errors, JSON.stringify(sh.wouldSkipFailed.slice(0, 20))].join('\t') + '\n');
  console.log(`tracegate (${ln.name}): boot shadow (ADR 0968, decides nothing) — of ${sh.invalidated} booting file(s) invalidated, ${sh.absorbable} were invalidated only through boot, and ${sh.wouldSkip} would skip on an unchanged boot digest (${sh.wouldSkipFailed.length} of those FAILED${sh.wouldSkipFailed.length ? ': ' + sh.wouldSkipFailed.slice(0, 5).join(', ') : ''}); ${sh.noDigest} had no digest; ${sh.errors} error(s).`);
}

// Per-file facts for one ingest: the tree is fixed (H101), so each file is read,
// parsed and scanned ONCE however many test files loaded it.
const _fileInfo = new Map();
const refFiles = new Map(); // identifier → files whose "always-running" text names it
const IDENT = /[A-Za-z_$][\w$]*/g;
function fileInfo(ln, file) {
  if (_fileInfo.has(file)) return _fileInfo.get(file);
  let fi = null;
  // Only a MISSING file may yield no info. A model() failure (no TypeScript
  // install, say) must throw: an empty key set reads as "executed nothing", and
  // every change to that file would then be skipped. MEASURED 2026-10-13 in a
  // worktree without node_modules: 7 self-test RUN cases silently became SKIP.
  let src = null;
  try { src = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { /* not in this tree */ }
  if (src !== null) {
    const m = model(src, file);
    const testSide = !file.startsWith(ln.dir + '/src/') || /\.(test|spec)\.tsx?$/.test(file);
    const always = new Set();
    m.lines.forEach((text, i) => {
      if (!testSide && !m.keysAt(i + 1).includes('<top>')) return;
      for (const w of text.match(IDENT) ?? []) always.add(w);
    });
    // Only TS modules hold references. A JSON module also reaches the executed set
    // (vitest evaluates it through the same vm path) and parses as one big
    // expression whose every word would look like a reference. The equality
    // check against the per-test version caught exactly that (13/1,299
    // footprints, via seed-data/exampleAgents.json).
    if (/\.tsx?$/.test(file)) for (const w of always) { let s = refFiles.get(w); if (!s) refFiles.set(w, (s = [])); s.push(file); }
    const spanIdentCache = new Map();
    fi = {
      m,
      defs: [...m.consts].map(([name, init]) => [file, name, init.match(IDENT) ?? []]),
      jsonImports: m.jsonImports.map((j) => path.posix.normalize(path.posix.join(path.posix.dirname(file), j))),
      imports: importsOf(file, src),
      spanIdents(k) {
        let r = spanIdentCache.get(k);
        if (!r) {
          const sp = m.spanOf(k); const set = new Set();
          if (sp) for (let i = sp.s; i <= sp.e; i++) for (const w of m.lines[i - 1]?.match(IDENT) ?? []) set.add(w);
          spanIdentCache.set(k, (r = [...set]));
        }
        return r;
      },
    };
  }
  _fileInfo.set(file, fi);
  return fi;
}

const _maps = new Map();
function mapOffsets(run, ex) {
  let mm = _maps.get(ex.code);
  if (mm === undefined) {
    try { mm = new ModuleMap(fs.readFileSync(path.join(run, 'codes', ex.code + '.js'), 'utf8')); } catch { mm = null; }
    _maps.set(ex.code, mm);
  }
  if (!mm || !mm.mappings) return null;
  const lines = new Set();
  for (const off of ex.offs) { if (off < mm.prefix) continue; const l = mm.originalLine(off); if (l) lines.add(l); }
  return [...lines];
}

function loadResults(run) {
  const out = new Map();
  let j; try { j = JSON.parse(fs.readFileSync(path.join(run, 'results.json'), 'utf8')); } catch { return out; }
  for (const r of j.testResults ?? []) {
    const rel = path.relative(ROOT, r.name);
    const failed = r.status === 'failed' || (r.assertionResults ?? []).some((a) => a.status === 'failed');
    out.set(rel, { status: failed ? 'failed' : r.status === 'passed' ? 'passed' : r.status, durationMs: Math.max(0, (r.endTime ?? 0) - (r.startTime ?? 0)) });
  }
  return out;
}

// ── decide: may this file's verdict be reused on tree H? ─────────────────────
const _changes = new Map();
function changesSince(C, H) {
  const ck = C + '..' + H + (REPLAY.drop ? ' -' + REPLAY.drop.source : '');
  if (_changes.has(ck)) return _changes.get(ck);
  let res;
  try {
    git('cat-file', '-e', C + '^{commit}');
    res = git('diff', '--no-renames', '--name-status', C, H).trim().split('\n').filter(Boolean)
      .map((l) => { const [st, p] = l.split('\t'); return { st, path: p, keys: null }; })
      .filter((c) => !(REPLAY.drop && REPLAY.drop.test(c.path)));
  } catch { res = null; } // commit gone (a gc'd train) → unknown → run
  _changes.set(ck, res);
  return res;
}

function changedKeys(C, H, ch) {
  if (ch.keys) return ch.keys;
  const keys = new Set();
  const diff = git('diff', '-U0', C, H, '--', ch.path);
  let pre = null, post = null;
  // A missing side is an add or a delete. A model() error is NOT: it propagates,
  // and select turns it into "run" (predictor error) instead of "nothing changed".
  const before = showAt(C, ch.path), after = showAt(H, ch.path);
  if (before !== null) pre = model(before, ch.path);
  if (after !== null) post = model(after, ch.path);
  // Hunks with their text, so a modified line can be narrowed to the columns that
  // actually changed (common prefix/suffix). A line diff alone cannot tell
  // `bar()` → `bar() + 1` (inside a callback) from an edit to the call around it.
  const hunks = diff.split(/^(?=@@ )/m).filter((h) => h.startsWith('@@'));
  for (const h of hunks) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h);
    const oldStart = +m[1], oldN = m[2] === undefined ? 1 : +m[2], newStart = +m[3], newN = m[4] === undefined ? 1 : +m[4];
    const body = h.split('\n').slice(1);
    const removed = body.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
    const added = body.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
    const paired = Math.min(removed.length, added.length);
    for (let i = 0; i < Math.max(oldN, newN, 1); i++) {
      let r0 = 0, r1 = Infinity, a0 = 0, a1 = Infinity;
      if (i < paired) {
        const o = removed[i], n = added[i];
        let p = 0; while (p < o.length && p < n.length && o[p] === n[p]) p++;
        let q = 0; while (q < o.length - p && q < n.length - p && o[o.length - 1 - q] === n[n.length - 1 - q]) q++;
        r0 = p; r1 = o.length - q; a0 = p; a1 = n.length - q;
      }
      // Each side contributes only the characters it actually has: an insertion is
      // described by the new side, a deletion by the old side, an edit by both.
      // An old-side value import is tagged <import-old:SPEC>: dropping or editing
      // it can stop a side-effect module evaluating or reorder vi.mock, so it
      // always invalidates, even when SPEC was loaded.
      if (pre && i < oldN && r1 > r0) for (const k of pre.keysAt(oldStart + i, r0, r1)) keys.add(k.startsWith('<import:') ? `<import-old:${k.slice(8)}` : k);
      if (post && i < newN && a1 > a0) for (const k of post.keysAt(newStart + i, a0, a1)) keys.add(k);
    }
  }
  ch.keys = keys;
  return keys;
}

/**
 * A modified i18n catalog, judged by key (scripts/lib/tracegate-i18n.mjs).
 * Returns a reason (string) to run, null when the test cannot see the change,
 * or undefined to fall back to the constant rule.
 */
function i18nVerdict(fp, p, c, H) {
  const tb = tableOf(p);
  const rec = fp.i18n;
  if (!tb || !rec || rec.off || (rec.direct ?? []).includes(p)) return undefined;
  for (const k of changedKeys(fp.commit, H, c)) if (k !== '<blank>' && k !== '<import>' && k !== '<const:messages>') return undefined;
  const changed = changedMessageKeys(ts, showAt(fp.commit, p), showAt(H, p));
  if (!changed) return undefined;
  let keys; try { keys = getBlob(rec.keys); } catch { return 'footprint blob missing'; }
  const hit = i18nHit({ keys, whole: rec.whole }, tb, changed);
  return hit ? `i18n ${hit} changed (looked up by this test)` : null;
}

/** Is one footprint still valid on H? Returns null if valid, else the reason. */
function invalidates(ln, testFile, fp, H, nodeVersion, lock) {
  if (fp.v !== FP_VERSION) return 'footprint format changed';
  if (fp.subprocess !== false) return 'opaque subprocess input';
  if (fp.node !== nodeVersion) return `node ${fp.node} → ${nodeVersion}`;
  if (fp.lock !== lock && !REPLAY.ignoreLock) return 'lockfile changed';
  const ageH = (nowMs() - Date.parse(fp.recordedAt)) / 3_600_000;
  if (!(ageH <= MAX_AGE_HOURS)) return `footprint older than ${MAX_AGE_HOURS} h (time-dependent tests)`;
  if (fp.commit === H) return null;
  const ch = changesSince(fp.commit, H);
  if (!ch) return `footprint commit ${fp.commit.slice(0, 9)} unavailable`;
  // Global inputs invalidate every footprint before per-file parsing or reads.
  // A recorder change sorts after frontend catalog changes; checking it only
  // inside the loop used hundreds of Git reads before reaching the same RUN.
  // Test files under global directories are not setup inputs; their ordinary
  // loaded-module/test-file checks below still apply.
  const globalInput = ch.find(({ path: p }) => ln.global.test(p) && !/\.(test|spec)\.tsx?$/.test(p));
  if (globalInput) return `global input ${globalInput.path}`;
  let loaded, reads;
  try { loaded = new Set(getBlob(fp.loaded)); reads = getBlob(fp.reads); } catch { return 'footprint blob missing'; }
  const consts = new Set(fp.consts);
  for (const c of ch) {
    const p = c.path;
    if (p === testFile) return 'the test file changed';
    if (loaded.has(p)) {
      const isSrc = p.startsWith(ln.dir + '/src/') && /\.tsx?$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p);
      if (!isSrc) return `loaded module ${p}`;
      if (c.st === 'D') return `loaded module deleted ${p}`;
      if ((fp.unmapped ?? []).includes(p)) return `unmapped module ${p}`;
      if (ln.i18n && c.st === 'M') {
        const why = i18nVerdict(fp, p, c, H);
        if (why === null) continue;
        if (why) return why;
      }
      const exec = fp.keys[p] ?? [];
      for (const k of changedKeys(fp.commit, H, c)) {
        if (k === '<blank>' || k === '<import>') continue;
        if (k.startsWith('<import-old:')) return `import ${k.slice(12, -1)} removed or changed in ${p}`;
        if (k.startsWith('<import:')) return `value import ${k.slice(8, -1)} added or changed in ${p}`;
        if (k === '<top>') return `top-level change in ${p}`;
        if (k.startsWith('<const:')) { if (consts.has(`${p}::${k.slice(7, -1)}`)) return `constant ${k.slice(7, -1)} in ${p}`; continue; }
        if (exec.includes(k)) return `executed function ${k} in ${p}`;
      }
      continue;
    }
    const proj = ln.projected?.[p];
    if (proj && c.st === 'M' && reads.includes(p)) {
      if (proj(testFile, showAt(fp.commit, p), showAt(H, p))) return `projected input ${p} (its answer for this test changed)`;
      continue;
    }
    for (const r of reads) if (r === p || p.startsWith(r + '/')) return `read input ${p}`;
  }
  return null;
}

// ── boot shadow (ADR 0968 P2): would a boot-outcome rule have skipped it? ───
// SHADOW ONLY. Nothing that selects or reuses a verdict calls this; it runs at
// ingest, for files that just ran, and only writes boot-shadow-<host>.tsv.
// It is invalidates() with one difference: a change the test can have seen ONLY
// through app boot (a function it executed only inside createApp, a file it read
// only there, or a top-level statement/constant of a module none of whose
// functions or constants its test phase touched) is ABSORBED instead of
// returned, and absorption then requires the boot digest at the footprint's
// commit to equal the one just recorded. Keep its non-boot branches identical
// to invalidates(): the self-test runs every decide() case through both.
export function invalidatesBoot(ln, testFile, fp, H, nodeVersion, lock, digestNow) {
  if (fp.v !== FP_VERSION) return 'footprint format changed';
  if (fp.subprocess !== false) return 'opaque subprocess input';
  if (fp.node !== nodeVersion) return `node ${fp.node} → ${nodeVersion}`;
  if (fp.lock !== lock) return 'lockfile changed';
  const ageH = (Date.now() - Date.parse(fp.recordedAt)) / 3_600_000;
  if (!(ageH <= MAX_AGE_HOURS)) return `footprint older than ${MAX_AGE_HOURS} h (time-dependent tests)`;
  if (fp.commit === H) return null;
  const ch = changesSince(fp.commit, H);
  if (!ch) return `footprint commit ${fp.commit.slice(0, 9)} unavailable`;
  let loaded, reads, boot = null;
  try {
    loaded = new Set(getBlob(fp.loaded)); reads = getBlob(fp.reads);
    if (fp.boot?.only) { const b = getBlob(fp.boot.only); boot = { keys: b.keys, reads: new Set(b.reads), testFiles: new Set(b.testFiles), testConsts: new Set(b.testConsts) }; }
  } catch { return 'footprint blob missing'; }
  const consts = new Set(fp.consts);
  let absorbed = null;
  const absorb = (why) => { absorbed ??= why; };
  for (const c of ch) {
    const p = c.path;
    if (ln.global.test(p) && !/\.(test|spec)\.tsx?$/.test(p)) return `global input ${p}`;
    if (p === testFile) return 'the test file changed';
    if (loaded.has(p)) {
      const isSrc = p.startsWith(ln.dir + '/src/') && /\.tsx?$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p);
      if (!isSrc) return `loaded module ${p}`;
      if (c.st === 'D') return `loaded module deleted ${p}`;
      if ((fp.unmapped ?? []).includes(p)) return `unmapped module ${p}`;
      if (ln.i18n && c.st === 'M') {
        const why = i18nVerdict(fp, p, c, H);
        if (why === null) continue;
        if (why) return why;
      }
      const exec = fp.keys[p] ?? [];
      // Module-level text is boot-only when the test phase used nothing of p.
      const moduleBootOnly = boot && !boot.testFiles.has(p) && ![...boot.testConsts].some((id) => id.startsWith(p + '::'));
      for (const k of changedKeys(fp.commit, H, c)) {
        if (k === '<blank>' || k === '<import>') continue;
        if (k.startsWith('<import-old:')) return `import ${k.slice(12, -1)} removed or changed in ${p}`;
        if (k.startsWith('<import:')) return `value import ${k.slice(8, -1)} added or changed in ${p}`;
        if (k === '<top>') { if (moduleBootOnly) { absorb(`top-level change in ${p}`); continue; } return `top-level change in ${p}`; }
        if (k.startsWith('<const:')) {
          const id = `${p}::${k.slice(7, -1)}`;
          if (!consts.has(id)) continue;
          if (boot && !boot.testConsts.has(id)) { absorb(`constant ${k.slice(7, -1)} in ${p}`); continue; }
          return `constant ${k.slice(7, -1)} in ${p}`;
        }
        if (exec.includes(k)) {
          if (boot && (boot.keys[p] ?? []).includes(k)) { absorb(`executed function ${k} in ${p}`); continue; }
          return `executed function ${k} in ${p}`;
        }
      }
      continue;
    }
    const proj = ln.projected?.[p];
    if (proj && c.st === 'M' && reads.includes(p)) {
      if (proj(testFile, showAt(fp.commit, p), showAt(H, p))) return `projected input ${p} (its answer for this test changed)`;
      continue;
    }
    for (const r of reads) {
      if (!(r === p || p.startsWith(r + '/'))) continue;
      if (boot && boot.reads.has(r)) { absorb(`read input ${p}`); continue; }
      return `read input ${p}`;
    }
  }
  if (!absorbed) return null;
  if (!fp.boot?.digest || !digestNow) return `boot-only (${absorbed}), but no boot digest to compare`;
  if (fp.boot.digest !== digestNow) return `boot-only (${absorbed}), and the boot outcome changed`;
  return null;
}

/** decide()'s shape over invalidatesBoot — for the self-test's parity rows only. */
export function shadowDecide(testFile, H, nodeVersion, lock, laneName = 'backend', digestNow = null) {
  const ln = lane({ lane: laneName });
  const fps = readFps(ln.name, testFile);
  if (!fps.length) return { run: true, reason: 'no footprint' };
  let first = null;
  for (const fp of fps) {
    const why = invalidatesBoot(ln, testFile, fp, H, nodeVersion, lock, digestNow);
    if (!why) return { run: false, reason: 'boot shadow: reusable' };
    first ??= why;
  }
  return { run: true, reason: first };
}

export function decide(testFile, H, nodeVersion, lock, laneName = 'backend') {
  const ln = lane({ lane: laneName });
  const fps = readFps(ln.name, testFile);
  if (!fps.length) return { run: true, reason: 'no footprint' };
  let first = null;
  for (const fp of fps) {
    const why = invalidates(ln, testFile, fp, H, nodeVersion, lock);
    if (!why) return { run: false, reason: fp.commit === H ? 'green at this commit' : `green at ${fp.commit.slice(0, 9)}, nothing it depends on changed`, from: fp.commit, durationMs: fp.durationMs };
    first ??= why;
  }
  return { run: true, reason: first };
}

// ── mode + entry bar ─────────────────────────────────────────────────────────
function readTsv(prefix) {
  let names = []; try { names = fs.readdirSync(LEDGER).filter((f) => f.startsWith(prefix) && f.endsWith('.tsv')); } catch { return []; }
  const rows = [];
  for (const n of names) {
    const lines = fs.readFileSync(path.join(LEDGER, n), 'utf8').trim().split('\n');
    const hdr = lines.shift()?.split('\t') ?? [];
    for (const l of lines) { const v = l.split('\t'); rows.push(Object.fromEntries(hdr.map((h, i) => [h, v[i]]))); }
  }
  return rows;
}
export function entryBar(laneName) {
  const obs = readTsv('shadow-').filter((r) => r.lane === laneName && (r.mode === 'shadow' || r.mode === 'enforce'));
  // A miss triaged as a flake (`tracegate.mjs triage <file> flake`) is a test
  // problem, not a footprint hole: it does not suspend enforcement. A `hole` does.
  // The LATEST verdict for a (lane, file, head) decides (ADR 0980 P1, as upstream):
  // a Red Reader escalation (`escalations-`, written by `red annotate`) is a
  // `hole` that comes after the gate's own recheck `flake`, and a person's later
  // `triage --verdict flake` overrides it again. OPENWOP_TRACEGATE_RED_ESCALATE=off
  // ignores escalations.
  const escalations = process.env.OPENWOP_TRACEGATE_RED_ESCALATE === 'off' ? [] : readTsv('escalations-');
  const verdicts = [...readTsv('triage-'), ...escalations].filter((t) => t.verdict === 'flake' || t.verdict === 'hole')
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const last = new Map(); for (const t of verdicts) last.set(`${t.lane}\0${t.file}\0${t.head}`, t.verdict);
  const flakes = new Set([...last].filter(([, v]) => v === 'flake').map(([k]) => k));
  const misses = readTsv('misses-').filter((r) => r.lane === laneName && !flakes.has(`${r.lane}\0${r.file}\0${r.head}`));
  const now = Date.now(), day = 86_400_000;
  const first = obs.length ? Math.min(...obs.map((r) => Date.parse(r.at))) : now;
  const bar = barFor(laneName);
  const recentMiss = misses.some((m) => now - Date.parse(m.at) < MISS_SUSPEND_DAYS * day);
  const spanDays = (now - first) / day;
  const ok = spanDays >= bar.days && obs.length >= bar.observations && !recentMiss;
  // An early entry audits harder until the default bar would have been met.
  const auditRate = spanDays < ENTRY_BAR.days && bar.earlyAudit !== undefined ? bar.earlyAudit : AUDIT_RATE;
  return { ok, spanDays: +spanDays.toFixed(1), observations: obs.length, recentMiss, missesTotal: misses.length, auditRate, bar };
}
// The checks a subset run cannot make — the live-fetch and event-payload STALE
// checks, and the full MISS sweep over every reusable verdict — are handed to a
// FULL run. The daemon's nightly was meant to be that run, and MEASURED
// 2026-10-14 it had never completed: gates run through the night, so every tick
// of its window yielded. So the backstop lives in the gate: a lane whose last
// COMPLETE full run (`full-<host>.tsv`, written only after those checks passed)
// is older than this runs full (shadow) in the gate that finds it so.
export const FULL_RUN_MAX_HOURS = 24;
export function lastFullHours(laneName) {
  const at = readTsv('full-').filter((r) => r.lane === laneName).map((r) => Date.parse(r.at)).filter(Number.isFinite);
  return at.length ? (Date.now() - Math.max(...at)) / 3_600_000 : Infinity;
}
export function modeDecision(laneName) {
  const want = (process.env[`OPENWOP_TRACEGATE_${laneName.toUpperCase()}`] || process.env.OPENWOP_TRACEGATE || 'auto').toLowerCase();
  if (['off', 'shadow', 'enforce'].includes(want)) return { mode: want, why: 'set by OPENWOP_TRACEGATE' };
  if (!entryBar(laneName).ok) return { mode: 'shadow', why: 'entry bar not met' };
  const h = lastFullHours(laneName);
  if (h >= FULL_RUN_MAX_HOURS) {
    return { mode: 'shadow', full: true, why: `last complete full run ${Number.isFinite(h) ? `${Math.round(h)}h ago` : 'never recorded'} (≥ ${FULL_RUN_MAX_HOURS}h) — this gate runs the whole lane so the stale checks and the miss sweep happen` };
  }
  return { mode: 'enforce', why: `last complete full run ${Math.round(h)}h ago` };
}
export function effectiveMode(laneName) { return modeDecision(laneName).mode; }
// Called after a FULL run's stale checks passed (ci.sh, and the daemon nightly).
export function fullDone(o) {
  const ln = lane(o);
  fs.mkdirSync(LEDGER, { recursive: true });
  const f = path.join(LEDGER, `full-${HOST}.tsv`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, 'at\tlane\thead\n');
  fs.appendFileSync(f, [new Date().toISOString(), ln.name, head().slice(0, 12)].join('\t') + '\n');
  console.log(`tracegate (${ln.name}): full run recorded — the next gate may enforce for ${FULL_RUN_MAX_HOURS}h.`);
}

// ── select: the files this gate must run ─────────────────────────────────────
// Why a file runs, with the per-test detail (which function, which constant)
// folded away, so the gate can say WHICH changed file drove a wide selection.
export function reasonKey(r) {
  return String(r)
    .replace(/^executed function .* in (\S+)$/, 'executed code in $1')
    .replace(/^constant \S+ in (\S+)$/, 'constant in $1')
    .replace(/^footprint commit \S+ unavailable$/, 'footprint commit unavailable')
    .replace(/^predictor error: [\s\S]*/, 'predictor error');
}
const REASONS_TOP = 10;
export function select(o) {
  const ln = lane(o);
  const run = o.run; if (!run) throw new Error('--run <dir> is required');
  const mode = o.mode || effectiveMode(ln.name);
  if (mode === 'shadow') { const d = modeDecision(ln.name); if (d.full) console.log(`tracegate (${ln.name}): running the FULL lane — ${d.why}.`); }
  const auditRate = o.audit === undefined ? entryBar(ln.name).auditRate : Number(o.audit);
  const H = head(); const lock = lockHash(ln);
  const files = allTestFiles(ln);
  const out = { lane: ln.name, mode, head: H, at: new Date().toISOString(), auditRate, decisions: {} };
  const selected = [];
  const why = new Map();
  let reuse = 0, audit = 0;
  for (const f of files) {
    let d; try { d = decide(f, H, process.version, lock, ln.name); } catch (e) { d = { run: true, reason: `predictor error: ${e.message}` }; }
    if (!d.run) {
      reuse++;
      if (mode === 'enforce' && Math.random() < auditRate) { d.audit = true; audit++; }
    }
    out.decisions[f] = d;
    if (d.run) { const k = reasonKey(d.reason); why.set(k, (why.get(k) ?? 0) + 1); }
    if (mode !== 'enforce' || d.run || d.audit) selected.push(f);
  }
  const top = [...why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, REASONS_TOP);
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'predict.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(run, 'selected.txt'), selected.map((f) => path.join(ROOT, f)).join('\n') + (selected.length ? '\n' : ''));
  // One row per gate, so a week of gates says what makes selections wide (ADR 0880).
  fs.mkdirSync(LEDGER, { recursive: true });
  const rl = path.join(LEDGER, `reasons-${HOST}.tsv`);
  if (!fs.existsSync(rl)) fs.writeFileSync(rl, 'at\tlane\tmode\thead\tfiles\tmust_run\ttop\n');
  fs.appendFileSync(rl, [out.at, ln.name, mode, H.slice(0, 12), files.length, files.length - reuse, JSON.stringify(top)].join('\t') + '\n');
  const bar = entryBar(ln.name);
  if (mode === 'enforce') {
    console.log(`tracegate (${ln.name}, enforce): running ${selected.length} of ${files.length} files — ${reuse - audit} verdicts reused, ${audit} of those re-run as an audit.`);
  } else {
    console.log(`tracegate (${ln.name}, ${mode}): ${reuse} of ${files.length} files could reuse a verdict at ${H.slice(0, 9)} — this gate still runs all of them.`);
    console.log(`tracegate (${ln.name}): entry bar for enforcement — ${bar.observations}/${bar.bar.observations} observations over ${bar.spanDays}/${bar.bar.days} days, ${bar.recentMiss ? 'a MISS in the last 14 days' : 'no recent miss'}.`);
  }
  if (top.length) {
    console.log(`tracegate (${ln.name}): why ${files.length - reuse} file(s) must run (top ${Math.min(5, top.length)} of ${why.size} reasons):`);
    for (const [k, n] of top.slice(0, 5)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
}

export function replay(o) {
  const ln = lane(o);
  if (!o.head || o.head === true) throw new Error('replay needs --head <commit>');
  if (!o.at || o.at === true || Number.isNaN(Date.parse(o.at))) throw new Error('replay needs --at <iso time of the gate> (footprints recorded later are not used)');
  const H = git('rev-parse', `${o.head}^{commit}`).trim();
  Object.assign(REPLAY, { at: Date.parse(o.at), drop: o.drop && o.drop !== true ? new RegExp(o.drop) : null, ignoreLock: o['ignore-lock'] === true });
  _changes.clear();
  try { return replayAt(o, ln, H); } finally { Object.assign(REPLAY, { at: null, drop: null, ignoreLock: false }); _changes.clear(); }
}
function replayAt(o, ln, H) {
  let lock = 'none';
  try { lock = crypto.createHash('sha256').update(execFileSync('git', ['-C', ROOT, 'show', `${H}:${ln.dir}/package-lock.json`], { maxBuffer: 1 << 28 })).digest('hex').slice(0, 16); } catch { /* none, as lockHash */ }
  // The test list at H, from the tree (the gate listed it with vitest at H).
  const files = process.env.OPENWOP_TRACEGATE_TEST_LIST
    ? process.env.OPENWOP_TRACEGATE_TEST_LIST.split('\n').filter(Boolean)
    : git('ls-tree', '-r', '--name-only', H, '--', ln.dir).split('\n')
      .filter((f) => /\.(test|spec)\.tsx?$/.test(f) && !f.includes('/node_modules/') && !f.startsWith(`${ln.dir}/e2e/`));
  // The Node the gate ran is not logged; the newest footprint before it was
  // recorded by an earlier gate on the same runtime, so take its node unless told.
  let node = o.node && o.node !== true ? o.node : null;
  if (!node) {
    let best = null;
    for (const f of files.slice(0, 200)) for (const fp of readFps(ln.name, f)) if (!best || fp.recordedAt > best.recordedAt) best = fp;
    node = best?.node ?? process.version;
  }
  const why = new Map(); const selected = [];
  // A file whose footprints were all recorded AFTER the gate (the ones the gate
  // used were since replaced: KEEP_PER_TEST eviction, or dropped on a failure)
  // replays as "no footprint" although the gate may have reused it. Count them,
  // so a replay says how far it can be trusted: must-run is exact only when 0.
  let evicted = 0;
  for (const f of files) {
    let d; try { d = decide(f, H, node, lock, ln.name); } catch (e) { d = { run: true, reason: `predictor error: ${e.message}` }; }
    if (d.reason === 'no footprint') { const at = REPLAY.at; REPLAY.at = null; if (readFps(ln.name, f).length) evicted++; REPLAY.at = at; }
    if (d.run) { selected.push(f); const k = reasonKey(d.reason); why.set(k, (why.get(k) ?? 0) + 1); }
  }
  const top = [...why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, REASONS_TOP);
  const res = { lane: ln.name, head: H, at: o.at, drop: REPLAY.drop?.source ?? null, ignoreLock: REPLAY.ignoreLock, node, files: files.length, mustRun: selected.length, evicted, top, selected };
  if (o.out && o.out !== true) fs.writeFileSync(o.out, JSON.stringify(res, null, 1));
  console.log(`tracegate replay (${ln.name}) ${H.slice(0, 9)} at ${o.at}${res.drop ? ` without /${res.drop}/` : ''}${res.ignoreLock ? ', lock ignored' : ''}: must run ${selected.length} of ${files.length}${evicted ? ` — ${evicted} of those only because their footprints were replaced after the gate, so the true count may be up to ${evicted} lower` : ''}; node ${node}${o.node && o.node !== true ? '' : ' (from the newest earlier footprint)'}.`);
  // A footprint DROPPED after a later failure leaves no trace at all, so even with
  // 0 replaced a replay can read a file or two high: compare scenarios with each
  // other, never one replay with a logged count. MEASURED 2026-10-23: +1..+2 on 4 gates.
  for (const [k, n] of top.slice(0, 5)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  return res;
}

// ── report: prediction vs reality ────────────────────────────────────────────
export function report(o) {
  const ln = lane(o);
  const run = o.run; if (!run) throw new Error('--run <dir> is required');
  let pred; try { pred = JSON.parse(fs.readFileSync(path.join(run, 'predict.json'), 'utf8')); } catch { console.log(`tracegate report (${ln.name}): no prediction for this run.`); return; }
  const results = loadResults(run);
  let total = 0, expected = 0, observed = 0, reusable = 0, audited = 0, totalMs = 0, runMs = 0;
  const misses = [];
  for (const [f, d] of Object.entries(pred.decisions)) {
    const r = results.get(f);
    // Selection is a plan, not proof of execution. A killed Vitest process can
    // leave no JSON, a partial file set, or a nonterminal result. Shadow needs
    // every file; enforce needs every required file and every selected audit.
    if (pred.mode !== 'enforce' || d.run || d.audit) {
      expected++;
      if (r?.status === 'passed' || r?.status === 'failed') observed++;
    }
    const ms = r?.durationMs ?? d.durationMs ?? 0;
    total++; totalMs += ms;
    if (d.run) { runMs += ms; continue; }
    reusable++;
    if (d.audit) audited++;
    if (r && r.status === 'failed') misses.push(f);
  }
  const share = totalMs ? (100 * runMs / totalMs).toFixed(1) : '0.0';
  fs.mkdirSync(LEDGER, { recursive: true });
  const complete = observed === expected && expected > 0;
  // Consumers such as the live-fetch stale check need observed full coverage,
  // not the selector's mode: enforce can select the entire lane after a global
  // invalidation. Emit before ingest removes this run directory. A complete red
  // observation is useful to the predictor but cannot license a stale check.
  const allFilesPassed = complete && expected === total
    && Object.keys(pred.decisions).every(f => results.get(f)?.status === 'passed');
  fs.writeFileSync(path.join(run, 'coverage.json'), JSON.stringify({
    version: 1, total, expected, observed, allFilesPassed,
  }) + '\n');
  // The entry bar consumes this log. An incomplete run or a wholly reused lane
  // supplies no new complete prediction observation and must not advance it.
  if (complete) {
    const shadowLog = path.join(LEDGER, `shadow-${HOST}.tsv`);
    if (!fs.existsSync(shadowLog)) fs.writeFileSync(shadowLog, 'at\tlane\tmode\thead\tfiles\tmust_run\treusable\taudited\trun_time_pct\tmisses\n');
    fs.appendFileSync(shadowLog, [new Date().toISOString(), ln.name, pred.mode, pred.head.slice(0, 12), total, total - reusable, reusable, audited, share, misses.length].join('\t') + '\n');
  }
  // Any file that failed here must run next time, whatever happens to ingest.
  for (const [f, r] of results) if (r.status === 'failed') dropFps(ln.name, f);
  if (misses.length) {
    const ml = path.join(LEDGER, `misses-${HOST}.tsv`);
    if (!fs.existsSync(ml)) fs.writeFileSync(ml, 'at\tlane\thead\tfile\treason\n');
    for (const m of misses) fs.appendFileSync(ml, [new Date().toISOString(), ln.name, pred.head.slice(0, 12), m, pred.decisions[m].reason].join('\t') + '\n');
    // A missed file must never be reused again on the footprint that lied.
    for (const m of misses) dropFps(ln.name, m);
  }
  // ci.sh re-runs each miss alone before the gate exits (tg_recheck_misses).
  fs.writeFileSync(path.join(o.run, 'misses.txt'), misses.map((m) => `${m}\n`).join(''));
  if (expected === 0) {
    console.log(`tracegate (${ln.name}, ${pred.mode}): no tests selected; ${reusable} verdicts reused; no new observation recorded.`);
  } else if (!complete) {
    console.log(`tracegate (${ln.name}, ${pred.mode}): incomplete — ${observed} of ${expected} selected files have terminal results; no complete observation recorded.`);
  } else if (pred.mode === 'enforce') {
    console.log(`tracegate (${ln.name}, enforce): ran ${total - reusable} files that needed it + ${audited} audits; reused ${reusable - audited} of ${total} verdicts (the run cost ${share}% of the lane's full test time, before audits).`);
  } else {
    console.log(`tracegate (${ln.name}, ${pred.mode}): only ${total - reusable} of ${total} files needed to run (${share}% of the lane's test time); ${reusable} verdicts were reusable.`);
  }
  if (misses.length) {
    console.log(`\x1b[31mtracegate (${ln.name}): ${misses.length} MISS(ES) — a file predicted reusable FAILED. Unless it passes when re-run alone at this tree (the gate does that next), that is a hole in its footprint (ADR 0880 §Soundness): enforcement is suspended for this lane for ${MISS_SUSPEND_DAYS} days; file it against the recorder:\x1b[0m`);
    for (const m of misses) console.log(`  ${m}  (${pred.decisions[m].reason})`);
  } else if (complete) {
    console.log(`tracegate (${ln.name}): 0 misses.`);
  }
}

// ── sync (P4): share the ledger with another machine ─────────────────────────
// Footprints and blobs are content-addressed and immutable, so a union is always
// correct; logs are per host (`shadow-<host>.tsv`), so they never collide.
export function sync(o) {
  const remote = o.remote || readConfig().sync;
  if (!remote) { console.log('tracegate sync: no --remote and no "sync" in ledger config.json — nothing to do.'); return; }
  fs.mkdirSync(path.join(LEDGER, 'fp'), { recursive: true });
  fs.mkdirSync(path.join(LEDGER, 'blobs'), { recursive: true });
  const r = remote.replace(/\/+$/, '');
  const rs = (...a) => { try { execFileSync('rsync', ['-a', ...a], { stdio: ['ignore', 'inherit', 'inherit'] }); return true; } catch { return false; } };
  let ok = true;
  for (const d of ['fp', 'blobs']) {
    // Ours first: rsync creates their directory if this is a brand-new ledger.
    ok = rs('--ignore-existing', `${LEDGER}/${d}/`, `${r}/${d}/`) && ok; // ours → theirs
    ok = rs('--ignore-existing', `${r}/${d}/`, `${LEDGER}/${d}/`) && ok; // theirs → ours
  }
  // Their logs (never our own name), then ours to them.
  ok = rs(`--exclude=shadow-${HOST}.tsv`, `--exclude=misses-${HOST}.tsv`, `--exclude=triage-${HOST}.tsv`, `--exclude=reasons-${HOST}.tsv`, `--exclude=escalations-${HOST}.tsv`, '--include=shadow-*.tsv', '--include=misses-*.tsv', '--include=triage-*.tsv', '--include=reasons-*.tsv', '--include=escalations-*.tsv', '--exclude=*', `${r}/`, `${LEDGER}/`) && ok;
  const mine = [`shadow-${HOST}.tsv`, `misses-${HOST}.tsv`, `triage-${HOST}.tsv`, `reasons-${HOST}.tsv`, `escalations-${HOST}.tsv`].map((f) => path.join(LEDGER, f)).filter((f) => fs.existsSync(f));
  if (mine.length) ok = rs(...mine, `${r}/`) && ok;
  console.log(`tracegate sync: ${ok ? 'ledger exchanged with' : 'PARTIAL exchange with'} ${remote}`);
  if (!ok) process.exitCode = 1;
}
// ── triage: record a verdict on a miss ───────────────────────────────────────
// `triage --lane <l> --file <path> --verdict flake|hole [--head <sha12>]`. A
// `hole` is a real footprint gap (fix the recorder); a `flake` is a test that
// fails on its own (fix or quarantine the test). Only `flake` lifts a suspension.
export function triage(o) {
  const ln = lane(o);
  if (!o.file || !['flake', 'hole'].includes(o.verdict)) throw new Error('triage needs --file <path> and --verdict flake|hole');
  const misses = readTsv('misses-').filter((m) => m.lane === ln.name && m.file === o.file && (!o.head || m.head === o.head));
  if (!misses.length) { console.log(`tracegate triage: no logged miss for ${o.file}${o.head ? ` at ${o.head}` : ''}.`); process.exitCode = 1; return; }
  const t = path.join(LEDGER, `triage-${HOST}.tsv`);
  if (!fs.existsSync(t)) fs.writeFileSync(t, 'at\tlane\tfile\thead\tverdict\n');
  for (const m of misses) fs.appendFileSync(t, [new Date().toISOString(), ln.name, m.file, m.head, o.verdict].join('\t') + '\n');
  console.log(`tracegate triage: ${misses.length} miss(es) for ${o.file} marked ${o.verdict}.`);
}

// ── red: Red Reader packets and escalate-only opinions (ADR 0980 P1) ─────────
// The vendored tracegate-ci `red.mjs` does the work. Its context is pointed at
// THIS repo's root, ledger and host before its first use, so its packets and its
// `escalations-<host>.tsv` sit beside the logs this predictor reads.
//   red write --lane <l> --run <dir> [--rechecks <file>] [--base <ref>]
//   red list [--n 20] | red show <id> | red score
//   red annotate <id> --verdict real|flake-suspect|infra|unclear --escalate true|false
//                     --confidence 0..1 --reasons "<text>" [--by <who>]
// An opinion can only ESCALATE: `real`, escalated, confidence >= 0.7, on a file that
// was a MISS, writes an `escalations-` row the entry bar reads as `hole`. Nothing
// lowers a verdict; a person's later `triage --verdict flake` has the last word.
export async function redCmd(sub, o, id) {
  process.env.TRACEGATE_ROOT = ROOT;
  process.env.TRACEGATE_LEDGER = LEDGER;
  process.env.TRACEGATE_HOST = HOST;
  const red = await import('./vendor/tracegate-ci/src/red.mjs');
  if (sub === 'write') {
    if (!o.lane || !o.run) throw new Error('red write needs --lane <l> --run <dir>');
    const rechecks = {};
    if (o.rechecks) { try { for (const l of fs.readFileSync(o.rechecks, 'utf8').split('\n')) { const [f, v] = l.split('\t'); if (f && (v === 'passed' || v === 'failed')) rechecks[f] = v; } } catch { /* none */ } }
    const p = red.writePacket({ lane: o.lane, run: o.run, base: o.base, rechecks });
    console.log(`tracegate (${o.lane}): red packet ${p.id} — ${p.failedCount} failed file(s). An agent can read it with \`node scripts/tracegate.mjs red show ${p.id}\` and give an escalate-only opinion (scripts/vendor/tracegate-ci/agents/red-reader.md).`);
    return p;
  }
  if (sub === 'annotate') {
    const rec = red.annotate({ id, verdict: o.verdict, escalate: o.escalate === true || o.escalate === 'true' ? true : o.escalate === 'false' ? false : o.escalate,
      confidence: Number(o.confidence), reasons: o.reasons, ...(o.owner ? { owner: o.owner } : {}), by: o.by ?? 'cli' });
    console.log(`tracegate red: opinion on ${rec.id}: ${rec.verdict}${rec.escalate ? ' (escalate)' : ''}${rec.escalated.length ? ` — raised to HOLE: ${rec.escalated.join(', ')}` : ''}`);
    return rec;
  }
  if (sub === 'list') { for (const r of red.listRed(Number(o.n ?? 20))) console.log(`${r.opinion?.escalate ? '!' : ' '} ${r.at}  ${r.id}  failed ${r.failed}, misses ${r.misses}${r.opinion ? `  → ${r.opinion.verdict} (${r.opinion.confidence}) by ${r.opinion.by}` : '  (no opinion)'}`); return; }
  if (sub === 'show') { console.log(JSON.stringify(red.readPacket(id), null, 2)); return; }
  if (sub === 'score') { console.log(JSON.stringify(red.score(), null, 2)); return; }
  throw new Error('usage: tracegate.mjs red write|list|show <id>|annotate <id>|score');
}

function readConfig() { try { return JSON.parse(fs.readFileSync(path.join(LEDGER, 'config.json'), 'utf8')); } catch { return {}; } }

function status() {
  const count = (d) => { try { return fs.readdirSync(path.join(LEDGER, d), { recursive: true }).filter((f) => String(f).endsWith('.json.gz')).length; } catch { return 0; } };
  console.log(`ledger: ${LEDGER}\nfootprints: ${count('fp')}  blobs: ${count('blobs')}`);
  for (const ln of Object.keys(LANES)) {
    const b = entryBar(ln);
    console.log(`${ln}: mode ${effectiveMode(ln)} (${modeDecision(ln).why}) · entry bar ${b.ok ? 'MET' : 'not met'} (${b.observations}/${b.bar.observations} observations, ${b.spanDays}/${b.bar.days} days, misses: ${b.missesTotal}${b.recentMiss ? ', one in the last 14 days' : ''}; audit ${Math.round(b.auditRate * 100)}% once enforcing)`);
  }
  const rows = readTsv('shadow-').slice(-8);
  if (rows.length) { console.log('\nlast observations:'); for (const r of rows) console.log(`  ${r.at}  ${r.lane.padEnd(8)} ${r.mode.padEnd(7)} ${r.head}  must-run ${r.must_run}/${r.files}  time ${r.run_time_pct}%  misses ${r.misses}`); }
}

if (isEntryModule(import.meta.url)) {
  const cmd = process.argv[2];
  const o = args();
  if (cmd === 'mode') console.log(effectiveMode(lane(o).name));
  else if (cmd === 'select') select(o);
  else if (cmd === 'ingest') ingest(o);
  else if (cmd === 'report') report(o);
  else if (cmd === 'status') status();
  else if (cmd === 'sync') sync(o);
  else if (cmd === 'triage') triage(o);
  else if (cmd === 'full-done') fullDone(o);
  else if (cmd === 'replay') replay(o);
  else if (cmd === 'red') { const id = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : undefined; await redCmd(process.argv[3], id ? args4() : o, id).catch((e) => { console.error(String(e.message ?? e)); process.exitCode = 1; }); }
  else { console.error('usage: tracegate.mjs mode|select|ingest|report --lane <backend|frontend> --run <dir>  |  status  |  sync --remote <host:path>  |  triage --lane <l> --file <f> --verdict flake|hole  |  full-done --lane <l>  |  replay --lane <l> --head <commit> --at <iso> [--drop <regex>] [--ignore-lock] [--node <v>] [--out <json>]'); process.exit(2); }
}
