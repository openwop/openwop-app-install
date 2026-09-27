/**
 * The SUPERVISED durability lane — RFC 0158 kill rows (ADR 0739 D5).
 *
 *   npm run test:conformance:durability
 *
 * WHY THIS IS NOT `run.ts`. The default lane boots the host INSIDE the harness
 * process via `createApp`. Three things follow, each fatal to a kill exercise:
 * a real SIGKILL takes the harness with it; `createApp` never starts the
 * run-dispatch sweeper (only `main()` does), so nothing would recover the run;
 * and the lane's temp database is `rmSync`'d by an `exit` hook. So the kill seam
 * answers 404 there (`isOwnProcess()` is false) and the rows stay `inapplicable`
 * — the true answer for a lane that cannot witness a process death.
 *
 * WHAT THIS DOES INSTEAD. It is the RESTART SUPERVISOR the RFC names as the
 * operator precondition ("something must restart the killed instance; the suite
 * cannot — e.g. the harness as parent process"):
 *
 *   1. boots the REAL `main()` as a child, on a sqlite FILE this process owns;
 *   2. restarts it every time it dies, and RECORDS each death and its signal;
 *   3. runs only the durability scenario file against it, ledger on, strict;
 *   4. FAILS unless the ledger shows every row `executed-pass` AND it observed
 *      the deaths itself. A green with no SIGKILL on record is the vacuous pass
 *      this whole exercise exists to exclude, and only the supervisor can see it.
 *
 * TIME. `kill-during-execution` waits out the LEASED-class bound — 750 s on this
 * host. That is conformant (RFC 0158 §B.6) and it is why the lane takes ~15 min
 * and sets `OPENWOP_DURABILITY_OBSERVATION_CEILING_MS`. Do not wrap this lane in
 * a shorter timeout: a harness timeout reads exactly like a host failure.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { declaredRecoveryBoundMs } from '../src/host/recoveryBound.js';

const API_KEY = 'durability-lane-key';
const SCENARIO = 'src/scenarios/v2-durability-recovery';

/** Every row the `durable-single-instance` rung needs, per RFC 0158 acceptance. */
export const REQUIRED_ROWS = [
  'openwop.requirement.0158.kill-after-accept',
  'openwop.requirement.0158.kill-during-execution',
  'openwop.requirement.0158.duplicate-delivery',
  'openwop.requirement.0158.bound-is-derived',
  'openwop.requirement.0158.poison-exhaustion',
] as const;

/** The two rows that each require one real process death. */
export const KILL_ROW_COUNT = 2;

export interface LedgerRow { requirementId?: string; disposition?: string; detail?: string }
export interface Death { atMs: number; signal: NodeJS.Signals | null; code: number | null }

/**
 * The lane's verdict, as a pure function so it can be tested without killing
 * anything. Returns the list of reasons the run is NOT a witness; empty = pass.
 */
export function evaluateLane(rows: readonly LedgerRow[], deaths: readonly Death[]): string[] {
  const problems: string[] = [];
  for (const id of REQUIRED_ROWS) {
    const mine = rows.filter((r) => r.requirementId === id);
    if (mine.length === 0) {
      problems.push(`${id}: NO ledger row — the scenario did not run or did not record`);
      continue;
    }
    const bad = mine.filter((r) => r.disposition !== 'executed-pass');
    for (const r of bad) problems.push(`${id}: ${r.disposition ?? 'unknown'} — ${(r.detail ?? '').slice(0, 300)}`);
  }
  const sigkills = deaths.filter((d) => d.signal === 'SIGKILL');
  if (sigkills.length < KILL_ROW_COUNT) {
    problems.push(
      `the supervisor observed ${sigkills.length} SIGKILL death(s) of the host, but ${KILL_ROW_COUNT} kill rows ran — `
        + 'a kill row that passed without a recorded death did not witness a process termination (RFC 0158 item 11)',
    );
  }
  return problems;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? ok(a.port) : fail(new Error('no port'))));
    });
  });
}

