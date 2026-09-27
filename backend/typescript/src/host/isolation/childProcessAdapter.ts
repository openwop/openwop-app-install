/**
 * ADR 0555 P2 — the first PRODUCTION isolation adapter: one forked Node process
 * per dispatch, under the runtime's permission model.
 *
 * P1 shipped the contract and a fake adapter that is a real MESSAGE boundary and
 * an honest non-boundary for everything else. This is the adapter that makes the
 * other half true — and, just as importantly, the one that says precisely where
 * it stops.
 *
 * ── WHY A CHILD PROCESS AND NOT A SANDBOX RUNTIME ─────────────────────────
 *
 * ADR 0146 already recorded the deployment constraint: Cloud Run gen2 gives no
 * `/dev/kvm`, no nested virtualisation and no Docker-in-Docker, with gVisor
 * already underneath us. Firecracker, a container-per-dispatch and nsjail are
 * therefore not options on the target platform, not merely unbuilt. The two
 * out-of-process runtimes this host DOES have (`sandboxAdapters/e2bAdapter.ts`,
 * the Code-API adapter) belong to the ADR 0114/0146 family, whose unit of work
 * is a SOURCE STRING evaluated remotely — they cannot import a pack's ESM module
 * graph, and sending pack bytes to a third party is a data-egress decision of
 * its own. So the first production adapter is the one that needs no
 * infrastructure that does not exist: Node, forking itself.
 *
 * ── WHAT IS ENFORCED, MEASURED ON NODE 22.13.1 ────────────────────────────
 *
 * With `--permission` plus a realpath'd `--allow-fs-read` allowlist and
 * `--disallow-code-generation-from-strings`, the RUNTIME denies: reads outside
 * the allowlist, all writes outside it, `child_process`, `worker_threads`,
 * `process.binding`, `process.dlopen` (native addons), and `eval`/`new Function`.
 * `env: {}` withholds the host environment. `--max-old-space-size` ends an
 * allocation bomb in a SIGABRT (measured: 52ms). A parent SIGKILL ends a
 * `for(;;){}` (measured: ~700ms). Those are this adapter's `enforced`
 * guarantees, and each one has a test that watches it deny.
 *
 * ── WHAT IS NOT ENFORCED, AND IS NOT CLAIMED ──────────────────────────────
 *
 * NETWORK. Node's permission model has no network dimension; `node:net` connects
 * from inside the isolate. Cloud Run exposes no seccomp or network-namespace
 * control to the workload, and the one in-realm route to refusing the module —
 * `module.register()` — itself requires the WorkerThreads permission, so buying
 * it would cost `no-worker-threads`, which is a strictly worse trade. The worker
 * entry deletes `fetch`/`WebSocket`/`EventSource`, which raises the cost and
 * changes nothing about the guarantee. `network-denied` is therefore reported
 * `not-enforced`, a tier requiring it is REFUSED, and no capability is
 * advertised anywhere (P4 owns that, gated on RFC 0035).
 *
 * The guarantees are computed from the RUNTIME, not hard-coded: on a Node
 * without the permission model the filesystem/subprocess/worker/addon
 * guarantees report `not-enforced` and the untrusted tier becomes undispatchable
 * on that host. That is the correct outcome and it is why the field is a
 * function of the process rather than a constant.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger } from '../../observability/logger.js';
import { createSemaphore } from '../../util/asyncSemaphore.js';
import { recordPackIsolation } from '../../observability/metricSeams.js';
import type { PackHostCallBroker } from '../packHostCallBroker.js';
import type { IsolationAdapter } from '../isolationAdapter.js';
import { NO_GUARANTEES, type AdapterGuarantees } from '../isolationGuarantees.js';
import {
  ISOLATION_ADAPTER_UNAVAILABLE_CODE,
  ISOLATION_BUDGET_UNSAFE_CODE,
  ISOLATION_MEMORY_CODE,
  ISOLATION_TIMEOUT_CODE,
  ISOLATION_WORKER_CRASHED_CODE,
  clampFailureMessage,
  type DispatchEnvelope,
  type DispatchResult,
} from '../packWorkerContract.js';
import { ADVANCED_SERIALIZATION, isChildMessage, type ChildMessage, type ParentMessage } from './workerChannel.js';
import { resolveWorkerEntry } from './workerEntry.js';

const log = createLogger('host.isolation.childProcess');

export const CHILD_ADAPTER_ID = 'node-child-process';

/* -------------------------------------------------------------------------- *
 * Runtime capability probe
 * -------------------------------------------------------------------------- */

