// ADR 0880 — Tracegate recorder, shared by every vitest lane (backend, frontend).
//
// A lane's setup file calls `installRecorder({ afterAll, expect, repoRoot, laneDir })`
// when `OPENWOP_TRACEGATE_RECORD=<dir>` is set. For each test file it writes one
// raw footprint to `<dir>/raw/`:
//   exec   — per module, the source lines where an EXECUTED function starts;
//   loaded — every repo module the file evaluated;
//   reads  — every repo file the worker read or listed (symlinks resolved).
// `scripts/tracegate.mjs ingest` turns these into ledger entries after the run.
//
// It never changes what a test sees: no mocks, no return values, no timing it
// can avoid. Plain JS with node builtins only, so it loads in any lane.
//
// HOW COVERAGE IS MAPPED WITHOUT A DEBUGGER. V8 reports function offsets into the
// script it compiled. Vitest compiles each module with
//     vm.runInThisContext(`'use strict';async (<args>)=>{{<code>\n}}`, { filename })
// through its DEFAULT `vm` import, so a property patch on `vm.runInThisContext`
// sees that exact text at call time. The recorder keeps the text's line table and
// the inline source map of <code>, and maps each executed function's offset back
// to a source line (the wrapper shifts line 0 only, exactly as vitest's own
// `columnOffset` says). The first version used `Debugger.enable` +
// `getScriptSource` instead; MEASURED on 39 files that cost +90% wall time
// (ADR 0880 §Overhead). A capture through the transform cache's `readFileSync`
// was tried next and saw NOTHING: vitest's bundle binds `readFileSync` before any
// setup file runs, so patching it is invisible there.
//
// Nothing is assumed: a module with no captured text or no source map is
// reported as `unmapped`, and the predictor treats any change to an unmapped
// module the test loaded as "run". A vitest upgrade that moves this seam degrades
// to SAFE, and the shadow report prints the unmapped share so it is noticed.
import { Session } from 'node:inspector/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import vm from 'node:vm';
import childProcess from 'node:child_process';

const WRAP_HEAD = "'use strict';async (";
const FS_SYNC = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'accessSync', 'opendirSync', 'createReadStream'];
const FS_CB = ['readFile', 'readdir', 'stat', 'lstat', 'access', 'open', 'opendir'];
const FSP = ['readFile', 'readdir', 'stat', 'lstat', 'access', 'open', 'opendir'];

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Int8Array(128).fill(-1); for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;

/** Decode one generated line of a v3 `mappings` string into [genCol, srcIdx, srcLine][] (absolute). */
function decodeLine(seg, state) {
  const out = [];
  let col = 0;
  for (const s of seg.split(',')) {
    if (!s) continue;
    const vals = []; let v = 0, shift = 0;
    for (let i = 0; i < s.length; i++) {
      const d = B64I[s.charCodeAt(i)];
      v += (d & 31) << shift;
      if (d & 32) { shift += 5; continue; }
      vals.push(v & 1 ? -(v >>> 1) : v >>> 1); v = 0; shift = 0;
    }
    col += vals[0];
    if (vals.length >= 4) { state.src += vals[1]; state.line += vals[2]; out.push([col, state.src, state.line]); }
  }
  return out;
}

export class ModuleMap {
  constructor(code) {
    this.len = code.length;
    // vitest's wrapper is prepended to line 0; the source map describes <code>.
    this.prefix = code.startsWith(WRAP_HEAD) ? code.indexOf(')=>{{') + 5 : 0;
    const ls = [0];
    for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) ls.push(i + 1);
    this.lineStarts = Uint32Array.from(ls);
    this.lines = null; // decoded lazily: index → [genCol, srcIdx, srcLine][]
    const at = code.lastIndexOf('//# sourceMappingURL=data:application/json');
    const m = at >= 0 ? /^\/\/# sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/.exec(code.slice(at)) : null;
    let map = null;
    if (m) { try { map = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { map = null; } }
    this.mappings = map?.mappings?.split(';') ?? null;
  }
  /** Original 1-based source line for a 0-based offset into the code, or null. */
  originalLine(offset) {
    if (!this.mappings) return null;
    if (!this.lines) {
      // Decoding is stateful across lines, so decode all once (per module per worker).
      const st = { src: 0, line: 0 };
      this.lines = this.mappings.map((seg) => decodeLine(seg, st));
    }
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    const col = offset - this.lineStarts[lo] - (lo === 0 ? this.prefix : 0);
    const segs = this.lines[lo] ?? [];
    let best = null;
    for (const s of segs) { if (s[0] <= col) best = s; else break; }
    if (!best && segs.length) best = segs[0];
    return best ? best[2] + 1 : null;
  }
}

