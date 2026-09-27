/**
 * ADR 0555 P2 — a harness that runs a REAL pack through the REAL child-process
 * isolation adapter.
 *
 * Shared by `pack-isolation-escape.test.ts` and
 * `pack-isolation-child-adapter.test.ts` so the two suites cannot disagree
 * about what "isolated" means. Everything below is the production path: the
 * production adapter, the production broker, the production dispatch registry.
 * The only fixture is the pack itself.
 *
 * `report` is the one affordance the harness adds: a granted host-call the pack
 * uses to send an observation back to the test. It is a normal brokered call —
 * it goes through the grant check, the token check and the effect/authority
 * wrappers like any other — so using it does not bypass anything under test.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { issueDispatch } from '../../src/host/packDispatchRegistry.js';
import { createPackHostCallBroker } from '../../src/host/packHostCallBroker.js';
import { createChildProcessIsolationAdapter } from '../../src/host/isolation/childProcessAdapter.js';
import {
  DISPATCH_PROTOCOL_VERSION,
  type DispatchEnvelope,
  type DispatchResult,
} from '../../src/host/packWorkerContract.js';
import type { RunEffectContext } from '../../src/host/runEffectContext.js';
import type { AuthorityFacts } from '../../src/host/authorityContext.js';
import type { NodeContext } from '../../src/executor/types.js';

export const TYPE_ID = 'community.test.isolation.probe';
export const PACK_NAME = 'community.test.isolation';

/** Write a one-node pack whose function body is `body`, and return its dir. */
export function writeProbePack(body: string, opts: { readonly dirPrefix?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), opts.dirPrefix ?? 'owp-iso-pack-'));
  writeFileSync(
    join(dir, 'index.mjs'),
    `export const nodes = {\n  ${JSON.stringify(TYPE_ID)}: async (ctx) => {\n${body}\n  },\n};\n`,
    'utf-8',
  );
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify({ name: PACK_NAME, version: '1.0.0', kind: 'nodes', nodes: [{ typeId: TYPE_ID }] }),
    'utf-8',
  );
  return dir;
}

export interface RunProbeOptions {
  /** Extra ctx surfaces the pack may call. `report` is always present. */
  readonly ctx?: Partial<NodeContext>;
  /** Grant keys beyond `report`. */
  readonly grant?: readonly string[];
  readonly wallClockMs?: number;
  readonly maxHostCalls?: number;
  readonly effectCtx?: RunEffectContext;
  readonly authority?: AuthorityFacts | null;
  readonly variablesSnapshot?: Record<string, unknown>;
  readonly suspendResolution?: { readonly resumeKey: string; readonly value: unknown };
  readonly inputs?: unknown;
  /** Mutate the envelope just before dispatch — for tamper cases. */
  readonly tamper?: (envelope: DispatchEnvelope) => DispatchEnvelope;
}

export interface ProbeRun {
  readonly result: DispatchResult;
  /** Everything the pack passed to `ctx.report(...)`, in call order. */
  readonly reported: unknown[];
  readonly dispatchId: string;
}

/**
 * Run one probe pack in a real isolate.
 *
 * The adapter is constructed per call rather than memoized: each test may set a
 * different `OPENWOP_PACK_ISOLATION_*` knob, and an adapter caches its
 * concurrency semaphore at construction.
 */
export async function runProbe(packDir: string, options: RunProbeOptions = {}): Promise<ProbeRun> {
  const reported: unknown[] = [];
  const grant = new Set<string>(['report', ...(options.grant ?? [])]);
  const ctx = {
    runId: 'run-iso-probe',
    nodeId: 'n-probe',
    tenantId: 't-probe',
    inputs: options.inputs ?? {},
    configurable: {},
    attempt: 1,
    secrets: {},
    emit: async () => ({ eventId: 'e', sequence: 1 }),
    report: async (value: unknown) => {
      reported.push(value);
      return { ok: true };
    },
    ...options.ctx,
  } as unknown as NodeContext;

  const effectCtx: RunEffectContext = options.effectCtx ?? { runId: 'run-iso-probe', replaying: false };
  const budget = {
    wallClockMs: options.wallClockMs ?? 20_000,
    maxHostCalls: options.maxHostCalls ?? 50,
    maxResultBytes: 1_048_576,
  };

  const issued = issueDispatch({
    runId: 'run-iso-probe',
    nodeId: 'n-probe',
    tenantId: 't-probe',
    typeId: TYPE_ID,
    packName: PACK_NAME,
    packVersion: '1.0.0',
    effectCtx,
    authority: options.authority ?? null,
    grant,
    budget,
  });

  let envelope: DispatchEnvelope = {
    protocol: DISPATCH_PROTOCOL_VERSION,
    dispatchId: issued.dispatchId,
    token: issued.token,
    typeId: TYPE_ID,
    packName: PACK_NAME,
    packVersion: '1.0.0',
    entryUrl: pathToFileURL(join(packDir, 'index.mjs')).toString(),
    runId: 'run-iso-probe',
    nodeId: 'n-probe',
    tenantId: 't-probe',
    inputs: options.inputs ?? {},
    configurable: {},
    attempt: 1,
    trustBoundary: 'untrusted',
    budget,
    capabilityGrant: [...grant].sort(),
    variablesSnapshot: options.variablesSnapshot ?? {},
    ...(options.suspendResolution ? { suspendResolution: options.suspendResolution } : {}),
  };
  if (options.tamper) envelope = options.tamper(envelope);

  const broker = createPackHostCallBroker({ dispatchId: issued.dispatchId, ctx, grant });
  const adapter = createChildProcessIsolationAdapter();
  const result = await adapter.dispatch(envelope, broker);
  return { result, reported, dispatchId: issued.dispatchId };
}

/**
 * Body helper: try `expr`, report `{ ok, value }` or `{ denied, code }`.
 *
 * Every escape probe reports BOTH arms rather than asserting inside the pack —
 * a probe that threw would be indistinguishable from a probe that never ran,
 * and "the escape was denied" must not be provable by the pack simply failing
 * to execute.
 */
export function probeBody(label: string, expr: string): string {
  return `
    try {
      const value = await (async () => { ${expr} })();
      await ctx.report({ label: ${JSON.stringify(label)}, ok: true, value: String(value).slice(0, 120) });
    } catch (err) {
      await ctx.report({ label: ${JSON.stringify(label)}, ok: false, code: String(err && err.code || err && err.name), message: String(err && err.message || err).slice(0, 160) });
    }
    return { status: 'success', outputs: {} };`;
}

/** The single reported record for a `probeBody` probe. */
export function probeOf(run: ProbeRun, label: string): { ok: boolean; code?: string; value?: string; message?: string } {
  const found = run.reported.find((r) => (r as { label?: string })?.label === label);
  if (!found) throw new Error(`probe '${label}' reported nothing (result: ${JSON.stringify(run.result)})`);
  return found as { ok: boolean; code?: string; value?: string; message?: string };
}
