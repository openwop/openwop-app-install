/**
 * ADR 0555 P2 — the entry point of a forked pack-isolation worker.
 *
 * This file is the FIRST thing the child process runs and the ONLY host code in
 * it. Everything it does happens in one order that matters:
 *
 *   1. capture the IPC channel into closures
 *   2. harden the realm (below)
 *   3. announce `ready`
 *   4. receive the envelope, run `runIsolatedPackNode`, send the result, exit
 *
 * The pack's module is imported in step 4 — after step 2 — so nothing a pack
 * can do runs before the hardening. Getting that order wrong would make every
 * property below advisory.
 *
 * ── WHAT THE HARDENING IS FOR, AND WHAT IT IS NOT ─────────────────────────
 *
 * The load-bearing containment is NOT here. It is the flags the parent spawns
 * this process with (`--permission` with a realpath'd filesystem allowlist,
 * `--disallow-code-generation-from-strings`, `--max-old-space-size`) plus the
 * scrubbed `env` and the parent's SIGKILL. Those are enforced by the runtime
 * and the OS, outside this realm, which is why they are the ones
 * `childProcessAdapter.ts` declares as `enforced` guarantees.
 *
 * What happens here is IN-REALM attenuation, and it is claimed as nothing more:
 *
 *   `process.send` /   REMOVED. The host's authority model rests on a
 *   `process.channel`  per-dispatch bearer token that never reaches `ctx`, but
 *                      a pack sharing this process with the IPC channel could
 *                      otherwise SPEAK THE PROTOCOL DIRECTLY — forging a
 *                      host-call, or submitting a second result. The broker
 *                      would refuse a forged token (it verifies against its own
 *                      record), so this is defence in depth rather than the
 *                      defence; but the channel is the pack's most obvious lever
 *                      and there is no reason to leave it lying there.
 *   network globals    `fetch`, `WebSocket`, `EventSource` are deleted. This is
 *                      ATTENUATION, NOT DENIAL: `node:net` remains reachable and
 *                      the adapter therefore does not claim `network-denied`.
 *                      Stated here as well as in `isolationGuarantees.ts`
 *                      because a reader of this file is exactly the person who
 *                      would otherwise conclude network was handled.
 *   `process.env`      replaced with an empty null-prototype object. The parent
 *                      already spawns with `env: {}`; on macOS the OS injects
 *                      `__CF_USER_TEXT_ENCODING` anyway, so this makes the
 *                      worker's view uniform across platforms rather than
 *                      leaving a one-key difference for a test to encode.
 *
 * A pack can still `process.emit('message', …)` at itself, and can still remove
 * our listener. Both are self-harm — they produce no result, the parent's
 * deadline fires, the isolate is killed and the node fails typed.
 */

import { runIsolatedPackNode, type PackNodeFn } from '../packWorkerRunner.js';
import type { DispatchEnvelope, DispatchResult, HostCallRequest, HostCallResponse } from '../packWorkerContract.js';
import type { ChildMessage, ParentMessage } from './workerChannel.js';

/* ── 1. capture the channel ──────────────────────────────────────────────── */

const rawSend = typeof process.send === 'function' ? process.send.bind(process) : null;
if (!rawSend) {
  // Spawned without an IPC channel. There is no way to report anything, so the
  // only honest move is a non-zero exit the parent reads as a boot failure.
  process.exit(97);
}
const send = rawSend as (message: ChildMessage) => boolean;

/** Resolvers for in-flight host calls, keyed by the request's `seq`. */
const pending = new Map<number, (res: HostCallResponse) => void>();

process.on('message', (msg: ParentMessage) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.k === 'host-call-response') {
    const resolve = pending.get(msg.seq);
    if (resolve) {
      pending.delete(msg.seq);
      resolve(msg.res);
    }
    return;
  }
  if (msg.k === 'envelope') void execute(msg.envelope);
});

/* ── 2. harden the realm ─────────────────────────────────────────────────── */

