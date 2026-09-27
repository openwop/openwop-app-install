#!/usr/bin/env node
/**
 * RFC 0158 §D — the durability exercises, with a REAL process death.
 *
 * §D.9 is the requirement that dictates this file's existence and its shape:
 *
 *   > A host MUST NOT claim a rung on the basis of tests in which no process
 *   > was actually terminated.
 *
 * So there is no in-process simulation here, no fake clock, and no injected
 * "pretend the worker died" seam. This script starts the backend as a real child
 * process against a real on-disk sqlite database, `SIGKILL`s it (never SIGTERM —
 * a graceful shutdown is a different exercise and a much weaker claim), starts a
 * SECOND process on the same database, and measures how long the accepted work
 * takes to reach a terminal state after the kill.
 *
 * WHAT EACH CASE ESTABLISHES, and why they are not the same test:
 *
 *   accept    — kill immediately after `POST /v1/runs` returns 201. This probes
 *               §A durable acceptance: the run row and its dispatch-outbox row
 *               commit together (`routes/runs.ts:480`), so the work is owed
 *               before any executor touches it. Recovery here rides the OUTBOX
 *               lane, which is fast.
 *   execution — kill while a node is mid-flight. The dying instance held a
 *               dispatch lease and, since ADR 0585 P0, was renewing it. Recovery
 *               cannot begin until that lease lapses, so this rides the ORPHAN
 *               lane and is far slower. This is the case that sets the bound.
 *
 * THE MEASUREMENT IS THE POINT, NOT THE PASS. `src/host/recoveryBound.ts`
 * DERIVES a bound from the constants; this script observes what the mechanism
 * actually does. Those are two different claims and RFC 0158 §B.5 only accepts
 * the first if it matches the second. A derivation nobody checked against a
 * running system is the "claim, not a bound" the RFC forbids — so the script
 * prints the observed interval next to the derived one and fails when the
 * observation EXCEEDS the derivation. It deliberately does NOT fail when
 * recovery is faster than derived: a conservative bound is honest, an optimistic
 * one is not.
 *
 * ^ THAT PARAGRAPH WAS FALSE FROM THE DAY IT WAS WRITTEN UNTIL 2026-08-20, and
 * the way it was false is the lesson. The script imported nothing from
 * `recoveryBound.ts`, computed no derivation, and compared nothing. Its only
 * failure mode was a hard-coded 16-minute budget. So it printed `✓ RECOVERED`
 * and exited 0 while displaying a number that, read against the derivation,
 * was a bound violation. **A check that was never implemented is
 * indistinguishable from a check that passed** — the docblock asserted the
 * behaviour, and the assertion was the only place it existed.
 *
 * Both halves are now real: `derivedTermsMs()` bundles and imports the actual
 * module, and the script exits 1 when observed > derived for the class under
 * test. If you change what is measured, change this paragraph WITH it.
 *
 * WHAT IS MEASURED IS RESUMPTION, NOT COMPLETION. See the block in `main()`:
 * timing to terminal status folds the resumed run's own execution time into the
 * bound and made a conforming host look non-conforming.
 *
 *   node scripts/rfc0158-durability-exercise.mjs --case=accept
 *   node scripts/rfc0158-durability-exercise.mjs --case=execution   # ~12 min
 *
 * Not part of `npm run ci`: the execution case waits out a real 12-minute lease,
 * and the wait IS the mechanism rather than overhead — a shortened lease would
 * measure a different host than the one that ships.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CASE = (process.argv.find((a) => a.startsWith('--case=')) ?? '--case=accept').split('=')[1];
const PORT = Number(process.env.RFC0162_PORT ?? 18170);
const BASE = `http://127.0.0.1:${PORT}`;
const BACKEND = new URL('../backend/typescript', import.meta.url).pathname;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'rfc0158-'));
const DSN = `sqlite://${join(DATA_DIR, 'durability.db')}`;
const API_KEY = 'rfc0158-durability-token';

const ENV = {
  ...process.env,
  PORT: String(PORT),
  OPENWOP_STORAGE_DSN: DSN,
  OPENWOP_API_KEY: API_KEY,
  OPENWOP_SESSION_SECRET: 'rfc0158-durability-ephemeral-secret-0000000',
  OPENWOP_BYOK_ENCRYPTION_KEY: '4f2a9c1e7b3d5086af12e4c69d70b8135ea6c2947f08d31b5c6e9a074d2f8b6e',
  // A non-vitest boot re-points every ~/.openwop-packs symlink at whatever
  // checkout started it. This script does not need packs; leaving it unset would
  // corrupt other worktrees' pack mounts (CLAUDE.md).
  OPENWOP_MOUNT_LOCAL_PACKS: 'false',
  OPENWOP_RATELIMIT_DISABLED: 'true',
  OPENWOP_AUTH_DISABLE_COOKIES: 'true',
  OPENWOP_TEST_SEAM_ENABLED: 'true',
  OPENWOP_ANON_ACTOR_ENABLED: 'true',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}`, ...(init.headers ?? {}) },
  });
}

let instanceSeq = 0;
async function boot(label) {
  const n = ++instanceSeq;
  const child = spawn('node', ['lib/index.js'], { cwd: BACKEND, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const logPath = join(DATA_DIR, `instance-${n}.log`);
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.stderr.on('data', (d) => chunks.push(d));
  child.on('exit', () => writeFileSync(logPath, Buffer.concat(chunks)));
  // Wait for it to actually serve, not merely to have been spawned.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${label}: instance ${n} never served ${BASE}`);
    try {
      const r = await fetch(`${BASE}/.well-known/openwop`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  console.log(`  [instance ${n}] serving (pid ${child.pid})`);
  return { child, n, logPath };
}

/** SIGKILL, and WAIT for the OS to reap it — a kill that has not landed yet
 *  would let the old process race the new one and invalidate the whole run. */