/**
 * Which spelling of the permission-model flag this runtime accepts.
 *
 * `--permission` is the current name (Node 23.5+, backported to 22.13);
 * `--experimental-permission` is the older one and is gone in Node 24. The
 * package's `engines` admit `>=22 <25`, which spans all three states, so the
 * flag is PROBED rather than derived from a version number — a version
 * comparison encodes a release history that keeps changing, whereas
 * `allowedNodeEnvironmentFlags` is the runtime answering for itself.
 */
export function permissionFlag(
  flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): '--permission' | '--experimental-permission' | null {
  if (flags.has('--permission')) return '--permission';
  if (flags.has('--experimental-permission')) return '--experimental-permission';
  return null;
}

/**
 * The adapter's honest guarantee record for a given runtime.
 *
 * Every `enforced` entry below is denied by the runtime or the OS, outside the
 * pack's realm. Nothing the worker entry does in-realm appears here.
 */
export function childAdapterGuarantees(
  flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): AdapterGuarantees {
  const permissioned = permissionFlag(flags) !== null;
  return Object.freeze({
    ...NO_GUARANTEES,
    // True of a forked process regardless of any flag.
    'separate-process': 'enforced',
    'scrubbed-env': 'enforced',
    'memory-cap': 'enforced',
    'cpu-wall-clock-kill': 'enforced',
    'no-dynamic-code': 'enforced',
    // These four ARE the permission model. Without it they are simply false,
    // and reporting them anyway is the dishonest advertisement this whole ADR
    // is organised around not making.
    'filesystem-allowlist': permissioned ? 'enforced' : 'not-enforced',
    'no-subprocess': permissioned ? 'enforced' : 'not-enforced',
    'no-worker-threads': permissioned ? 'enforced' : 'not-enforced',
    'no-native-addons': permissioned ? 'enforced' : 'not-enforced',
    // Follows from the per-dispatch scratch dir + a per-PACK read allowlist,
    // both of which are the permission model's doing.
    'cross-dispatch-isolation': permissioned ? 'enforced' : 'not-enforced',
    // Unreachable on this platform — see the module docblock.
    'network-denied': 'not-enforced',
  });
}

/* -------------------------------------------------------------------------- *
 * Operator knobs
 * -------------------------------------------------------------------------- */

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Heap ceiling per isolate.
 *
 * Default 96MB, chosen against the DEPLOYED instance rather than by feel:
 * `DEPLOY.md` runs Cloud Run at `--memory=512Mi --cpu=1`. See
 * `checkIsolationMemoryBudget` for the arithmetic that has to hold, and for the
 * misconfiguration this default replaced.
 */
export function maxOldSpaceMb(env: NodeJS.ProcessEnv = process.env): number {
  return envInt('OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB', 96, env);
}

/**
 * The total memory isolates may claim, in MB.
 *
 * Default 192MB against the documented `--memory=512Mi` instance, leaving
 * ~320MB for the host process itself — which is not spare capacity, it is where
 * the executor, the SPA shell cache and every in-memory store live.
 *
 * An operator raising the concurrency or the per-isolate heap must raise THIS
 * deliberately, which is the whole point: the failure it prevents is silent and
 * misattributed (see below).
 */
export function isolationMemoryBudgetMb(env: NodeJS.ProcessEnv = process.env): number {
  return envInt('OPENWOP_PACK_ISOLATION_MEMORY_BUDGET_MB', 192, env);
}

