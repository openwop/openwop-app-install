#!/usr/bin/env node
// ADR 0971 — how many Vitest workers a gate lane should use on THIS machine, now.
//
// Vitest's default in a run is (cores − 1), whatever else the machine is doing.
// The gate already narrows one case by hand (the frontend lane is capped at 4
// while a background lane runs, slot 77); this generalises it from measurement:
// busy cores that are not this lane's, available memory, the kernel's memory
// pressure, swap-ins and a thermal limit, read on whatever machine runs the gate.
//
//   decide --lane <l> [--cap N]      print "<suggested> <apply> <runs> <why…>" on stdout and
//                                    one log line on stderr. <apply> is the width to
//                                    set, or "-" for "leave the lane's width alone".
//   watch  (--pid P | --parent) --out F
//                                    record the peak RSS (MB) of P's process tree in
//                                    F every 5 s; exits when P does. --parent watches
//                                    the shell that started the watcher, which is how
//                                    ci.sh names a lane's subshell (bash 3.2 has no
//                                    $BASHPID, and `sh -c 'echo $PPID'` inside $(…)
//                                    names an intermediate fork; MEASURED).
//   record --lane <l> --suggested S --used U --rc R --secs T [--peak-file F] [--why W]
//                                    append one row to <ledger>/ci-width-<host>.tsv
//   report                           summarise those rows per lane
//
// OPENWOP_CI_ADAPTIVE = on (default since P2) | shadow | off
//   on      the lane runs at the suggested width.
//   shadow  decide, log and record; the lane runs at its old width.
//   off     nothing runs.
// OPENWOP_CI_ADAPTIVE_MIN   the floor (default 2, never above the default width).
// OPENWOP_CI_WORKER_MB      memory per worker; default: p90 of this host's measured
//                           peaks per worker for the lane, else half of RAM per core.
//
// Every failure here prints and falls back to "-": this tool can narrow a lane,
// never fail one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapt, deriveDefaults, resolvePolicy } from './vendor/tracegate-ci/src/broker/adapt.mjs';
import { hardware, parsePs, sample, treeRss } from './vendor/tracegate-ci/src/broker/sampler.mjs';

const HOST = (process.env.OPENWOP_TRACEGATE_HOST || os.hostname().split('.')[0] || 'host').replace(/[^A-Za-z0-9_-]/g, '_');
// P2 (ADR 0971, user decision 2026-10-24): `on` by default. OPENWOP_CI_ADAPTIVE=shadow reverts.
const MODE = ['on', 'shadow', 'off'].includes(process.env.OPENWOP_CI_ADAPTIVE) ? process.env.OPENWOP_CI_ADAPTIVE : 'on';
const KEEP = 20; // rows per lane that the learned memory per worker reads

function ledger() {
  if (process.env.OPENWOP_CI_WIDTH_LEDGER) return path.resolve(process.env.OPENWOP_CI_WIDTH_LEDGER);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return path.join(common, 'tracegate');
}
const tsvPath = () => path.join(ledger(), `ci-width-${HOST}.tsv`);
const COLS = ['at', 'lane', 'mode', 'default', 'suggested', 'used', 'rc', 'secs', 'peakMB', 'why'];

function rows() {
  let text = '';
  try { text = fs.readFileSync(tsvPath(), 'utf8'); } catch { return []; }
  return text.split('\n').slice(1).filter(Boolean).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [COLS[i], v])));
}

/** p90 of this host's measured peak MB per worker for the lane, or null. Pure over `all`. */
export function learnedWorkerMB(all, lane) {
  const per = all.filter((r) => r.lane === lane && Number(r.rc) === 0 && Number(r.peakMB) > 0 && Number(r.used) > 0)
    .slice(-KEEP).map((r) => Number(r.peakMB) / Number(r.used)).sort((a, b) => a - b);
  return per.length >= 2 ? Math.ceil(per[Math.min(per.length - 1, Math.ceil(0.9 * per.length) - 1)]) : null;
}

/**
 * The width for one lane. Pure. `def` is Vitest's default (cores − 1), `cap` a
 * width the gate already imposes (or null), `d` the policy's decision for
 * `nominal = def`, `workerMB` the memory one worker is expected to take.
 */
export function widthFor({ def, cap, d, workerMB, min }) {
  const why = [...d.why];
  let w = Math.min(def, cap ?? Infinity, d.cpu);
  if (Number.isFinite(d.memMB) && workerMB > 0) {
    const byMem = Math.floor(d.memMB / workerMB);
    if (byMem < w) { w = byMem; why.push(`memory for ${byMem} worker(s) at ~${workerMB} MB each`); }
  }
  const floor = Math.max(1, Math.min(min, def));
  if (w < floor) { why.push(`floor ${floor}`); w = floor; }
  return { width: w, why };
}

