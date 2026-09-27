/**
 * TOCWF-1 / TOCWF-2 (ADR 0604) — the `:fork` compaction invariant, executed on
 * the REAL path: a real HTTP `POST /v1/runs/{id}:fork` against a real app, a
 * real run row, the real `insertRunWithStartContext` → `stampRunStartContext`
 * chain, and the real toggle store.
 *
 * WHY THIS FILE EXISTS. `test/tool-output-compaction-seam.test.ts` used to
 * assert the same invariant against a MODEL of the fork — a local helper
 *
 *     const fork = (m) => ({ ...m });
 *
 * — with a comment stating, as fact, that the route "copies sourceRun.metadata
 * VERBATIM and never re-stamps". The route does copy the metadata verbatim, and
 * then hands it to `insertRunWithStartContext`, which RE-RUNS every run-start
 * contributor. A shallow spread cannot re-run a contributor, so the model was
 * green on a path that was red: a born-OFF run forked after the toggle flipped
 * ON acquired `{mode:'lossless'}` it was never created under. All 61 shipped
 * compaction tests were green through that defect.
 *
 * The lesson is the test-design one, not the feature one: an instrument that
 * SUBSTITUTES a hand-written stand-in for the mechanism under test can only
 * ever measure the stand-in. Every assertion below therefore reads the row back
 * out of `storage` after a real request.
 *
 * BORN-RED: reverting either half of the ADR 0604 cure (`derivedFromRun` on the
 * fork call site in `routes/runs.ts`, or the guard at the top of
 * `resolveCompactionDecision`) turns the born-OFF case below red with
 * `{mode:'lossless'}` where `undefined` is required.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { readCompactionDecision } from '../src/executor/compaction.js';
import { toolOutputCompactionFeature } from '../src/features/tool-output-compaction/feature.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';

describe('TOCWF-1 — `:fork` never re-resolves the compaction decision (real route)', () => {
  let server: http.Server;
  let storage: Storage;
  let BASE = '';
  let workflowId = '';
  const TOKEN = 'dev-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    storage = app.locals.storage;
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => {
        BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        res();
      });
    });
    const disco = await api<{ fixtures?: string[] }>('/.well-known/openwop');
    workflowId = disco.body.fixtures?.[0] ?? 'openwop-app.uppercase';
  });
  afterAll(async () => {
    await __clearToggleStore();
    await new Promise<void>((res) => server.close(() => res()));
  });

  beforeEach(async () => {
    await __clearToggleStore();
    registerToggleDefault(toolOutputCompactionFeature.toggleDefault!);
  });

  async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  const setToggle = (status: 'on' | 'off'): Promise<unknown> =>
    saveConfig({ ...toolOutputCompactionFeature.toggleDefault!, status }, 'test');

  /** Create a run over the real route and return its id. */
  async function createRun(): Promise<string> {
    const r = await api<{ runId: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId, inputs: {} }),
    });
    expect(r.status).toBe(201);
    return r.body.runId;
  }

  /** Fork over the real route and return the fork's id. */
  async function forkRun(sourceRunId: string): Promise<string> {
    const f = await api<{ runId: string }>(`/v1/runs/${sourceRunId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ fromSeq: 0, mode: 'replay' }),
    });
    expect(f.status).toBe(201);
    return f.body.runId;
  }

  const decisionOf = async (runId: string): Promise<unknown> =>
    readCompactionDecision((await storage.getRun(runId))?.metadata);

  it('a run born OFF stays uncompacted when forked after the toggle flips ON', async () => {
    await setToggle('off');
    const src = await createRun();
    // NON-VACUITY FLOOR — the premise of the whole test. If this run were born
    // WITH a decision, the copied key would block the re-stamp and the
    // assertion below would pass for the wrong reason (that is precisely how
    // the modelled test stayed green). Assert the born state explicitly.
    expect(await decisionOf(src)).toBeUndefined();

    await setToggle('on'); // the operator flips it on AFTER the run was created

    // ...and the toggle really is on now: a run created at this instant IS
    // stamped. Without this arm, a broken toggle store would make the fork
    // assertion below trivially true.
    const bornOn = await createRun();
    expect(await decisionOf(bornOn)).toEqual({ mode: 'lossless' });

    const fork = await forkRun(src);
    expect(fork).not.toBe(src);
    expect(await decisionOf(fork)).toBeUndefined();
  });

  it('a fork of a fork of a born-OFF run is still uncompacted (the copy is transitive)', async () => {
    await setToggle('off');
    const src = await createRun();
    expect(await decisionOf(src)).toBeUndefined();
    await setToggle('on');
    const f1 = await forkRun(src);
    const f2 = await forkRun(f1);
    expect(await decisionOf(f1)).toBeUndefined();
    expect(await decisionOf(f2)).toBeUndefined();
  });

  it('a run born ON keeps its frozen decision when forked after the toggle flips OFF', async () => {
    await setToggle('on');
    const src = await createRun();
    expect(await decisionOf(src)).toEqual({ mode: 'lossless' });

    await setToggle('off');
    // Floor for the other direction: the toggle really is off now.
    const bornOff = await createRun();
    expect(await decisionOf(bornOff)).toBeUndefined();

    const fork = await forkRun(src);
    expect(await decisionOf(fork)).toEqual({ mode: 'lossless' });
  });

  /**
   * ADR 0604 review H1 — THE SECOND METADATA-COPYING RUN CREATOR.
   *
   * `POST /v1/host/openwop-app/runs/redrive` copies `source.metadata` verbatim
   * (minus caller provenance) and, until this fix, inserted it WITHOUT
   * `derivedFromRun`. Because `compaction` is not a reserved key, that produced
   * the exact asymmetry §D1 names as the defect: a PRESENT decision survived
   * the copy, an ABSENT one was re-resolved against the live toggle.
   *
   * The diagnosis is the transferable part: §D1's enumeration was done over the
   * READERS of the decision. The property that needed enumerating is WRITERS OF
   * A COPIED METADATA BLOB, and `derivedFromRun` had exactly ONE call site
   * repo-wide. `test/run-metadata-copy-sites.test.ts` is the ratchet over that
   * population.
   */
  async function redrive(sourceRunId: string): Promise<string> {
    // The route only redrives a terminal-failed run.
    await storage.updateRun(sourceRunId, { status: 'failed' });
    const r = await api<{ results?: Array<{ redriveRunId?: string; error?: string }> }>(
      '/v1/host/openwop-app/runs/redrive',
      { method: 'POST', body: JSON.stringify({ runIds: [sourceRunId] }) },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = r.body.results?.[0];
    expect(row?.error, `redrive refused: ${row?.error}`).toBeUndefined();
    expect(row?.redriveRunId).toBeTruthy();
    return row!.redriveRunId!;
  }

  it('a run born OFF stays uncompacted when REDRIVEN after the toggle flips ON', async () => {
    await setToggle('off');
    const src = await createRun();
    expect(await decisionOf(src)).toBeUndefined(); // non-vacuity: born without one

    await setToggle('on');
    const bornOn = await createRun(); // the toggle really is on now
    expect(await decisionOf(bornOn)).toEqual({ mode: 'lossless' });

    const rd = await redrive(src);
    expect(rd).not.toBe(src);
    expect(await decisionOf(rd)).toBeUndefined();
  });

  it('a run born ON keeps its frozen decision when REDRIVEN after the toggle flips OFF', async () => {
    // The half that already worked, pinned so the cure cannot be "fixed" by
    // stripping `compaction` instead — that would redden THIS arm.
    await setToggle('on');
    const src = await createRun();
    expect(await decisionOf(src)).toEqual({ mode: 'lossless' });

    await setToggle('off');
    const bornOff = await createRun();
    expect(await decisionOf(bornOff)).toBeUndefined();

    const rd = await redrive(src);
    expect(await decisionOf(rd)).toEqual({ mode: 'lossless' });
  });

  it('the redrive is otherwise a normal run — inheriting the decision strips nothing else', async () => {
    await setToggle('off');
    const src = await createRun();
    const rd = await redrive(src);
    const meta = (await storage.getRun(rd))?.metadata as Record<string, unknown> | undefined;
    expect(meta?.redriveOf).toBe(src); // the host-side provenance stamp survives
    expect(meta?.definitionRevision).toBeTruthy();
    expect(meta?.actingUserId).toBeTruthy(); // RE-stamped to the redriving caller
  });

  /**
   * ADR 0604 review M6 — `run.metadata.compaction` was CLIENT-FORGEABLE.
   *
   * Traced three hops (`routes/runs.ts` → `runDispatch.ts` → `runStartContext`)
   * and then executed: a `POST /v1/runs` body carrying
   * `{"metadata":{"compaction":{"mode":"lossy","head":0,"tail":0}}}` froze a
   * LOSSY decision with the tenant toggle OFF. Pre-existing, but this batch
   * doubles its weight — `lossy` is now the only mode with any effect, and the
   * ADR presented "no SPA editor" as meaning lossy is unreachable. It was
   * reachable by any run creator, and ONLY by bypassing the operator.
   */
  it('a client cannot pin its own compaction decision through POST /v1/runs', async () => {
    await setToggle('off');
    const forged = await api<{ runId: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({
        workflowId,
        inputs: {},
        metadata: { compaction: { mode: 'lossy', head: 0, tail: 0 }, note: 'kept' },
      }),
    });
    expect(forged.status).toBe(201);
    expect(await decisionOf(forged.body.runId)).toBeUndefined();
    // …and the strip is SURGICAL: unreserved client metadata still lands, so
    // this is not passing because metadata was dropped wholesale.
    const meta = (await storage.getRun(forged.body.runId))?.metadata as Record<string, unknown> | undefined;
    expect(meta?.note).toBe('kept');
  });

  it('a forged decision cannot survive even when the toggle is ON (the host value wins)', async () => {
    await setToggle('on');
    const forged = await api<{ runId: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId, inputs: {}, metadata: { compaction: { mode: 'lossy', head: 0, tail: 0 } } }),
    });
    expect(forged.status).toBe(201);
    // The host contributor resolves `lossless`; the client asked for `lossy`.
    expect(await decisionOf(forged.body.runId)).toEqual({ mode: 'lossless' });
  });

  it('the fork is otherwise a normal run — the contributor guard does not strip inherited metadata', async () => {
    // A guard that returned `{}` for the WHOLE stamp (rather than just this
    // contributor's patch) would also silently drop `definitionRevision` and
    // the acting-user re-stamp. Prove the fork still carries both.
    await setToggle('off');
    const src = await createRun();
    const fork = await forkRun(src);
    const meta = (await storage.getRun(fork))?.metadata as Record<string, unknown> | undefined;
    expect(meta?.definitionRevision).toEqual(
      ((await storage.getRun(src))?.metadata as Record<string, unknown> | undefined)?.definitionRevision,
    );
    expect(meta?.actingUserId).toBeTruthy();
  });
});