export type BudgetCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * `concurrency × per-isolate heap ≤ budget`, checked rather than left to the
 * operator's arithmetic.
 *
 * WHY THIS EXISTS AS CODE. When N isolates each hold a `--max-old-space-size`
 * heap, the sum is charged to the CONTAINER. Exceed the instance and Cloud Run
 * OOM-kills the whole service — not the pack. The symptom is the backend
 * restarting under load, which reads as a platform fault or a traffic spike and
 * sends an operator looking anywhere except at a pack-isolation knob. Every
 * mechanism in this adapter for containing a pack's memory is defeated by that,
 * because the thing that dies is the host.
 *
 * IT ALREADY CAUGHT ONE, MINE. P2 first shipped `MAX_CONCURRENT=4` and a 128MB
 * ceiling: 4 × 128 = 512MB, exactly the whole `--memory=512Mi` instance, with
 * nothing left for the host that spawned them. Nothing in the escape suite
 * could have found that — every test passes on a laptop with 32GB. Hence a
 * check against the DEPLOYED size, and defaults (2 × 96 = 192) that satisfy it.
 *
 * Refuses; it does not throw. Crashing the host at boot over a pack-isolation
 * knob would be a worse outage than declining to isolate — so the boot path
 * logs it loudly and the dispatch path refuses, both from this one function so
 * the two can never disagree.
 */
export function checkIsolationMemoryBudget(env: NodeJS.ProcessEnv = process.env): BudgetCheck {
  const slots = maxConcurrentIsolates(env);
  const perIsolate = maxOldSpaceMb(env);
  const budget = isolationMemoryBudgetMb(env);
  const required = slots * perIsolate;
  if (required <= budget) return { ok: true };
  return {
    ok: false,
    reason:
      `pack isolation is configured to use up to ${required}MB (${slots} concurrent isolates × ${perIsolate}MB heap)`
      + ` but its budget is ${budget}MB. Exceeding the instance's memory OOM-kills the CONTAINER, not the pack.`
      + ` Lower OPENWOP_PACK_ISOLATION_MAX_CONCURRENT or OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB, or raise`
      + ` OPENWOP_PACK_ISOLATION_MEMORY_BUDGET_MB once the instance is genuinely large enough for it.`,
  };
}

/**
 * Boot-time report. Called from `index.ts` beside the other boot checks so the
 * refusal is visible at startup rather than at the first untrusted dispatch —
 * an operator who mis-sized this should learn on deploy, not from a run that
 * failed hours later.
 */
export function logIsolationMemoryBudgetAtBoot(env: NodeJS.ProcessEnv = process.env): BudgetCheck {
  const check = checkIsolationMemoryBudget(env);
  if (!check.ok) {
    log.error('pack_isolation_memory_budget_unsafe', {
      reason: check.reason,
      consequence: 'isolated pack dispatches will be REFUSED; untrusted packs cannot run until this is fixed',
    });
  }
  return check;
}

/** How long the worker gets to boot and say `ready`. Separate from the pack's
 *  wall clock so a slow spawn is not billed to the pack, and so a worker that
 *  never boots is not held for the full dispatch budget. */
export function bootTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return envInt('OPENWOP_PACK_ISOLATION_BOOT_MS', 15_000, env);
}

/**
 * Concurrent isolates.
 *
 * Deliberately NOT `withSandboxConcurrency` from the ADR 0114 family: that cap
 * exists to bound external code-exec COST, it is shared across those adapters
 * on purpose, and it fail-fasts `resource_exhausted` over the limit. Sharing it
 * would couple two unrelated budgets — a burst of pack dispatches would start
 * failing `ctx.runSandboxedCode` — and turn an ordinary workflow into an error
 * where it should simply wait. `createSemaphore` is the existing generic seam
 * and it QUEUES.
 */
export function maxConcurrentIsolates(env: NodeJS.ProcessEnv = process.env): number {
  // Default 2, not 4. Two reasons, both about the deployed instance rather than
  // this laptop: `2 × 96MB` fits the memory budget below, and `DEPLOY.md` runs
  // Cloud Run at `--cpu=1`, where four forked V8 heaps contend for one core.
  return envInt('OPENWOP_PACK_ISOLATION_MAX_CONCURRENT', 2, env);
}