function kill(instance) {
  return new Promise((resolve) => {
    instance.child.once('exit', (code, signal) => {
      console.log(`  [instance ${instance.n}] dead (code=${code} signal=${signal})`);
      resolve();
    });
    instance.child.kill('SIGKILL');
  });
}

async function statusOf(runId) {
  const r = await api(`/v1/runs/${encodeURIComponent(runId)}`);
  if (!r.ok) return null;
  return (await r.json()).status ?? null;
}

/**
 * The run's durable event log, which is what makes RESUMPTION observable.
 *
 * A killed run's `status` stays `running` across the kill — the dead instance
 * had already written it and no one rewrites it on death — so status polling
 * cannot see the moment another instance picks the work up. The event log can:
 * the resuming instance writes a SECOND `run.started` for the same run id.
 */
async function eventsOf(runId) {
  const r = await api(`/v1/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=0&limit=1000`);
  if (!r.ok) return null;
  return (await r.json()).events ?? [];
}

/**
 * The pre-kill read, which MUST NOT be allowed to fail quietly.
 *
 * The first version of this returned `[]` on a failed read, and that is a
 * measurement-corrupting bug, not a cosmetic one: `preKillMaxSeq` would be 0,
 * so the resumption matcher `sequence > 0` would match **sequence 1 — the
 * ORIGINAL, pre-kill `run.started`**. `resumptionMs` then goes NEGATIVE, a
 * negative number is `< derivedMs`, and the run reports `withinDerivedBound:
 * true` and exits 0 with a fabricated interval.
 *
 * That is precisely the "far-too-short interval sneaking in" the sequence
 * high-water mark exists to prevent, re-entering through the read that
 * establishes the mark. A failed read is not an empty log — it is an unknown
 * log, and the only honest response is to stop.
 */
async function eventsOrThrow(runId, what) {
  const evs = await eventsOf(runId);
  if (evs === null) {
    throw new Error(
      `${what}: GET /v1/runs/{id}/events/poll failed. This read establishes the pre-kill sequence `
      + 'high-water mark; treating it as an empty log would make the resumption matcher select a '
      + 'pre-kill event and report a fabricated (negative) recovery interval.',
    );
  }
  return evs;
}

