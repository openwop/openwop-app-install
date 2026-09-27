/**
 * ADR 0531 — the run-scoped effect guard, the fail-closed backstop behind the
 * ADR 0341 replay side-effect guarantee.
 *
 * ADR 0341 stops a side-effecting node from firing during a replay by
 * classifying it on typeId. #2871 proved that allowlist drifts: 55 nodes were
 * retargeted onto a typeId the list did not match and silently left protection.
 * This suite pins the structural backstop that catches an UNCLASSIFIED node
 * reaching a real effect seam mid-replay.
 *
 * The load-bearing test is the last one. `assertEffectAllowed` reads an
 * AsyncLocalStorage store, which propagates through `await` but NOT across a
 * process/worker boundary. Pack nodes are loaded via dynamic `import()`
 * (`packs/tarballLoader.ts`) and execute in-process, so they inherit the
 * context today. If pack execution ever moves out-of-process (RFC 0035 sandbox,
 * RFC 0008 WASM ABI) the backstop degrades SILENTLY to no guard — and that test
 * is what goes red.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import {
  assertEffectAllowed,
  currentEffectContext,
  runWithEffectContext,
  ReplayEffectError,
  effectCountForRun,
  __resetEffectCountsForTest,
} from '../src/host/runEffectContext.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

/** Records every node execution that observed an ambient context. */
const seenContext: Array<{ typeId: string; replaying: boolean | 'absent' }> = [];

/**
 * Counts notifications that ACTUALLY LANDED. The emitter fans out only after
 * `insertNotification` resolves, so this counts durable rows — and unlike the
 * HTTP read it is independent of how the test principal's tenant resolves.
 */
let probesEmitted = 0;
let unsubscribe: (() => void) | undefined;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

  // An UNCLASSIFIED node that reaches a real effect seam. This is the #2871
  // shape: the typeId matches nothing in `sideEffects.ts`, so the ADR 0341 fast
  // path never short-circuits it and only the backstop stands between a replay
  // and a second real notification.
  getNodeRegistry().register({
    typeId: 'test.unclassified-notifier',
    version: '1.0.0',
    async execute(ctx) {
      const c = currentEffectContext();
      seenContext.push({ typeId: 'test.unclassified-notifier', replaying: c ? c.replaying : 'absent' });
      // A real await before the effect — ALS must survive it.
      await new Promise((r) => setTimeout(r, 1));
      await getNotificationEmitter().emit({
        tenantId: (ctx as { tenantId?: string }).tenantId ?? '_anon',
        type: 'adr0531.probe',
        priority: 'normal',
        title: 'probe',
        message: 'adr0531',
      });
      return { status: 'success', outputs: { output: 'notified' } };
    },
  });

  // The tripwire node: its `execute` comes from a DYNAMICALLY IMPORTED module,
  // mirroring how `packs/tarballLoader.ts` loads pack nodes. If ALS ever stops
  // crossing that boundary, this node stops seeing the context.
  const dir = mkdtempSync(join(tmpdir(), 'adr0531-'));
  const modPath = join(dir, 'packlike.mjs');
  writeFileSync(
    modPath,
    `export async function execute(_ctx, probe) {\n` +
      `  await new Promise((r) => setTimeout(r, 1));\n` +
      `  probe();\n` +
      `  return { status: 'success', outputs: { output: 'pack-ok' } };\n` +
      `}\n`,
  );
  unsubscribe = getNotificationEmitter().subscribe((n) => {
    if (n.type === 'adr0531.probe') probesEmitted += 1;
  });

  const packlike = (await import(pathToFileURL(modPath).href)) as {
    execute(ctx: unknown, probe: () => void): Promise<{ status: string; outputs: Record<string, unknown> }>;
  };
  getNodeRegistry().register({
    typeId: 'test.packlike-notifier',
    version: '1.0.0',
    async execute(ctx) {
      return (await packlike.execute(ctx, () => {
        const c = currentEffectContext();
        seenContext.push({ typeId: 'test.packlike-notifier', replaying: c ? c.replaying : 'absent' });
        // The guard call a real seam would make, from inside the imported module's
        // async continuation.
        assertEffectAllowed('network-egress', 'packlike probe');
      })) as { status: 'success'; outputs: Record<string, unknown> };
    },
  });
});