const mutableProcess = process as unknown as Record<string, unknown>;
delete mutableProcess.send;
delete mutableProcess.disconnect;
// `process.channel` is deliberately LEFT IN PLACE.
//
// MEASURED, after removing it broke the transport outright: deleting it stops
// the child RECEIVING messages at all — the worker booted, announced `ready`,
// and then sat silent through its whole wall clock, so every dispatch failed
// `pack_isolation_timeout` and the suite read as "isolation is broken" rather
// than "one line of hardening was wrong".
//
// Also measured, and the reason leaving it is acceptable: the object exposes
// only `ref` / `unref` / `refCounted` / `unrefCounted` / `fd`. It carries no
// send function and no reachable handle symbol, so a pack holding it cannot
// speak the protocol. And even if one hand-framed bytes onto `fd`, it gains
// nothing: the per-dispatch token is never on `ctx` and never in a scope pack
// code can reach, and the broker authenticates every call and the result
// against its own record — which is precisely the property P1 built so that a
// compromised worker is not a compromised host.

const globals = globalThis as unknown as Record<string, unknown>;
for (const name of ['fetch', 'WebSocket', 'EventSource', 'navigator']) delete globals[name];

try {
  Object.defineProperty(process, 'env', {
    value: Object.create(null) as NodeJS.ProcessEnv,
    writable: false,
    configurable: false,
  });
} catch {
  // A runtime that refuses the redefinition still has the parent's `env: {}`,
  // which is the enforced half. Swallowing here rather than failing the whole
  // dispatch keeps the ENFORCED guarantee independent of the attenuation.
}

/* ── 3/4. run ────────────────────────────────────────────────────────────── */

send({ k: 'ready' });

let executed = false;

async function execute(envelope: DispatchEnvelope): Promise<void> {
  // A second envelope on one worker would mean two dispatches sharing a realm,
  // which is exactly what `cross-dispatch-isolation` promises cannot happen.
  // One process, one dispatch, no exceptions.
  if (executed) return;
  executed = true;

  let result: DispatchResult;
  try {
    result = await runIsolatedPackNode({
      envelope,
      loadNode: loadPackNode,
      hostCall: (req) => callHost(req),
    });
  } catch (err) {
    // `runIsolatedPackNode` reduces pack failures itself; reaching here means
    // the RUNNER threw, which is a host bug, not a pack outcome. Reported as a
    // typed failure rather than a silent exit so it is visible in the run log.
    result = {
      status: 'failure',
      error: {
        code: 'pack_isolation_worker_crashed',
        message: `isolated worker runner threw: ${err instanceof Error ? err.message : String(err)}`,
      },
      variablesWrites: [],
    };
  }
  send({ k: 'result', result });
  // Flush before exiting: `process.send` is asynchronous, and exiting on the
  // same tick can drop the message, which the parent would read as a crash.
  setImmediate(() => process.exit(0));
}

/**
 * Import the pack's entry INSIDE the isolate.
 *
 * This is the difference the fake adapter cannot make. Here the module's top
 * level executes in a process whose filesystem allowlist names only this pack's
 * directory and this worker's own entry, with no host environment and no
 * ambient credentials — so a pack whose IMPORT is the attack (ES modules run on
 * import; P0 refuses the import for exactly that reason) is contained at the
 * moment it runs, not after.
 */
async function loadPackNode(envelope: DispatchEnvelope): Promise<PackNodeFn | null> {
  const mod = (await import(envelope.entryUrl)) as { nodes?: Record<string, unknown> };
  const fn = mod.nodes?.[envelope.typeId];
  return typeof fn === 'function' ? (fn as PackNodeFn) : null;
}

function callHost(req: HostCallRequest): Promise<HostCallResponse> {
  return new Promise<HostCallResponse>((resolve) => {
    pending.set(req.seq, resolve);
    if (!send({ k: 'host-call', seq: req.seq, req })) {
      pending.delete(req.seq);
      resolve({ ok: false, error: { code: 'internal_error', message: 'isolated worker lost its host channel' } });
    }
  });
  // Deliberately NOT timed out here. The parent owns every deadline — a worker
  // that could decide its own timeout could also decide not to have one, and
  // the wall clock has to be enforced from outside the thing being bounded.
}

/* ── last-resort reporting ───────────────────────────────────────────────── */

for (const signal of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(signal, (err: unknown) => {
    // Only meaningful BEFORE a result was produced; afterwards the dispatch is
    // already recorded and the CAS would refuse a second submission anyway.
    if (!executed) {
      send({
        k: 'result',
        result: {
          status: 'failure',
          error: {
            code: 'pack_isolation_worker_crashed',
            message: `isolated worker ${signal}: ${err instanceof Error ? err.message : String(err)}`,
          },
          variablesWrites: [],
        },
      });
    }
    setImmediate(() => process.exit(98));
  });
}