/**
 * §B.5 — the DERIVED bound, read from the module that derives it.
 *
 * Deliberately not re-stated here. `recoveryBound.ts` imports every term from
 * the constant that causes the delay, so bundling and importing it means a
 * constant change moves this script's pass/fail threshold automatically. A copy
 * of the numbers in this file would be exactly the "claim, not a bound" §B.5
 * forbids — it would keep passing while the mechanism drifted underneath it.
 *
 * `--packages=external` is load-bearing: a full bundle tries to inline a native
 * `.node` binding and fails, and the output must live INSIDE the backend package
 * so its externals resolve against that `node_modules`.
 */
async function derivedTermsMs() {
  const cacheDir = join(BACKEND, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const out = join(cacheDir, 'rfc0158-recovery-bound.mjs');
  execFileSync(
    join(BACKEND, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    [
      join(BACKEND, 'src', 'host', 'recoveryBound.ts'),
      '--bundle', '--packages=external', '--format=esm', '--platform=node',
      `--outfile=${out}`,
    ],
    { cwd: BACKEND, stdio: 'pipe' },
  );
  const mod = await import(pathToFileURL(out).href);
  return mod.recoveryBoundTerms();
}

/**
 * The recovery class each case exercises. Named, never inferred at print time.
 *
 * `recoveryClassOf` REFUSES an unknown case rather than defaulting. The first
 * version of this guard resolved the bound with
 * `cls === 'leased' ? leasedMs : unleasedMs`, so an unrecognised `--case`
 * produced `cls === undefined` and silently compared against the UNLEASED
 * derivation — a 150s threshold applied to a ~730s leased observation, which
 * fails a conforming host. That is the same leased/unleased conflation this
 * script exists to prevent, reintroduced one layer down inside its own fix.
 * A ternary on a value that has more than two possible states is the shape to
 * distrust: the `else` branch silently absorbs everything unexpected.
 */
const CLASS_OF_CASE = { execution: 'leased', accept: 'unleased' };

function recoveryClassOf(kase) {
  const cls = CLASS_OF_CASE[kase];
  if (cls !== 'leased' && cls !== 'unleased') {
    throw new Error(
      `unknown --case=${kase}: no recovery class is defined for it, so there is no honest bound to `
      + `compare against. Known cases: ${Object.keys(CLASS_OF_CASE).join(', ')}.`,
    );
  }
  return cls;
}

function derivedForClass(terms, cls) {
  if (cls === 'leased') return terms.leasedMs;
  if (cls === 'unleased') return terms.unleasedMs;
  throw new Error(`no derived bound for recovery class '${cls}'`);
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

async function main() {
  // Validate the case BEFORE the 12-minute wait, not after it. Discovering an
  // unknown --case at comparison time would burn the whole run to report a typo.
  const declaredClass = recoveryClassOf(CASE);
  console.log(`RFC 0158 §D durability exercise — case=${CASE} (recovery class: ${declaredClass})`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  DSN:      ${DSN}\n`);

  const first = await boot('first');

  const create = await api('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowId: 'conformance-delay', inputs: { delayMs: CASE === 'execution' ? 30_000 : 1_000 } }),
  });
  if (create.status !== 201) throw new Error(`POST /v1/runs -> ${create.status}: ${(await create.text()).slice(0, 300)}`);
  const runId = (await create.json()).runId;
  console.log(`  accepted run ${runId} (HTTP 201)`);

  if (CASE === 'execution') {
    // Wait until the run is demonstrably RUNNING, so the dying instance is
    // holding a dispatch lease. Killing while still `pending` would silently
    // measure the accept case and report it as the execution one.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const s = await statusOf(runId);
      if (s === 'running') break;
      if (Date.now() > deadline) throw new Error(`run never reached 'running' (last status ${s})`);
      await sleep(250);
    }
    console.log('  run is RUNNING — the instance holds a dispatch lease');
  }

  const preKillStatus = await statusOf(runId);
  console.log(`  status before kill: ${preKillStatus}`);
  if (TERMINAL.has(preKillStatus)) throw new Error(`run was already ${preKillStatus} before the kill — nothing to recover`);

  // MEASURED 2026-08-19, and it invalidated the first version of this script:
  // the `accept` case never actually hits the pre-dispatch window. Acceptance
  // and dispatch are separated by a `setImmediate` (`routes/runs.ts:563`), so
  // the run is already `running` by the time an HTTP client can issue the next
  // request. The first run of this script reported `status before kill: running`
  // under `--case=accept` and would have published a LEASED-path measurement
  // (~12.5 min) as evidence for the unleased path (~1 min).
  //
  // Failing loudly is the only honest option. The alternative — measure whatever
  // happened and label it by intent — is how a number that means one thing gets
  // published as another, which is the failure this whole RFC is about.
  //
  // The finding this produces matters more than the case: `kill-after-accept` is
  // NOT causable by an outside observer over HTTP. A conformance seam that only
  // TERMINATES cannot witness it; the suite would also need a seam that HOLDS
  // dispatch, so acceptance can be observed as durable before anything runs.
  if (CASE === 'accept' && preKillStatus !== 'pending') {
    throw new Error(
      `--case=accept requires the run to still be 'pending' at kill time, and it is '${preKillStatus}'. `
      + 'Acceptance and dispatch are separated only by a setImmediate, so this window is not reachable '
      + 'from outside the process. Killing now would measure the LEASED path and mislabel it as the '
      + 'unleased one. Use --case=execution, or add a dispatch-hold seam.',
    );
  }
  if (CASE === 'execution' && preKillStatus !== 'running') {
    throw new Error(`--case=execution requires 'running' at kill time, got '${preKillStatus}'`);
  }

  // The high-water mark BEFORE the kill. Resumption is identified as a
  // `run.started` beyond it, not as "the second one seen" — a poll that races
  // the write could otherwise count a pre-kill event as the resumption and
  // report a recovery interval far shorter than reality.
  const preKillEvents = await eventsOrThrow(runId, 'pre-kill sequence high-water mark');
  const preKillMaxSeq = preKillEvents.reduce((m, e) => Math.max(m, Number(e.sequence) || 0), 0);
  // A run that is already `running` has written at least `run.started`. A zero
  // mark here means the log is empty when it cannot be — refuse rather than
  // measure against a mark that lets a pre-kill event match.
  if (preKillMaxSeq === 0) {
    throw new Error(`pre-kill event log is empty for a run in state '${preKillStatus}' — refusing to measure`);
  }

  const killedAt = Date.now();
  await kill(first);

  // Prove the work was durable, not merely in flight: nothing is serving now.
  try {
    await fetch(`${BASE}/.well-known/openwop`);
    throw new Error('a process is still serving after SIGKILL — the kill did not land');
  } catch (err) {
    if (String(err.message).includes('did not land')) throw err;
  }
  console.log('  confirmed: no process is serving\n  starting a second instance on the SAME database...');

  const second = await boot('second');

  const resumed = await statusOf(runId);
  console.log(`  status after restart: ${resumed}`);
  if (resumed === null) throw new Error('the run is not visible to the new instance — acceptance was NOT durable');

  const budgetMs = CASE === 'execution' ? 16 * 60_000 : 6 * 60_000;
  const deadline = killedAt + budgetMs;

  // WHAT IS MEASURED, and why the obvious version was wrong.
  //
  // §B.4 defines the bound as the interval between an instance ceasing to make
  // progress and another instance RESUMING its work. The first version of this
  // block timed `killedAt -> TERMINAL status`, which is time-to-COMPLETION: it
  // silently includes however long the resumed run then takes to execute. On the
  // 2026-08-20 run that inflated a 731s recovery to 762.9s — and 762.9s EXCEEDS
  // the 750s derivation, so a correct host read as a §B.5 violation. The number
  // was not merely imprecise; it pointed the wrong way.
  //
  // Both numbers are reported below, each labelled, because time-to-terminal is
  // still useful — it just is not the bound.
  let resumptionEvent = null;
  let final = resumed;
  for (;;) {
    // A failed poll here is benign — unlike the pre-kill read it establishes
    // nothing, so retrying is correct and the deadline below still bounds us.
    const evs = (await eventsOf(runId)) ?? [];
    resumptionEvent ??= evs.find((e) => e.type === 'run.started' && Number(e.sequence) > preKillMaxSeq) ?? null;
    final = (await statusOf(runId)) ?? final;
    if (resumptionEvent && TERMINAL.has(final)) break;
    if (Date.now() > deadline) {
      console.error(`\n✗ NOT RECOVERED within ${(budgetMs / 60_000).toFixed(1)} min`
        + ` (last status: ${final}; resumption event ${resumptionEvent ? 'seen' : 'NEVER SEEN'})`);
      await kill(second);
      process.exit(1);
    }
    await sleep(2_000);
  }

  const terminalMs = Date.now() - killedAt;
  const resumptionMs = Date.parse(resumptionEvent.timestamp) - killedAt;

  // Backstop against ANY path that yields an impossible interval. Resumption
  // happens after the kill by construction, so a value <= 0 means the matched
  // event predates the kill — the fabricated-interval failure mode. It must be
  // a hard error and never a "fast recovery" that sails under the bound.
  if (!Number.isFinite(resumptionMs) || resumptionMs <= 0) {
    throw new Error(
      `impossible resumption interval ${resumptionMs}ms (event seq ${resumptionEvent.sequence} @ `
      + `${resumptionEvent.timestamp}, killedAt ${new Date(killedAt).toISOString()}): the matched event `
      + 'does not post-date the kill, so the measurement is invalid.',
    );
  }

  const cls = recoveryClassOf(CASE);
  const terms = await derivedTermsMs();
  const derivedMs = derivedForClass(terms, cls);

  console.log(`\n✓ RECOVERED`);
  console.log(`  recovery class:      ${cls}   (case=${CASE})`);
  console.log(`  terminal status:     ${final}`);
  console.log(`  RESUMPTION (§B.4):   ${(resumptionMs / 1000).toFixed(1)}s  (${(resumptionMs / 60_000).toFixed(2)} min)  <- the bound`);
  console.log(`  derived ${cls} bound: ${(derivedMs / 1000).toFixed(1)}s  (${(derivedMs / 60_000).toFixed(2)} min)`);
  console.log(`  time-to-terminal:    ${(terminalMs / 1000).toFixed(1)}s   (resumption + the run's own execution — NOT the bound)`);

  await kill(second);
  console.log(`\n  logs: ${DATA_DIR}`);
  // Record the SEQUENCES and timestamps, not just the delta. A bundle reader
  // must be able to recompute the interval and see WHICH events it came from —
  // a bare number cannot be distinguished from one taken against "the second
  // run.started seen", which a poll racing the write can make far too short.
  writeFileSync(join(DATA_DIR, 'result.json'), JSON.stringify({
    case: CASE,
    recoveryClass: cls,
    runId,
    killedAt: new Date(killedAt).toISOString(),
    preKillMaxSeq,
    resumption: {
      sequence: Number(resumptionEvent.sequence),
      type: resumptionEvent.type,
      timestamp: resumptionEvent.timestamp,
      matchedOn: 'run.started with sequence > preKillMaxSeq',
    },
    resumptionMs,
    terminalMs,
    derivedMs,
    terms,
    final,
    withinDerivedBound: resumptionMs <= derivedMs,
  }, null, 2));

  // §B.5: observed must not EXCEED derived. Faster than derived is fine and is
  // not a failure — a conservative bound is honest, an optimistic one is not.
  if (resumptionMs > derivedMs) {
    console.error(`\n✗ BOUND VIOLATED: observed ${cls} resumption ${(resumptionMs / 1000).toFixed(1)}s`
      + ` EXCEEDS the derived bound ${(derivedMs / 1000).toFixed(1)}s.`
      + ' The declared bound is optimistic — a claim the mechanism does not produce.');
    process.exit(1);
  }
  console.log(`\n  within the derived ${cls} bound by ${((derivedMs - resumptionMs) / 1000).toFixed(1)}s.`);
}

main().catch(async (err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
