/**
 * RFC 0158 / ADR 0739 — the durability kill seam, driven the way
 * `v2-durability-recovery.test.ts` drives it (major-2 paths, the caller's own
 * bearer), with the terminator swapped for a recorder: the default is a real
 * SIGKILL to this process, which here is the vitest worker.
 *
 * What a real death proves is the supervised lane's job
 * (`scripts/conformance-durability.sh`). What THIS file proves is the state the
 * host is in AT the moment it would die — because that state is the whole
 * claim: an `after-accept` exercise that had quietly dispatched, or a
 * `during-execution` one that died before `run.started`, would still "kill a
 * process" and would witness nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { createApp } from '../src/index.js';
import { markOwnProcess, resetOwnProcessForTests } from '../src/host/processIdentity.js';
import { setDurabilityTerminatorForTests, SEAM_MODES, DUPLICATE_DELIVERY_WORKFLOW_ID, HTTP_EFFECT_WORKFLOW_ID } from '../src/routes/durabilitySeam.js';
import { declaredRecoveryBoundMs } from '../src/host/recoveryBound.js';
import type { Storage } from '../src/storage/storage.js';

let server: Server; let base = ''; let storage: Storage;
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const KILL = '/host/durability/kill';
const BOUND = '/host/durability/bound';

let deaths = 0;
/** Resolves at the next (recorded) death, with the run's state AT that instant. */
let onDeath: ((runId: string) => void) | null = null;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  // safeFetch's OWN relaxation flag (not the webhook worker's): the receiver below is on loopback.
  process.env.OPENWOP_SAFEFETCH_ALLOW_PRIVATE = 'true';
  // BEFORE markOwnProcess — the default terminator is a genuine SIGKILL.
  setDurabilityTerminatorForTests((ctx) => { deaths++; onDeath?.(ctx.runId); });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { resetOwnProcessForTests(); onDeath = null; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; });