afterAll(async () => {
  unsubscribe?.();
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function settle(runId: string): Promise<string> {
  let status = 'pending';
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 25));
    status = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  return status;
}

async function runWorkflow(workflowId: string, typeId: string): Promise<string> {
  await api('/v1/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n1', typeId }], edges: [] }),
  });
  const create = await api<{ runId: string }>('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }),
  });
  expect(create.status).toBe(201);
  await settle(create.body.runId);
  return create.body.runId;
}


describe('assertEffectAllowed — the guard contract', () => {
  it('is a no-op outside a run (routes and daemons are not replays)', () => {
    expect(currentEffectContext()).toBeUndefined();
    expect(() => assertEffectAllowed('network-egress')).not.toThrow();
  });

  it('allows effects during a LIVE run', () => {
    runWithEffectContext({ runId: 'r1', replaying: false }, () => {
      expect(() => assertEffectAllowed('notification')).not.toThrow();
    });
  });

  it('fails closed during a replay, with the ADR 0341 error code', () => {
    runWithEffectContext({ runId: 'r1', replaying: true }, () => {
      try {
        assertEffectAllowed('email', 'probe');
        expect.unreachable('the guard must throw during a replay');
      } catch (err) {
        expect(err).toBeInstanceOf(ReplayEffectError);
        // Same code the ADR 0341 fast path emits — one invariant, one code.
        expect((err as ReplayEffectError).code).toBe('replay_source_missing');
      }
    });
  });

  it('survives an await — ALS propagation, not call-stack proximity', async () => {
    await runWithEffectContext({ runId: 'r1', replaying: true }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(() => assertEffectAllowed('notification')).toThrow(ReplayEffectError);
    });
  });
});

describe('the scenario actually exercises the BACKSTOP, not the fast path', () => {
  it('the probe nodes are unclassified — if this fails, the tests below prove nothing', () => {
    // Were these classified, ADR 0341 would short-circuit them and the backstop
    // would never be reached. Broadening the regex must fail HERE, loudly,
    // rather than silently turning the suite below into a tautology.
    expect(isSideEffectingNode('test.unclassified-notifier')).toBe(false);
    expect(isSideEffectingNode('test.packlike-notifier')).toBe(false);
  });
});