async function decide(o) {
  const lane = String(o.lane ?? 'lane');
  const hw = await hardware();
  const def = Math.max(1, hw.cores - 1);
  const cap = Number(o.cap) > 0 ? Number(o.cap) : null;
  if (MODE === 'off') { process.stdout.write(`- - - -\n`); return; }
  const policy = deriveDefaults(resolvePolicy({ minTokens: 1 }), hw);
  // Two readings 1 s apart: busy cores over that second, and the lower of two
  // memory readings (a cache flush between them opens nothing).
  await sample([]);
  await new Promise((r) => setTimeout(r, 1000));
  const s = await sample([]);
  const d = adapt(policy, s, null, { usedTokens: 0, reservedMB: 0, growthMB: 0 }, def, Date.now());
  const learned = learnedWorkerMB(rows(), lane);
  const workerMB = Number(process.env.OPENWOP_CI_WORKER_MB) > 0 ? Number(process.env.OPENWOP_CI_WORKER_MB) : learned ?? policy.defaultTokenMB;
  const min = Number(process.env.OPENWOP_CI_ADAPTIVE_MIN) > 0 ? Number(process.env.OPENWOP_CI_ADAPTIVE_MIN) : 2;
  const { width, why } = widthFor({ def, cap, d, workerMB, min });
  const runs = cap ?? def;
  const read = `${s.cores} cores, ${Number.isFinite(s.busyCores) ? `${s.busyCores.toFixed(1)} busy` : `load ${s.load1?.toFixed(1)}`}, ${s.availMB ?? '?'} MB available, pressure ${s.pressure ?? 'unknown'}`;
  const verb = MODE === 'on' ? 'runs' : 'would run';
  process.stderr.write(`adaptive width (${lane}, ${MODE}): ${verb} ${width} of ${def} worker(s)${cap ? ` (gate cap ${cap})` : ''}${MODE === 'shadow' ? `; runs ${runs} as before` : ''} — ${read}; ~${workerMB} MB/worker (${learned ? 'learned here' : 'derived from RAM per core'})${why.length ? `; ${why.join('; ')}` : ''}\n`);
  process.stdout.write(`${width} ${MODE === 'on' ? width : '-'} ${MODE === 'on' ? width : runs} ${why.join('; ').replace(/[\t\n]/g, ' ') || '-'}\n`);
}

async function watch(o) {
  const pid = o.parent ? process.ppid : Number(o.pid); const out = String(o.out);
  if (!(pid > 1) || !out) throw new Error('watch needs --pid and --out');
  let peak = 0;
  for (;;) {
    try { process.kill(pid, 0); } catch { return; }
    try {
      const procs = parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }));
      procs.delete(process.pid); // not the watcher itself
      const mb = treeRss(procs, [pid])[pid];
      if (Number.isFinite(mb) && mb > peak) { peak = mb; fs.writeFileSync(out, String(peak)); }
    } catch { /* one missed reading */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function record(o) {
  let peak = '';
  try { peak = fs.readFileSync(String(o['peak-file']), 'utf8').trim(); } catch { /* none */ }
  const why = String(o.why === true || o.why === undefined ? '' : o.why).replace(/[\t\n]/g, ' ');
  const f = tsvPath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, COLS.join('\t') + '\n');
  const def = Math.max(1, (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) - 1);
  fs.appendFileSync(f, [new Date().toISOString(), o.lane, MODE, def, o.suggested, o.used, o.rc, o.secs, peak, why].join('\t') + '\n');
}

function report() {
  const all = rows();
  if (!all.length) { console.log(`no rows yet in ${tsvPath()}`); return; }
  const lanes = [...new Set(all.map((r) => r.lane))];
  for (const l of lanes) {
    const r = all.filter((x) => x.lane === l);
    const narrower = r.filter((x) => Number(x.suggested) < Number(x.used));
    const red = (xs) => xs.filter((x) => Number(x.rc) !== 0).length;
    console.log(`${l}: ${r.length} run(s); suggested narrower than used in ${narrower.length} (red ${red(narrower)}), otherwise red ${red(r) - red(narrower)} of ${r.length - narrower.length}; learned ${learnedWorkerMB(all, l) ?? '—'} MB/worker`);
  }
}

const [cmd, ...argv] = process.argv.slice(2);
const o = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
const main = async () => {
  if (cmd === 'decide') await decide(o);
  else if (cmd === 'watch') await watch(o);
  else if (cmd === 'record') record(o);
  else if (cmd === 'report') report();
  else throw new Error(`unknown command ${cmd ?? '(none)'}; use decide | watch | record | report`);
};
// Run only as a script: the test imports the pure functions above.
const realArgv1 = (() => { try { return fs.realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
// Real paths on both sides: import.meta.url is resolved, argv[1] may not be (a
// symlinked checkout, or /var → /private/var on macOS; MEASURED by the test).
if (realArgv1 && import.meta.url === pathToFileURL(realArgv1).href) {
  main().catch((e) => {
    process.stderr.write(`adaptive width: ${e.message} (ignored; the lane keeps its width)\n`);
    if (cmd === 'decide') process.stdout.write('- - - -\n');
    process.exitCode = 0;
  });
}