/**
 * Extra absolute paths added to the worker's read allowlist, VERBATIM.
 *
 * For an operator whose packs import shared modules from outside their own
 * directory; empty by default, because every entry here widens the boundary.
 * A directory must be written with its own trailing `/*` — this deliberately
 * does not helpfully add one, because emitting both forms for one path aborts
 * the runtime (see the note beside `execArgv`).
 */
export function extraReadPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OPENWOP_PACK_ISOLATION_EXTRA_FS_READ ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Cap on captured child stdio, per stream. A pack must not be able to make the
 *  host's memory or log line a function of how much it prints. */
const MAX_CAPTURED_STDIO_BYTES = 8_192;

/** Broker refusals that mean the dispatch is OVER. Relaying one and then letting
 *  the isolate keep burning CPU until its wall clock would waste exactly the
 *  budget the refusal was protecting, so the isolate is killed instead.
 *  `dispatch_token_invalid` / `dispatch_unknown` are NOT here: they describe a
 *  BAD CALL, and a host-side relay bug must not become a way to kill healthy
 *  work. */
const TERMINAL_REFUSALS = new Set(['dispatch_cancelled', 'dispatch_expired', 'dispatch_completed', 'dispatch_budget_exceeded']);

/* -------------------------------------------------------------------------- *
 * Spawn options
 * -------------------------------------------------------------------------- */