async function waitReady(baseUrl: string, deadlineMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      if ((await fetch(`${baseUrl}/.well-known/openwop`)).status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const conformanceRoot = resolve(cwd, 'node_modules', '@openwop', 'openwop-conformance');
  if (!existsSync(resolve(conformanceRoot, `${SCENARIO}.test.ts`))) {
    throw new Error(`[durability-lane] ${SCENARIO}.test.ts is not in the installed suite — needs @openwop/openwop-conformance >= 2.31.0`);
  }

  const workDir = mkdtempSync(join(tmpdir(), 'openwop-durability-lane-'));
  const ledger = join(workDir, 'requirement-ledger.jsonl');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const log = (m: string): void => { console.log(`[durability-lane] ${m}`); };

  const hostEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    OPENWOP_STORAGE_DSN: `sqlite://${join(workDir, 'host.db')}`,
    OPENWOP_API_KEYS: `${API_KEY}:*`,
    OPENWOP_TEST_SEAM_ENABLED: 'true',
    OPENWOP_ENABLE_CONFORMANCE_NODES: 'true',
    OPENWOP_RATELIMIT_DISABLED: 'true',
    OPENWOP_AUTH_DISABLE_COOKIES: 'true',
    // The duplicate-delivery row's receiver is the SUITE's, on loopback. This is
    // safeFetch's OWN relaxation flag — the webhook worker's does not cover it.
    // IT IS A RELAXATION (security-defaults.md §Relaxations): a bundle cut under
    // it must declare it in `host.relaxations[]` and cannot certify the relaxed
    // profile. This lane is a local regression witness, NOT certification
    // evidence — see `WHD-13` before ever offering its output as such.
    OPENWOP_SAFEFETCH_ALLOW_PRIVATE: 'true',
    // A non-vitest boot re-points every `~/.openwop-packs` symlink at this
    // checkout (CLAUDE.md § parallel sessions). This lane needs only the
    // conformance fixtures, so it mounts nothing and owns its own pack dir.
    OPENWOP_MOUNT_LOCAL_PACKS: 'false',
    OPENWOP_PACK_DIR: join(workDir, 'packs'),
  };

  const deaths: Death[] = [];
  let stopping = false;
  let host: ChildProcess | undefined;
  const boot = (): void => {
    // `node --import tsx`, NOT the tsx CLI: the CLI forks, and the pid the host
    // SIGKILLs must be the process this supervisor is watching.
    host = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd, env: hostEnv, stdio: ['ignore', 'ignore', 'inherit'] });
    host.once('exit', (code, signal) => {
      if (stopping) return;
      deaths.push({ atMs: Date.now(), signal, code });
      log(`host died (signal=${signal ?? 'none'} code=${code ?? 'none'}) — death #${deaths.length}; restarting`);
      boot();
    });
  };

  let exitCode = 1;
  try {
    boot();
    if (!(await waitReady(baseUrl, 120_000))) throw new Error('the host never answered discovery within 120 s of first boot');
    log(`host up at ${baseUrl} (real main(), sqlite file, sweeper running)`);

    const probe = await fetch(`${baseUrl}/host/durability/kill`, { headers: { Authorization: `Bearer ${API_KEY}`, 'OpenWOP-Version': '2' } });
    if (probe.status !== 200) throw new Error(`the kill-seam probe answered ${probe.status} — every row would record \`inapplicable\` and this lane would witness nothing`);

    const ceiling = Number(process.env.OPENWOP_DURABILITY_OBSERVATION_CEILING_MS)
      || declaredRecoveryBoundMs('leased') + 30_000;
    log(`observation ceiling ${ceiling} ms (leased-class bound ${declaredRecoveryBoundMs('leased')} ms) — this lane is SLOW by design`);

    const suite = spawn(
      process.execPath,
      [resolve(cwd, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', resolve(conformanceRoot, 'vitest.config.ts'), '--no-file-parallelism', SCENARIO],
      {
        cwd: conformanceRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          OPENWOP_BASE_URL: baseUrl,
          OPENWOP_API_KEY: API_KEY,
          OPENWOP_TARGET_MAJOR: '2',
          OPENWOP_REQUIRE_BEHAVIOR: 'true',
          OPENWOP_LEDGER_PATH: ledger,
          OPENWOP_DURABILITY_OBSERVATION_CEILING_MS: String(ceiling),
          OPENWOP_IMPLEMENTATION_NAME: 'openwop-workflow-engine',
          OPENWOP_IMPLEMENTATION_VERSION: '0.1.0',
        },
      },
    );
    const suiteCode: number | null = await new Promise((r) => suite.once('exit', (c) => r(c)));

    const rows: LedgerRow[] = existsSync(ledger)
      ? readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerRow)
      : [];
    log(`suite exit=${suiteCode ?? 'signal'}; ledger rows=${rows.length}; host deaths=${deaths.length} (${deaths.map((d) => d.signal ?? `code ${d.code}`).join(', ') || 'none'})`);
    for (const id of REQUIRED_ROWS) {
      for (const r of rows.filter((x) => x.requirementId === id)) log(`  ${id} → ${r.disposition}${r.detail ? ` — ${r.detail.slice(0, 200)}` : ''}`);
    }
    // The work dir is deleted below, and the ledger is the only record of what
    // each row actually observed. Keep it when the operator names a place.
    const keepDir = process.env.OPENWOP_DURABILITY_LANE_OUT;
    if (keepDir && existsSync(ledger)) {
      mkdirSync(keepDir, { recursive: true });
      copyFileSync(ledger, join(keepDir, 'requirement-ledger.jsonl'));
      writeFileSync(join(keepDir, 'host-deaths.json'), JSON.stringify(deaths, null, 2));
      log(`ledger + death record kept in ${keepDir}`);
    }
    const problems = evaluateLane(rows, deaths);
    if (suiteCode !== 0) problems.unshift(`the suite exited ${suiteCode ?? 'on a signal'}`);
    if (problems.length === 0) {
      log('✓ durable-single-instance: five rows executed-pass across real SIGKILL deaths');
      exitCode = 0;
    } else {
      log('✗ NOT a witness:');
      for (const p of problems) log(`    - ${p}`);
    }
  } finally {
    stopping = true;
    host?.kill('SIGTERM');
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  process.exit(exitCode);
}

// Entry-point guard: importing this file (the evaluator's unit test does) must
// never boot a host. realpath on both sides — a raw argv[1] comparison is the
// "zero bytes, exit 0, never ran" trap (#3070/#3117).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const isEntry = ((): boolean => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isEntry) {
  main().catch((err) => {
    console.error('[durability-lane] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