// ADR 0968 P2 — BOOT PHASE (shadow data only; no decision reads it yet).
// RECORDED ONLY WHEN `OPENWOP_TRACEGATE_BOOT=1`, which only the background
// daemon sets (user decision 2026-10-24): it needs count-mode coverage (see
// init), which MEASURED +12.5% backend wall on a quiet box (130.3 s → 146.7 s,
// 127 files, ranges disjoint). Unset — every gate — the recorder is main's:
// binary coverage, no hook, one take per file.
// A lane may mark app boot by calling `globalThis.__tracegateBoot('start')` on
// entry to its boot function and `('end', app)` on return (the backend's
// createApp does; the hook is undefined unless this recorder is installed).
// Each mark takes coverage and moves the reads seen so far, so a footprint can
// say which functions and reads happened ONLY inside boot. A coverage take
// snapshots AND resets at the call, even un-awaited (MEASURED 2026-10-23), so
// the start mark never awaits.
// A take reports a script's top-level function only in the window that ran it
// (MEASURED 2026-10-23: after a reset, a later window lists the inner functions
// that ran and omits the top level). That function is what gives the script's
// length, which is how a script is matched to its source. So a window is folded
// raw, by scriptId, and lengths are resolved once at afterAll from whichever
// window saw each top level. Resolved that way, the UNION of the windows is what
// one take at afterAll would have reported.
function newAcc() { return { loaded: new Set(), scripts: new Map() }; }
function fold(st, result, acc) {
  const filePrefix = 'file://' + st.repoRoot + '/';
  for (const s of result) {
    if (!s.url.startsWith(filePrefix) || s.url.includes('/node_modules/')) continue;
    const file = decodeURIComponent(s.url.slice(filePrefix.length)).split('?')[0];
    if (file === st.bootDigestFile) continue; // the digest's own module (see the boot marks)
    acc.loaded.add(file);
    if (!file.startsWith(st.srcPrefix) || /\.(test|spec)\.tsx?$/.test(file)) continue; // test-side modules are tracked whole
    const r0 = s.functions[0]?.ranges[0];
    if (r0 && r0.startOffset === 0) st.lens.set(s.scriptId, r0.endOffset);
    let e = acc.scripts.get(s.scriptId);
    if (!e) { e = { file, offs: new Set() }; acc.scripts.set(s.scriptId, e); }
    for (let i = 1; i < s.functions.length; i++) {
      const r = s.functions[i].ranges[0];
      if (r && r.count > 0) e.offs.add(r.startOffset);
    }
    // functions[0] is an inner function when the top level is absent: count it too.
    if (r0 && r0.startOffset !== 0 && r0.count > 0) e.offs.add(r0.startOffset);
  }
}
/** Resolve folded windows to { loaded, exec, unmapped } against the module map. */
function resolveAcc(st, ...accs) {
  const loaded = new Set(); const exec = new Map(); const unmapped = new Set();
  for (const acc of accs) {
    for (const f of acc.loaded) loaded.add(f);
    for (const [id, e] of acc.scripts) {
      const mm = st.modules.get(path.join(st.repoRoot, e.file));
      if (!mm || mm.len !== st.lens.get(id)) { unmapped.add(e.file); continue; }
      let o = exec.get(e.file);
      if (!o) { o = { code: mm.sha, offs: new Set() }; exec.set(e.file, o); }
      for (const v of e.offs) o.offs.add(v);
    }
  }
  for (const f of unmapped) exec.delete(f);
  return { loaded, exec, unmapped };
}
const execJson = (r) => Object.fromEntries([...r.exec].map(([f, e]) => [f, { code: e.code, offs: [...e.offs].sort((x, y) => x - y) }]));