describe('end-to-end: a replay fork cannot re-notify', () => {
  it('a live run notifies once; its replay fork fails closed and does NOT notify again', async () => {
    const runId = await runWorkflow('adr0531.notify', 'test.unclassified-notifier');
    expect(probesEmitted).toBe(1);

    const fork = await api<{ runId: string }>(`/v1/runs/${runId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'replay' }),
    });
    expect(fork.status).toBe(201);
    const forkStatus = await settle(fork.body.runId);

    // The node re-executed (it is unclassified, so no recorded outcome was
    // served) and hit the seam — which refused.
    expect(forkStatus).toBe('failed');
    const events = (await api<{ events?: Array<{ type?: string; payload?: { error?: { code?: string } } }> }>(
      `/v1/runs/${fork.body.runId}/debug-bundle`,
    )).body.events ?? [];
    const failure = events.find((e) => e.type === 'node.failed');
    expect(failure?.payload?.error?.code).toBe('replay_source_missing');

    // The invariant that actually matters: no second notification reached a human.
    expect(probesEmitted).toBe(1);
  });

  it('the executor establishes the context on EVERY node execution, live and replay', () => {
    const forNode = seenContext.filter((s) => s.typeId === 'test.unclassified-notifier');
    expect(forNode.length).toBeGreaterThanOrEqual(2); // the live run + the fork
    // Never 'absent'. If the context were established only during replays,
    // "absent" would silently mean "not replaying" — the same fail-open shape
    // this guard exists to remove.
    expect(forNode.some((s) => s.replaying === 'absent')).toBe(false);
    expect(forNode.some((s) => s.replaying === false)).toBe(true); // live
    expect(forNode.some((s) => s.replaying === true)).toBe(true); // replay
  });
});

describe('every declared effect seam actually installs the guard', () => {
  // Behavioral, not a source grep: each seam is CALLED inside a replaying
  // context and must refuse. The guard fires before any dial/credential
  // resolution, so none of these touch the network. A refactor that drops a
  // guard call goes red here rather than silently un-protecting the seam.

  it('network-egress — brokeredFetch refuses', async () => {
    const { brokeredFetch } = await import('../src/host/brokeredEgress.js');
    await expect(
      runWithEffectContext({ runId: 'r', replaying: true }, () =>
        brokeredFetch({ tenantId: '_anon' }, { provider: 'slack', url: 'https://slack.com/api/x' }),
      ),
    ).rejects.toBeInstanceOf(ReplayEffectError);
  });

  it('network-egress — brokeredPost refuses before the credential is resolved', async () => {
    const { brokeredPost } = await import('../src/host/brokeredEgress.js');
    await expect(
      runWithEffectContext({ runId: 'r', replaying: true }, () =>
        brokeredPost({ tenantId: '_anon' }, { provider: 'slack', url: 'https://slack.com/api/x', body: '{}' }),
      ),
    ).rejects.toBeInstanceOf(ReplayEffectError);
  });

  it('email — the SMTP dial guard refuses', async () => {
    const { assertSmtpDialAllowed } = await import('../src/host/smtpEgress.js');
    await expect(
      runWithEffectContext({ runId: 'r', replaying: true }, () =>
        assertSmtpDialAllowed('_anon', 'smtp.example.com', 587),
      ),
    ).rejects.toBeInstanceOf(ReplayEffectError);
  });

  it('the seams stay live outside a replay', async () => {
    const { assertSmtpDialAllowed } = await import('../src/host/smtpEgress.js');
    // Deliberately tolerant of BOTH settlements: this call may resolve (host
    // allowed) or reject on DNS/policy depending on the sandbox, and asserting
    // either one would make the test depend on network conditions. The only
    // claim being made is the one that matters — whatever happened, the REPLAY
    // guard is not what happened.
    await runWithEffectContext({ runId: 'r', replaying: false }, async () => {
      const err = await assertSmtpDialAllowed('_anon', 'smtp.example.com', 587).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeInstanceOf(ReplayEffectError);
    });
  });
});

describe('the guard is scoped to REPLAY mode, and that boundary is deliberate', () => {
  it('a BRANCH fork stays live — its effects are effects the operator asked for', async () => {
    // `replayInvocationsFromRunId` is set only for mode:'replay' (routes/runs.ts),
    // so a branch never populates `sourceOutcomes` and neither the ADR 0341 fast
    // path nor this guard applies. A branch is a NEW execution exploring a real
    // alternative ("what if we'd approved at step N"), not a duplicate of fixed
    // history. Pinned as a test so the boundary is a fact, not just an ADR claim.
    const runId = await runWorkflow('adr0531.branch', 'test.unclassified-notifier');
    const before = probesEmitted;

    const fork = await api<{ runId: string }>(`/v1/runs/${runId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'branch', fromSeq: 1 }),
    });
    expect(fork.status).toBe(201);
    expect(await settle(fork.body.runId)).toBe('completed');

    // The branch DID notify — one more than before.
    expect(probesEmitted).toBe(before + 1);
  });
});