afterAll(async () => {
  setDurabilityTerminatorForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
const bareRunId = (wire: unknown): string => String(wire).split('/').pop() as string;
const startedCount = async (runId: string): Promise<number> =>
  (await storage.listEvents(runId)).filter((e) => e.type === 'run.started').length;

describe('RFC 0158 durability seam — the gate (ADR 0739 D1)', () => {
  it('answers 404 under createApp even with the seam flag ON — this process is the harness', async () => {
    // No markOwnProcess(). This is the in-process conformance lane's state, and
    // the 404 is what keeps a real SIGKILL away from it.
    expect((await call('GET', KILL)).status).toBe(404);
    expect((await call('GET', BOUND)).status).toBe(404);
    const before = deaths;
    expect((await call('POST', KILL, { mode: 'after-accept', workflowId: 'conformance-noop' })).status).toBe(404);
    expect(deaths, 'a refused request reached the terminator').toBe(before);
  });

  it('answers 404 as its own process when the seam flag is OFF — the production posture', async () => {
    markOwnProcess();
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'false';
    expect((await call('GET', KILL)).status).toBe(404);
    const before = deaths;
    expect((await call('POST', KILL, { mode: 'during-execution', workflowId: 'conformance-noop' })).status).toBe(404);
    expect(deaths).toBe(before);
  });

  it('the PROBE answers 200 and kills nothing', async () => {
    markOwnProcess();
    const before = deaths;
    const r = await call('GET', KILL);
    expect(r.status).toBe(200);
    expect(r.json['modes']).toEqual([...SEAM_MODES]);
    expect(deaths, 'probing the seam fired it').toBe(before);
  });

  it('refuses an unknown mode and an unresolvable workflow WITHOUT dying', async () => {
    markOwnProcess();
    const before = deaths;
    expect((await call('POST', KILL, { mode: 'politely-exit', workflowId: 'conformance-noop' })).status).toBe(400);
    expect((await call('POST', KILL, { mode: 'after-accept' })).status).toBe(400);
    expect((await call('POST', KILL, { mode: 'after-accept', workflowId: 'no-such-workflow-xyz' })).status).toBe(404);
    expect(deaths).toBe(before);
  });
});

describe('RFC 0158 durability seam — the state AT the moment of death (D2)', () => {
  it('after-accept: the run is durable, PENDING and UNDISPATCHED when the process dies', async () => {
    markOwnProcess();
    let atDeath: { status?: string; starts: number } | null = null;
    const died = new Promise<void>((resolve) => {
      onDeath = (runId) => {
        void (async () => {
          const run = await storage.getRun(runId);
          atDeath = { status: run?.status, starts: await startedCount(runId) };
          resolve();
        })();
      };
    });
    const before = deaths;
    const r = await call('POST', KILL, { mode: 'after-accept', workflowId: 'conformance-noop' });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    expect(r.json['recoveryClass']).toBe('unleased');
    expect(r.json['recoveryBoundMs']).toBe(declaredRecoveryBoundMs('unleased'));
    const runIdForProbe = bareRunId(r.json['runId']);
    await died;
    expect(deaths).toBe(before + 1);
    expect(atDeath, 'the death hook never observed the run').not.toBeNull();
    expect(atDeath!.status, 'the accepted run was not durable at the moment of death').toBe('pending');
    expect(atDeath!.starts, 'the hold did not hold — the run had already dispatched').toBe(0);

    // And the durable INTENT exists: the outbox lane — which is what a restarted
    // process runs — can see this run. Without this row the run is `pending`
    // forever and the recovery the row witnesses cannot happen.
    const outbox = await storage.getDispatchOutbox(runIdForProbe);
    expect(outbox, 'no dispatch_outbox row for the held run').not.toBeNull();
  });

  it('during-execution: the process dies with the run RUNNING and LEASED — the class its label claims', async () => {
    markOwnProcess();
    let atDeath: { status?: string; starts: number; leaseMsLeft: number; nodeStarts: number } | null = null;
    const died = new Promise<void>((resolve) => {
      onDeath = (runId) => {
        // In this file the "death" is recorded and the process lives on, so the
        // run goes on to finish and its STATUS is not stable to assert. The lease
        // and the event counts are: neither is rolled back by completion here.
        void (async () => {
          const run = await storage.getRun(runId);
          atDeath = {
            status: run?.status,
            starts: await startedCount(runId),
            leaseMsLeft: (run?.dispatchLeaseExpiresAt ?? 0) - Date.now(),
            nodeStarts: (await storage.listEvents(runId)).filter((e) => e.type === 'node.started').length,
          };
          resolve();
        })();
      };
    });
    const before = deaths;
    const r = await call('POST', KILL, { mode: 'during-execution', workflowId: 'conformance-noop' });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    expect(r.json['recoveryClass']).toBe('leased');
    expect(r.json['recoveryBoundMs']).toBe(declaredRecoveryBoundMs('leased'));
    await died;
    expect(deaths, 'the terminator must fire exactly once per exercise').toBe(before + 1);
    expect(atDeath!.starts, 'died before run.started was durable — nothing was executing').toBeGreaterThanOrEqual(1);
    expect(atDeath!.nodeStarts, 'died before any node started — that is the UNLEASED window, not execution').toBeGreaterThanOrEqual(1);
    // The label is a CLAIM about which mechanism must recover this run. Pin it:
    // a lease must actually be held, with most of its life left, or `leased` /
    // 750 s describes an exercise that the fast outbox lane quietly rescues.
    expect(atDeath!.leaseMsLeft, 'no live dispatch lease at death — the exercise is mislabelled `leased`').toBeGreaterThan(600_000);
  });
});

describe('RFC 0158 durability seam — bound-is-derived (D3)', () => {
  it('each class sums EXACTLY to the bound recoveryBound.ts declares, and the class is NAMED', async () => {
    markOwnProcess();
    for (const cls of ['unleased', 'leased'] as const) {
      const r = await call('GET', `${BOUND}?class=${cls}`);
      expect(r.status).toBe(200);
      expect(r.json['class']).toBe(cls);
      const terms = r.json['terms'] as Array<{ name: string; ms: number }>;
      expect(terms.length, 'a total with no addends cannot be recomputed').toBeGreaterThan(0);
      const sum = terms.reduce((a, t) => a + t.ms, 0);
      expect(sum).toBe(r.json['bound']);
      expect(r.json['bound'], 'the seam STATED a number instead of projecting the mechanism').toBe(declaredRecoveryBoundMs(cls));
    }
    // Literals, so a silently retuned sweeper reds HERE and gets a decision,
    // rather than quietly changing a published conformance figure.
    expect(declaredRecoveryBoundMs('unleased')).toBe(65_000);
    expect(declaredRecoveryBoundMs('leased')).toBe(750_000);
  });

  it('the bare read names its class rather than serving an anonymous scalar', async () => {
    markOwnProcess();
    const r = await call('GET', BOUND);
    expect(r.status).toBe(200);
    expect(r.json['class']).toBe('leased');
    expect(Object.keys(r.json['classes'] as object).sort()).toEqual(['leased', 'unleased']);
    expect((await call('GET', `${BOUND}?class=fastest`)).status).toBe(400);
  });
});

describe('RFC 0158 durability seam — duplicate-delivery (D4, §C)', () => {
  it('two REAL concurrent deliveries of one run fire each effect exactly once, per identity', async () => {
    markOwnProcess();
    const before = deaths;
    const firedBefore = (await storage.listNotifications({ tenantId: 'default', limit: 200, includeArchived: true }))
      .filter((n) => n.type === 'conformance.side-effect').length;
    // No workflowId — the 2.32.0 request shape. The seam chooses effectful work.
    const r = await call('POST', KILL, { mode: 'duplicate-delivery' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(deaths, 'duplicate-delivery must not kill anything').toBe(before);
    expect(r.json['workflowId']).toBe(DUPLICATE_DELIVERY_WORKFLOW_ID);
    // Non-vacuity: BOTH deliveries actually ran. One delivery cannot double-fire,
    // so a seam that quietly delivered once would pass every count below.
    // TWO deliveries were attempted; ONE executed and the other was refused by
    // the execution claim (ADR 0740) — from `executeRun`'s own return values.
    // Before the fence both executed (`run.started` ×2) and the second was
    // stopped only by accident, inside `core.delay`, by the terminal check.
    expect([...(r.json['deliveries'] as string[])].sort()).toEqual(['duplicate-refused', 'executed']);
    // The refused delivery wrote NOTHING — not even a `run.started`.
    expect(await startedCount(bareRunId(r.json['runId'])), 'a refused duplicate still appended run.started').toBe(1);

    const eff = await call('GET', `/runs/${encodeURIComponent(String(r.json['runId']))}/effects`);
    expect(eff.status).toBe(200);
    const effects = eff.json['effects'] as Array<{ effectId?: string; keying?: string }>;
    // The suite records `blocked` on an empty projection — "there is no identity
    // to count invocations against". Pin it here so that is caught in this repo.
    expect(effects.length, 'the chosen work recorded NO effect — the row would be `blocked`').toBeGreaterThan(0);
    const byIdentity = new Map<string, number>();
    for (const e of effects) {
      const id = String(e.effectId ?? e.keying ?? '');
      expect(id, 'an effect row with no identity cannot be counted').not.toBe('');
      byIdentity.set(id, (byIdentity.get(id) ?? 0) + 1);
    }
    const doubled = [...byIdentity.entries()].filter(([, n]) => n > 1);
    expect(doubled, `effect(s) fired more than once: ${JSON.stringify(doubled)}`).toEqual([]);

    // THE INDEPENDENT ORACLE — and the reason this test is not a mirror of the
    // scenario. `/effects` projects `invocation_log`, whose primary key IS the
    // effect identity: a double-fire writes the same key twice and collapses to
    // ONE row, so the per-identity count above stays 1 on the exact defect it
    // exists to catch. So count the REAL effect. (Sabotage-proved by making the
    // emitter insert twice: the per-identity count stayed 1, this went red.)
    const fired = (await storage.listNotifications({ tenantId: 'default', limit: 200, includeArchived: true }))
      .filter((n) => n.type === 'conformance.side-effect');
    expect(firedBefore, 'the baseline read is the other half of this count').toBeGreaterThanOrEqual(0);
    expect(fired.length - firedBefore, 'the notification — the real effect — did not fire exactly once').toBe(1);
  });

  it('ignores a requested workflowId (2.31.1 sends conformance-noop, which records no effects) and SAYS what it used', async () => {
    markOwnProcess();
    const r = await call('POST', KILL, { mode: 'duplicate-delivery', workflowId: 'conformance-noop' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json['workflowId']).toBe(DUPLICATE_DELIVERY_WORKFLOW_ID);
  });
});

describe('RFC 0158 durability seam — duplicate-delivery, the effectUrl contract (suite >= 2.32.0, ADR 0739 P2b)', () => {
  /** The suite's receiver, in miniature: every request that arrives is one invocation. */
  async function receiver(): Promise<{ url: string; arrivals: string[]; close: () => Promise<void> }> {
    const arrivals: string[] = [];
    const rx = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      // Answer SLOWLY on purpose: the first request is still in flight when the
      // second delivery reaches the effect node — the window a fence must cover.
      req.on('end', () => { arrivals.push(body); setTimeout(() => { res.statusCode = 204; res.end(); }, 150); });
    });
    await new Promise<void>((r) => rx.listen(0, '127.0.0.1', () => r()));
    return {
      url: `http://127.0.0.1:${(rx.address() as AddressInfo).port}/effect`,
      arrivals,
      close: () => new Promise<void>((r) => rx.close(() => r())),
    };
  }

  it('stages ONE outbound request to effectUrl through the real egress, and both deliveries really run', async () => {
    markOwnProcess();
    const rx = await receiver();
    try {
      const r = await call('POST', KILL, { mode: 'duplicate-delivery', effectUrl: rx.url });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      expect(r.json['workflowId']).toBe(HTTP_EFFECT_WORKFLOW_ID);
      const runId = bareRunId(r.json['runId']);
      expect([...(r.json['deliveries'] as string[])].sort(), 'two deliveries must be ATTEMPTED or the row witnesses nothing').toEqual(['duplicate-refused', 'executed']);
      await new Promise((res) => setTimeout(res, 600));
      // The suite records `blocked` on zero arrivals — the seam MUST land the effect.
      expect(rx.arrivals.length, 'the staged effect never reached effectUrl').toBeGreaterThanOrEqual(1);
      expect(JSON.parse(rx.arrivals[0] as string)).toMatchObject({ runId, nodeId: 'effect' });
    } finally { await rx.close(); }
  });

  it('WHD-12 CLOSED (ADR 0740): an HTTP effect delivered twice ARRIVES ONCE, and the run has ONE terminal event', async () => {
    // RFC 0158 §C. Until ADR 0740 this test pinned the DEFECT as residue —
    // `toBe(2)` arrivals, `toBe(2)` `run.completed` — with the instruction "when
    // the fence lands this goes RED: flip both literals to 1". It went red on the
    // commit that added `Storage.claimRunExecution`, which is the only reason
    // these are 1s and not an optimistic guess. MEASURED before: 2 arrivals, 2×
    // `node.completed@effect`, 2× `run.completed` on one run, deterministic 3/3.
    //
    // The receiver answers after 150 ms, so delivery 1's request is IN FLIGHT when
    // delivery 2 is attempted — the window the fence has to cover. There is no
    // delay node in front of the effect and the seam does not serialise anything.
    markOwnProcess();
    const rx = await receiver();
    try {
      const r = await call('POST', KILL, { mode: 'duplicate-delivery', effectUrl: rx.url });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      // A LONGER wait is a STRONGER claim: this waits for a second arrival that
      // must not happen.
      await new Promise((res) => setTimeout(res, 1_200));
      expect(rx.arrivals.length, 'the one staged effect did not arrive exactly once').toBe(1);
      const events = await storage.listEvents(bareRunId(r.json['runId']));
      expect(events.filter((e) => e.type === 'run.completed').length, 'one run, one terminal event').toBe(1);
      // …and nothing lands on the log after it (the old second delivery appended
      // `node.failed` at seq 9 behind `run.completed` at seq 8).
      expect(events[events.length - 1]?.type, 'an event was appended after the terminal event').toBe('run.completed');
    } finally { await rx.close(); }
  });

  it('refuses a non-http(s) effectUrl without staging anything', async () => {
    markOwnProcess();
    expect((await call('POST', KILL, { mode: 'duplicate-delivery', effectUrl: 'file:///etc/passwd' })).status).toBe(400);
    expect((await call('POST', KILL, { mode: 'duplicate-delivery', effectUrl: 'not a url' })).status).toBe(400);
    expect((await call('POST', KILL, { mode: 'duplicate-delivery', effectUrl: 42 })).status).toBe(400);
  });
});