export async function installRecorder({ afterAll, expect, repoRoot, laneDir, bootDigest, bootDigestFile }) {
  const outDir = process.env.OPENWOP_TRACEGATE_RECORD;
  if (!outDir) return;
  const g = globalThis;
  if (!g.__tracegate) g.__tracegate = await init(outDir, repoRoot, laneDir);
  const st = g.__tracegate;
  // Module evaluation for this test file happens AFTER the setup files load, so
  // from here on, reads and executed functions belong to this file.
  // Coverage is NOT reset here: the previous file's afterAll take already reset
  // it, and whatever ran in between (its teardown, these setup files) is then
  // counted for this file. That can only ADD functions to a footprint, i.e. cause
  // extra runs, never hide one; and it saves one take (~0.4 s on an app test).
  st.reads.clear();
  st.resetSubprocess();
  st.bootDigest = st.bootOn ? bootDigest : undefined;
  st.bootDigestFile = bootDigestFile;
  st.test = newAcc(); st.boot = newAcc(); st.lens = new Map(); st.testReads = new Set(); st.bootReads = new Set(); st.bootN = 0; st.digests = []; st.bootErr = null; st.pending = [];
  // ADR 0968 correction (2026-10-27): the window before a file's FIRST 'start' mark is
  // module IMPORT. This app registers its features when their modules evaluate, so
  // filing that window as test phase made every feature module look test-used, and
  // the boot shadow absorbed 0 of 2,752 invalidations in its first week. It is kept
  // apart here; ingest decides which of it is boot (app source) and which is test.
  st.imp = newAcc(); st.impReads = new Set(); st.impDone = false;
  // A lane's later setup file may attach key-level i18n reads (frontend:
  // src/test/tracegate-i18n-recorder.ts); null is "not recorded", never "none read".
  st.i18n = null;

  afterAll(async () => {
    const testPath = expect.getState().testPath ?? '';
    await Promise.all(st.pending); // every boot mark's take has been folded
    const { result } = await st.session.post('Profiler.takePreciseCoverage');
    fold(st, result, st.test);
    for (const r of st.reads) st.testReads.add(r);
    const all = resolveAcc(st, st.test, st.boot, st.imp); // the footprint is the union of every window
    const testFile = testPath.startsWith(st.repoRoot + '/') ? testPath.slice(st.repoRoot.length + 1) : testPath;
    // Boot shadow data (ADR 0968 P2): present only when the lane marked a boot.
    let boot;
    if (st.bootN || st.bootErr) {
      boot = { n: st.bootN, exec: execJson(resolveAcc(st, st.boot)), testExec: execJson(resolveAcc(st, st.test)), reads: [...st.bootReads].sort(), testReads: [...st.testReads].sort(), digests: st.digests, impExec: execJson(resolveAcc(st, st.imp)), impReads: [...st.impReads].sort(), ...(st.bootErr ? { error: st.bootErr } : {}) };
    }
    const out = { v: 3, testFile, node: process.version, subprocess: st.usedSubprocess(), loaded: [...all.loaded].sort(), exec: execJson(all), unmapped: [...all.unmapped], reads: [...new Set([...st.testReads, ...st.bootReads, ...st.impReads])].sort(),
      ...(st.i18n ? { i18n: { keys: [...st.i18n.keys].sort(), whole: [...st.i18n.whole].sort() } } : {}), ...(boot ? { boot } : {}) };
    const name = createHash('sha256').update(testFile).digest('hex').slice(0, 24) + '.json';
    st.write(path.join(st.outDir, 'raw', name), JSON.stringify(out));
  });
}