describe('TRIPWIRE — the backstop reaches dynamically-imported (pack-shaped) nodes', () => {
  it('a node whose execute lives in an imported module still sees the context', async () => {
    const runId = await runWorkflow('adr0531.packlike', 'test.packlike-notifier');
    expect(await settle(runId)).toBe('completed');

    const fork = await api<{ runId: string }>(`/v1/runs/${runId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'replay' }),
    });
    expect(fork.status).toBe(201);
    expect(await settle(fork.body.runId)).toBe('failed');

    const seen = seenContext.filter((s) => s.typeId === 'test.packlike-notifier');
    // THE assertion. If pack execution moves out-of-process, ALS stops
    // propagating and this reads 'absent' — the guard is gone and every
    // pack-shaped node silently loses replay protection.
    expect(seen.some((s) => s.replaying === 'absent')).toBe(false);
    expect(seen.some((s) => s.replaying === true)).toBe(true);
  });
});

/* ========================================================================= *
 * ADR 0533 — the effect COUNTER, and the egress seam the guard newly covers
 * ========================================================================= */

describe('ADR 0533 — the per-run effect counter sits on the guard seam', () => {
  it('counts an effect that ESCAPED, attributed to the run whose node performed it', () => {
    __resetEffectCountsForTest();
    expect(effectCountForRun('count-a')).toBe(0);
    runWithEffectContext({ runId: 'count-a', replaying: false }, () => {
      assertEffectAllowed('notification', 'one');
      assertEffectAllowed('network-egress', 'two');
    });
    runWithEffectContext({ runId: 'count-b', replaying: false }, () => {
      assertEffectAllowed('email', 'other run');
    });
    expect(effectCountForRun('count-a')).toBe(2);
    // Per-run, never pooled: `host-sample-test-seams.md` §20 requires a replay
    // that wrongly fires to increment the REPLAY's count, not the source's.
    expect(effectCountForRun('count-b')).toBe(1);
  });

  it('does NOT count a guard-DENIED attempt — nothing escaped', () => {
    __resetEffectCountsForTest();
    runWithEffectContext({ runId: 'count-denied', replaying: true }, () => {
      expect(() => assertEffectAllowed('notification', 'blocked')).toThrow(ReplayEffectError);
    });
    // The whole point of the counter is "did an effect leave this host". A
    // denied attempt did not, so counting it would report an effect that
    // provably never happened — and would red the RFC 0140 scenario against a
    // host whose backstop worked exactly as specified.
    expect(effectCountForRun('count-denied')).toBe(0);
  });

  it('does not count effects performed outside a run (routes, daemons)', () => {
    __resetEffectCountsForTest();
    assertEffectAllowed('network-egress', 'no ambient run');
    expect(effectCountForRun('')).toBe(0);
  });
});

describe('ADR 0533 — the undici egress dispatcher is a guarded seam', () => {
  it('webhookEgressDispatcher() refuses during a replay', async () => {
    const { webhookEgressDispatcher } = await import('../src/host/webhookEgressGuard.js');
    runWithEffectContext({ runId: 'r', replaying: true }, () => {
      expect(() => webhookEgressDispatcher()).toThrow(ReplayEffectError);
    });
  });

  it('webhookEgressDispatcher() stays live outside a replay', async () => {
    const { webhookEgressDispatcher } = await import('../src/host/webhookEgressGuard.js');
    runWithEffectContext({ runId: 'r', replaying: false }, () => {
      expect(webhookEgressDispatcher()).toBeDefined();
    });
  });

  it('guardedEgressFetch inherits the guard through the dispatcher', async () => {
    const { guardedEgressFetch } = await import('../src/host/webhookEgressGuard.js');
    await expect(
      runWithEffectContext({ runId: 'r', replaying: true }, () =>
        guardedEgressFetch('https://example.com/x'),
      ),
    ).rejects.toBeInstanceOf(ReplayEffectError);
  });

  it('ctx.http.safeFetch refuses during a replay — the hole the tripwire missed', async () => {
    // The BEHAVIORAL half of the widened tripwire above. `ctx.http.safeFetch`
    // is the RFC 0076 §B surface ten `role: "side-effect"` http nodes route
    // through (`openapi-call`, `graphql-mutation`, `soap-call`, `grpc-unary`,
    // `long-poll`, `upload-multipart`, `upload-resumable`,
    // `retry-rate-limit-aware`, `circuit-breaker`) — none of them in
    // `SIDE_EFFECTING_TYPE_PATTERNS`, so the fast path never served their
    // recorded outcome and the backstop was absent too. A replay fork made the
    // real request a second time.
    //
    // Asserting the TYPE, not merely "it threw": safeFetch appends an RFC 0064
    // audit event before egress, so a bare `.rejects` would also be satisfied
    // by an event-log failure — passing for a reason unrelated to the guard.
    const { makeConnectionSafeFetch } = await import('../src/host/connectionInjection.js');
    const safeFetch = makeConnectionSafeFetch({
      storage: {} as never,
      tenantId: '_anon',
      runId: 'r',
      allowedProviders: [],
    });
    await expect(
      runWithEffectContext({ runId: 'r', replaying: true }, () => safeFetch('https://example.com/x')),
    ).rejects.toBeInstanceOf(ReplayEffectError);
  });

  it('dispatch — a cross-host sub-run dispatch refuses (replay.md rule 6)', async () => {
    const { dispatchSubRun } = await import('../src/subruns/subRunDispatcher.js');
    await expect(
      runWithEffectContext({ runId: 'r', replaying: true }, () =>
        dispatchSubRun({ workflowId: 'wf', inputs: {}, tenantId: '_anon' } as Parameters<typeof dispatchSubRun>[0]),
      ),
    ).rejects.toBeInstanceOf(ReplayEffectError);
  });

  it('TRIPWIRE — every undici `dispatcher:` getter reaches assertEffectAllowed', () => {
    // WIDENED, and the widening is the point. This test used to scan for the
    // literal shape `const x = webhookEgressDispatcher()` — one syntactic proxy
    // for the real property. `connectionInjection.ts` hoisted an Agent from a
    // DIFFERENT factory (`makeGuardedAgent`) into `safeFetchAgent`, so it never
    // matched, and `ctx.http.safeFetch` — the RFC 0076 §B surface ten
    // `role: "side-effect"` http nodes route through — performed live outbound
    // requests during a replay fork while this test stayed green.
    //
    // So bind the PROPERTY, not the shape: whatever function supplies a
    // `dispatcher:` in a fetch init must reach `assertEffectAllowed` on every
    // call. A hoisted Agent is fine; a hoisted GUARD is not.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const getters = new Map<string, Set<string>>(); // file -> dispatcher getter names
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (entry.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);

    for (const p of files) {
      const src = readFileSync(p, 'utf-8');
      // `dispatcher: someGetter()` — the inline form every egress site uses.
      for (const m of src.matchAll(/\bdispatcher:\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (!getters.has(p)) getters.set(p, new Set());
        getters.get(p)!.add(m[1]);
      }
    }
    // The scan must find the known sites, or an upstream rename would make this
    // whole test vacuous — green because it inspected nothing.
    const found = [...getters.values()].flatMap((s) => [...s]);
    expect(found, 'the dispatcher scan matched nothing — the test would pass vacuously').not.toHaveLength(0);
    expect(new Set(found)).toContain('webhookEgressDispatcher');
    expect(new Set(found)).toContain('safeFetchDispatcher');

    // Resolve each getter to its definition (same file or the file it is
    // imported from) and require `assertEffectAllowed` inside its body.
    const offenders: string[] = [];
    for (const [p, names] of getters) {
      const src = readFileSync(p, 'utf-8');
      for (const name of names) {
        let body: string | null = bodyOf(src, name);
        if (body === null) {
          // Imported — find the module it came from and read it there.
          const imp = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'([^']+)'`).exec(src);
          if (imp) {
            const target = join(dirname(p), imp[1].replace(/\.js$/, '.ts'));
            if (existsSync(target)) body = bodyOf(readFileSync(target, 'utf-8'), name);
          }
        }
        if (body === null) { offenders.push(`${p}: could not resolve \`${name}\` — cannot prove it is guarded`); continue; }
        if (!body.includes('assertEffectAllowed(')) offenders.push(`${p}: \`${name}()\` supplies a dispatcher without assertEffectAllowed`);
      }
    }
    expect(offenders, 'an unguarded dispatcher getter lets a replay fire a real request').toEqual([]);
  });
});

/** Extract `function <name>(…) { … }`'s body by brace matching. Null when the
 *  file does not define it (it is imported from elsewhere). */
function bodyOf(src: string, name: string): string | null {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!decl) return null;
  const open = src.indexOf('{', decl.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}