export interface ChildSpawnInput {
  readonly entryPath: string;
  readonly packDir: string;
  readonly scratch: string;
  readonly flags: ReadonlySet<string>;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Every containment decision this adapter makes, as ONE pure function.
 *
 * Extracted from the spawn call because two of these are otherwise UNTESTABLE
 * from inside the isolate, which the P2 sabotage pass caught:
 *
 *   `env: {}`  the worker entry ALSO blanks `process.env` in-realm, so a probe
 *              reading its own environment sees an empty bag either way.
 *              Replacing this with `process.env` left the behavioural test
 *              GREEN — the attenuation was masking the enforcement, and the
 *              test that looked like it proved `scrubbed-env` proved only the
 *              cosmetic half.
 *   `--max-old-space-size`
 *              dropping it left the memory test green too, because V8 still has
 *              a default ~4GB ceiling and the bomb eventually hit THAT. The
 *              test proved "some limit exists", not "we set one".
 *
 * A pure function makes both assertable directly, and the behavioural tests
 * keep their own job. Neither kind is sufficient alone: the structural test
 * cannot show the flags WORK, and the behavioural test cannot show WHICH
 * mechanism produced the denial.
 */
export function childSpawnOptions(input: ChildSpawnInput): {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly execArgv: string[];
  readonly serialization: typeof ADVANCED_SERIALIZATION;
  readonly stdio: ['ignore', 'pipe', 'pipe', 'ipc'];
  readonly detached: false;
} {
  const { entryPath, packDir, scratch, flags, env } = input;
  const permission = permissionFlag(flags);
  const execArgv = [
    `--max-old-space-size=${maxOldSpaceMb(env)}`,
    '--disallow-code-generation-from-strings',
    ...(permission
      ? [
          permission,
          // A FILE grant for the worker itself, and `<dir>/*` for the two
          // directories. Never both `<dir>` and `<dir>/*` — see below.
          `--allow-fs-read=${entryPath}`,
          `--allow-fs-read=${packDir}/*`,
          `--allow-fs-read=${scratch}/*`,
          `--allow-fs-write=${scratch}/*`,
          ...extraReadPaths(env).map((p) => `--allow-fs-read=${p}`),
        ]
      : []),
  ];
  // ── A Node BUG this allowlist is shaped around, measured on 22.13.1 ──────
  // Granting BOTH a directory and its wildcard (`--allow-fs-read=/d` together
  // with `--allow-fs-read=/d/*`) aborts the process during flag application:
  //   node::permission::FSPermission::RadixTree::Node::CreateChild
  //   Assertion failed: !path_prefix.empty()
  // It is an ABORT, not an error — the child dies with SIGABRT before running a
  // line, which surfaces as `pack_isolation_worker_crashed` on every dispatch
  // and reads like a broken worker rather than a malformed flag. The redundant
  // grant looked harmless and belt-and-braces; it was a total outage of the
  // isolated path. Hence: one form per path, and `extraReadPaths` is passed
  // THROUGH VERBATIM so an operator's `/opt/shared/*` is not silently paired
  // with `/opt/shared` here.
  return {
    // No host environment reaches the isolate. This is the ENFORCED half of
    // `scrubbed-env`; the worker entry additionally blanks `process.env`
    // in-realm so the view is uniform across platforms.
    env: {},
    cwd: scratch,
    // EXPLICIT, never inherited: `fork()` defaults `execArgv` to the PARENT's,
    // which under vitest would leak the runner's own flags into the isolate.
    // Observed for real while verifying the built artifact: an inherited
    // `--input-type=module` made the worker refuse to boot.
    execArgv,
    // See `workerChannel.ts` — the default is JSON and silently mangles
    // Date/Map/Set/Buffer, which would break P1's structuredClone contract.
    serialization: ADVANCED_SERIALIZATION,
    // No inherited fds. stdout/stderr are piped so a pack cannot write onto the
    // host's own streams, and are captured under a hard cap.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: false,
  };
}

/* -------------------------------------------------------------------------- *
 * The adapter
 * -------------------------------------------------------------------------- */

export interface ChildAdapterOptions {
  /** Injected in tests to exercise the no-permission-model runtime. */
  readonly flags?: ReadonlySet<string>;
  readonly env?: NodeJS.ProcessEnv;
}

export function createChildProcessIsolationAdapter(opts: ChildAdapterOptions = {}): IsolationAdapter {
  const flags = opts.flags ?? process.allowedNodeEnvironmentFlags;
  const env = opts.env ?? process.env;
  const semaphore = createSemaphore(maxConcurrentIsolates(env));

  return {
    id: CHILD_ADAPTER_ID,
    guarantees: childAdapterGuarantees(flags),
    dispatch(envelope: DispatchEnvelope, broker: PackHostCallBroker): Promise<DispatchResult> {
      return semaphore.run(() => dispatchInChild(envelope, broker, flags, env));
    },
  };
}

async function dispatchInChild(
  envelope: DispatchEnvelope,
  broker: PackHostCallBroker,
  flags: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): Promise<DispatchResult> {
  // Before anything is spawned: would N of these fit? Refusing is the safe arm —
  // an over-budget isolate does not fail the pack, it OOM-kills the host.
  const budget = checkIsolationMemoryBudget(env);
  if (!budget.ok) {
    log.error('pack_isolation_memory_budget_unsafe', { reason: budget.reason, typeId: envelope.typeId });
    recordPackIsolation(CHILD_ADAPTER_ID, 'budget_unsafe');
    return failure(ISOLATION_BUDGET_UNSAFE_CODE, budget.reason);
  }

  const entry = await resolveWorkerEntry(env);
  if (!entry.ok) {
    // REFUSED, never downgraded. A host that cannot isolate must not quietly
    // run untrusted code somewhere weaker.
    log.error('pack isolation worker entry unavailable', { reason: entry.reason, typeId: envelope.typeId });
    recordPackIsolation(CHILD_ADAPTER_ID, 'adapter_unavailable');
    return failure(
      ISOLATION_ADAPTER_UNAVAILABLE_CODE,
      `no isolated pack worker is available on this host (${entry.reason}); '${envelope.typeId}' was not executed`,
    );
  }

  // The permission model matches on REAL paths, and module resolution itself
  // calls `realpath` — which is a READ, and is therefore checked against the
  // allowlist BEFORE the module is opened. So granting only the resolved path
  // is not enough: the isolate must also be ASKED for the resolved path, or it
  // dies inside `toRealPath` with an opaque ERR_ACCESS_DENIED naming a path the
  // operator did in fact configure.
  //
  // This is not a macOS curiosity (/var → /private/var). This host's own pack
  // directory is routinely a symlink — `~/.openwop-packs` entries point into a
  // checkout — so the unresolved form is the NORMAL case here.
  let entryPath: string;
  let packDir: string;
  try {
    entryPath = realpathSync(fileURLToPath(envelope.entryUrl));
    packDir = dirname(entryPath);
  } catch (err) {
    recordPackIsolation(CHILD_ADAPTER_ID, 'spawn_failed');
    return failure(
      ISOLATION_WORKER_CRASHED_CODE,
      `pack directory for '${envelope.packName}' could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // One scratch dir per DISPATCH, not per pack: two concurrent dispatches of the
  // same pack would otherwise share a writable directory, which is precisely the
  // hole `cross-dispatch-isolation` claims to close.
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'owp-iso-'));
  const options = childSpawnOptions({ entryPath: entry.path, packDir, scratch, flags, env });

  let child: ChildProcess;
  try {
    child = fork(entry.path, [], options);
  } catch (err) {
    rmSync(scratch, { recursive: true, force: true });
    recordPackIsolation(CHILD_ADAPTER_ID, 'spawn_failed');
    return failure(
      ISOLATION_WORKER_CRASHED_CODE,
      `isolated worker for '${envelope.typeId}' could not be spawned: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    // The isolate is handed the RESOLVED entry so its own `import` matches the
    // allowlist. Nothing else about the envelope changes, and `entryUrl` is not
    // a `ctx` member, so no pack observes the difference.
    const result = await driveChild(child, { ...envelope, entryUrl: pathToFileURL(entryPath).toString() }, broker);
    recordPackIsolation(CHILD_ADAPTER_ID, outcomeOf(result));
    return result;
  } finally {
    // Unconditional. "Cancellation kills the isolate" is only true if EVERY
    // exit from this function kills it — a result, a throw, a timeout alike.
    hardKill(child);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function driveChild(
  child: ChildProcess,
  envelope: DispatchEnvelope,
  broker: PackHostCallBroker,
): Promise<DispatchResult> {
  return new Promise<DispatchResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let ready = false;
    let stderr = '';
    let stdout = '';

    const finish = (result: DispatchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bootTimer);
      clearTimeout(wallTimer);
      resolve(result);
    };

    const capture = (stream: NodeJS.ReadableStream | null, sink: (chunk: string) => void): void => {
      stream?.on('data', (chunk: Buffer) => sink(chunk.toString('utf-8')));
      stream?.on('error', () => undefined);
    };
    capture(child.stdout, (c) => { stdout = (stdout + c).slice(0, MAX_CAPTURED_STDIO_BYTES); });
    capture(child.stderr, (c) => { stderr = (stderr + c).slice(0, MAX_CAPTURED_STDIO_BYTES); });

    const bootTimer = setTimeout(() => {
      if (ready) return;
      log.warn('isolated pack worker never became ready', { typeId: envelope.typeId, pack: envelope.packName });
      hardKill(child);
      finish(failure(ISOLATION_WORKER_CRASHED_CODE, `isolated worker for '${envelope.typeId}' did not start within its boot budget`));
    }, bootTimeoutMs());
    if (typeof bootTimer.unref === 'function') bootTimer.unref();

    const wallTimer = setTimeout(() => {
      timedOut = true;
      log.warn('isolated pack dispatch exceeded its wall-clock budget; killing the isolate', {
        typeId: envelope.typeId, pack: envelope.packName, wallClockMs: envelope.budget.wallClockMs,
      });
      // The whole point of the process boundary: this is a KILL, not the fake
      // adapter's abandonment. A busy loop stops here.
      hardKill(child);
    }, envelope.budget.wallClockMs);
    if (typeof wallTimer.unref === 'function') wallTimer.unref();

    child.on('message', (raw: unknown) => {
      if (!isChildMessage(raw)) return;
      const msg = raw as ChildMessage;
      if (msg.k === 'ready') {
        ready = true;
        clearTimeout(bootTimer);
        post(child, { k: 'envelope', envelope });
        return;
      }
      if (msg.k === 'result') {
        finish(msg.result);
        return;
      }
      // host-call: the ONLY route from the isolate to any host state. The broker
      // authenticates it against its own record — a forged dispatch id or token
      // is refused there, not here, because the adapter has no authority to
      // decide it with.
      void broker
        .hostCall(msg.req)
        .then((res) => {
          post(child, { k: 'host-call-response', seq: msg.seq, res });
          if (!res.ok && TERMINAL_REFUSALS.has(res.error.code)) {
            log.warn('isolated pack dispatch refused terminally; killing the isolate', {
              typeId: envelope.typeId, refusal: res.error.code,
            });
            hardKill(child);
          }
        })
        .catch((err: unknown) => {
          // `hostCall` documents that it never throws; if it ever does, the
          // isolate must not hang waiting for a response that will not come.
          post(child, {
            k: 'host-call-response',
            seq: msg.seq,
            res: { ok: false, error: { code: 'internal_error', message: clampFailureMessage(err instanceof Error ? err.message : String(err)) } },
          });
        });
    });

    child.on('error', (err) => {
      finish(failure(ISOLATION_WORKER_CRASHED_CODE, `isolated worker for '${envelope.typeId}' failed: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      // A result already received wins: the worker sends it and then exits, so
      // the exit is expected and carries no additional information.
      if (settled) return;
      if (timedOut) {
        finish(failure(
          ISOLATION_TIMEOUT_CODE,
          `Isolated dispatch of '${envelope.typeId}' exceeded its ${envelope.budget.wallClockMs}ms wall-clock budget and the isolate was killed.`,
        ));
        return;
      }
      if (looksLikeHeapExhaustion(stderr)) {
        finish(failure(
          ISOLATION_MEMORY_CODE,
          `Isolated dispatch of '${envelope.typeId}' exhausted its ${maxOldSpaceMb()}MB heap ceiling and the isolate was terminated.`,
        ));
        return;
      }
      finish(failure(
        ISOLATION_WORKER_CRASHED_CODE,
        clampFailureMessage(
          `isolated worker for '${envelope.typeId}' exited (code=${String(code)} signal=${String(signal)}) without submitting a result`
          + (stderr ? `: ${stderr.trim()}` : '')
          + (stdout ? ` [stdout: ${stdout.trim()}]` : ''),
        ),
      ));
    });
  });
}

/* -------------------------------------------------------------------------- *
 * internals
 * -------------------------------------------------------------------------- */

/** V8's abort message is the only reliable signal that a `--max-old-space-size`
 *  ceiling was the cause: the process dies on SIGABRT, which many other aborts
 *  also produce, so the SIGNAL alone would misfile ordinary crashes as capacity
 *  events — the mistake `classifySandboxError` documents for transport errors. */
function looksLikeHeapExhaustion(stderr: string): boolean {
  return /JavaScript heap out of memory|Allocation failed|Reached heap limit/i.test(stderr);
}

function post(child: ChildProcess, message: ParentMessage): void {
  if (!child.connected) return;
  try {
    child.send(message);
  } catch (err) {
    log.warn('could not reach the isolated pack worker', { error: err instanceof Error ? err.message : String(err) });
  }
}

function hardKill(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // SIGKILL, not SIGTERM: a pack that installs a SIGTERM handler could
    // otherwise decline to die, which would make every deadline advisory.
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function failure(code: string, message: string): DispatchResult {
  return { status: 'failure', error: { code, message: clampFailureMessage(message) }, variablesWrites: [] };
}

function outcomeOf(result: DispatchResult): 'ok' | 'suspended' | 'timeout' | 'memory_exceeded' | 'crashed' | 'failed' {
  if (result.status === 'success') return 'ok';
  if (result.status === 'suspended') return 'suspended';
  if (result.error.code === ISOLATION_TIMEOUT_CODE) return 'timeout';
  if (result.error.code === ISOLATION_MEMORY_CODE) return 'memory_exceeded';
  if (result.error.code === ISOLATION_WORKER_CRASHED_CODE) return 'crashed';
  return 'failed';
}