async function init(outDir, repoRoot, laneDir) {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  // Function granularity (detailed:false). Without boot marks, binary mode
  // (callCount:false) is V8's cheapest and exactly what a footprint needs. With
  // them (ADR 0968 P2) it must count calls: binary mode reports a function only
  // in the FIRST window it runs in, never again (MEASURED 2026-10-23 in plain
  // node), which would hide every function that ran in boot AND in the test
  // from the test phase and make the shadow call an edit to it skippable. Count
  // mode reports a function in every window it runs in. A footprint keeps only
  // count > 0, so the union over windows is the same set either mode gives for a
  // whole file (MEASURED: 126/126 identical, three pairs, 2026-10-24).
  const bootOn = process.env.OPENWOP_TRACEGATE_BOOT === '1';
  await session.post('Profiler.startPreciseCoverage', { callCount: bootOn, detailed: false });

  const reads = new Set();
  let subprocess = false;
  const modules = new Map(); // absolute source path → ModuleMap
  const realCache = new Map();
  const realpath = fs.realpathSync.native;
  const write = fs.writeFileSync; // captured before wrapping, so our own writes are not reads
  const prefixRoot = repoRoot + '/';
  const rec = (p) => {
    try {
      if (typeof p !== 'string' && !(p instanceof URL)) return;
      const abs = path.resolve(p instanceof URL ? p.pathname : p);
      let r = realCache.get(abs);
      if (r === undefined) {
        try { r = realpath(abs); } catch { r = abs; } // a probe of a missing path is still an input
        realCache.set(abs, r);
      }
      if (r.startsWith(prefixRoot) && !r.includes('/node_modules/')) reads.add(r.slice(prefixRoot.length));
    } catch { /* tracing must never change behaviour */ }
  };
  const codesDir = path.join(outDir, 'codes');
  fs.mkdirSync(codesDir, { recursive: true });
  for (const fnName of ['runInThisContext', 'runInContext']) {
    const orig = vm[fnName];
    vm[fnName] = function (code, ...rest) {
      try {
        const opts = fnName === 'runInThisContext' ? rest[0] : rest[1];
        let file = typeof opts === 'object' && opts ? opts.filename : typeof opts === 'string' ? opts : null;
        if (typeof file === 'string' && file.startsWith('file://')) file = decodeURIComponent(file.slice(7));
        // Isolation re-evaluates every module for every test file, with the SAME
        // text (the tree cannot change mid-run: H101), so each module's text is
        // hashed and written once per worker and only its id is kept after that.
        if (typeof code === 'string' && typeof file === 'string' && file.startsWith(prefixRoot) && modules.get(file)?.len !== code.length) {
          const sha = createHash('sha1').update(code).digest('hex');
          const p = path.join(codesDir, sha + '.js');
          if (!fs.existsSync(p)) { const tmp = `${p}.${process.pid}`; write(tmp, code); fs.renameSync(tmp, p); }
          modules.set(file, { len: code.length, sha });
        }
      } catch { /* recording must never change behaviour */ }
      return orig.call(this, code, ...rest);
    };
  }
  const wrap = (obj, names) => {
    for (const n of names) {
      const orig = obj[n];
      if (typeof orig !== 'function') continue;
      obj[n] = function (p, ...rest) {
        rec(p);
        return orig.call(this, p, ...rest);
      };
    }
  };
  wrap(fs, FS_SYNC);
  wrap(fs, FS_CB);
  wrap(fsp, FSP);
  // A child's history/environment/reads are opaque to this worker. Async calls
  // pass through ChildProcess.spawn, including promisify(execFile)'s custom
  // implementation; patching exported execFile would break or bypass that
  // custom return shape. Sync entry points do not use the instance method.
  const spawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function (...args) {
    subprocess = true;
    return spawn.apply(this, args);
  };
  for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function (...args) {
      subprocess = true;
      return original.apply(this, args);
    };
  }
  // Named imports of builtins (`import { readFileSync } from 'node:fs'`) bind the
  // ORIGINAL function unless this runs after patching. MEASURED: without it the
  // trace reported zero repo reads where the truth was ~857 per app test.
  syncBuiltinESMExports();

  fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true });
  const st = { session, reads, modules, repoRoot, srcPrefix: laneDir + '/src/', outDir, write, bootOn,
    resetSubprocess: () => { subprocess = false; }, usedSubprocess: () => subprocess };
  if (!bootOn) return st; // a gate: no hook, so createApp's marks are a no-op property read
  // The boot marks (see newAcc). Synchronous: never awaits, never throws, and
  // returns nothing, so createApp's scheduling is exactly what it is without them.
  // At 'end' the lane's digest runs SYNCHRONOUSLY between two takes, and that
  // window is DISCARDED with its reads: no other code can run inside a synchronous call, so it holds exactly
  // the digest's own calls, and in count mode a function the test runs later
  // is still reported then. So the digest reads the registries as boot left
  // them (MEASURED 2026-10-23: read at afterAll it differed between two runs of
  // one commit in 3 of 20 files, each a test registering random-id workflows)
  // and adds nothing to the footprint.
  globalThis.__tracegateBoot = (phase, app) => {
    try {
      if (!st.test) return; // before the first test file's install
      if (phase !== 'start' && phase !== 'end') return;
      // The first 'start' closes the import window; a later one closes a test body.
      const first = phase === 'start' && !st.impDone && st.bootN === 0;
      if (first) st.impDone = true;
      const target = first ? st.imp : phase === 'start' ? st.test : st.boot;
      const targetReads = first ? st.impReads : phase === 'start' ? st.testReads : st.bootReads;
      for (const r of reads) targetReads.add(r);
      reads.clear();
      // The take resolves later, but its snapshot (and reset) is taken now.
      st.pending.push(st.session.post('Profiler.takePreciseCoverage').then(({ result }) => fold(st, result, target), (e) => { st.bootErr = String(e?.message ?? e); }));
      if (phase !== 'end') return;
      st.bootN++;
      if (!st.bootDigest) return;
      let d;
      try { d = String(st.bootDigest(app)); } catch (e) { d = `error: ${e?.message ?? e}`; }
      st.pending.push(st.session.post('Profiler.takePreciseCoverage').then(() => {}, () => {})); // the digest's window: discarded
      reads.clear();
      st.digests.push(d);
    } catch (e) { st.bootErr = String(e?.message ?? e); }
  };
  return st;
}
