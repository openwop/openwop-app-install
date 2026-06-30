/**
 * ADR 0023 §12 T2 — perception-loop activation:
 *   - the commitments secondary indexes (ADR 0029 pull-forward): indexed
 *     listCommitments stays correct across create / status transition /
 *     delete, tenant-isolated, with backfill idempotent;
 *   - the pack's `ingest-commitments` node: idempotent re-ingest (re-run
 *     updates in place, never duplicates), per-tick cap, and `contentTrust:
 *     'untrusted'` stamped on every provider-derived SourceRef (ADR 0027);
 *   - the loop routes: workflow definitions registered at boot carrying the
 *     ADR 0024 Phase D `config.connection` annotation; enable/disable
 *     registers/disables the RFC 0052 job with the enabling principal's
 *     `actingUserId` in job metadata (D2 actor discipline).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  __resetAssistantStore,
  backfillCommitmentIndexes,
  listCommitments,
  updateCommitment,
  deleteCommitment,
  upsertCommitmentBySource,
  type SourceRef,
} from '../src/features/assistant/assistantService.js';
import { buildAssistantSurface } from '../src/features/assistant/surface.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { getJob, resetScheduling } from '../src/host/schedulingService.js';
import { getRosterEntry } from '../src/host/rosterService.js';
import { findChiefOfStaff } from '../src/features/assistant/chiefOfStaff.js';

let BASE: string;
const TOKEN = 'dev-token';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
  await resetScheduling();
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) },
  });
  const raw = res.status === 204 ? undefined : await res.json();
  return { status: res.status, body: raw as T };
}

function srcRef(externalId: string): SourceRef {
  return { kind: 'manual', externalId, contentHash: `hash-${externalId}`, capturedAt: new Date().toISOString() };
}

describe('commitment secondary indexes (ADR 0029)', () => {
  it('indexed list stays correct across create / status transition / delete, tenant-isolated', async () => {
    await __resetAssistantStore();
    const a = await upsertCommitmentBySource('t-ix-1', { owner: { kind: 'self' }, description: 'alpha', source: srcRef('a') });
    await upsertCommitmentBySource('t-ix-1', { owner: { kind: 'self' }, description: 'beta', source: srcRef('b') });
    await upsertCommitmentBySource('t-ix-2', { owner: { kind: 'self' }, description: 'other tenant', source: srcRef('c') });

    expect((await listCommitments('t-ix-1')).map((c) => c.description).sort()).toEqual(['alpha', 'beta']);
    expect((await listCommitments('t-ix-2')).map((c) => c.description)).toEqual(['other tenant']);
    expect(await listCommitments('t-ix-1', { status: 'open' })).toHaveLength(2);
    expect(await listCommitments('t-ix-1', { status: 'done' })).toHaveLength(0);

    // Status transition moves the row between status slices.
    await updateCommitment('t-ix-1', a.commitment.commitmentId, { status: 'done' });
    expect((await listCommitments('t-ix-1', { status: 'open' })).map((c) => c.description)).toEqual(['beta']);
    expect((await listCommitments('t-ix-1', { status: 'done' })).map((c) => c.description)).toEqual(['alpha']);

    // Delete removes from every slice.
    await deleteCommitment('t-ix-1', a.commitment.commitmentId);
    expect(await listCommitments('t-ix-1', { status: 'done' })).toHaveLength(0);
    expect(await listCommitments('t-ix-1')).toHaveLength(1);
  });

  it('backfill is idempotent — double-running changes no indexed read', async () => {
    const before = await listCommitments('t-ix-1');
    await backfillCommitmentIndexes();
    await backfillCommitmentIndexes();
    expect(await listCommitments('t-ix-1')).toEqual(before);
    expect(before.length).toBe(1);
  });
});

describe('ingest-commitments pack node (loops 1/6 perception leg)', () => {
  // Typed via the ambient pack declaration (test/feature-packs.d.ts).
  let nodes: (typeof import('../../../packs/feature.assistant.nodes/index.mjs'))['nodes'];
  const TENANT = 't-ingest';

  beforeAll(async () => {
    nodes = (await import('../../../packs/feature.assistant.nodes/index.mjs')).nodes;
  });

  function ctxFor(inputs: Record<string, unknown>, config: Record<string, unknown>): unknown {
    return {
      inputs,
      config,
      features: { assistant: buildAssistantSurface({ tenantId: TENANT }) },
    };
  }

  const calendarBody = {
    items: [
      { id: 'evt-1', summary: 'Quarterly review', htmlLink: 'https://calendar.google.com/evt-1', start: { dateTime: '2026-06-12T15:00:00Z' } },
      { id: 'evt-2', summary: 'Board sync', start: { date: '2026-06-13' } },
      { id: 'evt-3', summary: 'Overflow event', start: { date: '2026-06-14' } },
    ],
  };

  it('ingests a calendar listing idempotently, capped, with untrusted taint stamped', async () => {
    const run1 = await nodes['feature.assistant.nodes.ingest-commitments']!(
      ctxFor({ body: calendarBody }, { sourceKind: 'calendar', maxItemsPerTick: 2 }),
    );
    expect(run1.status).toBe('success');
    expect(run1.outputs).toMatchObject({ created: 2, updated: 0, capped: true, sourceKind: 'calendar' });

    // Re-run with the same listing: updates in place, never duplicates.
    const run2 = await nodes['feature.assistant.nodes.ingest-commitments']!(
      ctxFor({ body: calendarBody }, { sourceKind: 'calendar', maxItemsPerTick: 2 }),
    );
    expect(run2.outputs).toMatchObject({ created: 0, updated: 2 });

    const stored = await listCommitments(TENANT);
    expect(stored).toHaveLength(2);
    for (const c of stored) {
      expect(c.source.contentTrust).toBe('untrusted'); // ADR 0027
      expect(c.source.kind).toBe('calendar');
    }
    const prep = stored.find((c) => c.description.includes('Quarterly review'));
    expect(prep?.dueAt).toBe('2026-06-12T15:00:00Z');
  });

  it('ingests a drive listing as review commitments', async () => {
    const driveBody = { files: [{ id: 'f-1', name: 'Q3 plan', modifiedTime: '2026-06-10T00:00:00Z', webViewLink: 'https://drive.google.com/f-1' }] };
    const run = await nodes['feature.assistant.nodes.ingest-commitments']!(
      ctxFor({ body: driveBody }, { sourceKind: 'drive', maxItemsPerTick: 10 }),
    );
    expect(run.outputs).toMatchObject({ created: 1, sourceKind: 'drive' });
    const stored = await listCommitments(TENANT);
    const review = stored.find((c) => c.description.includes('Q3 plan'));
    expect(review?.source.kind).toBe('drive');
    expect(review?.source.url).toBe('https://drive.google.com/f-1');
    expect(review?.source.contentTrust).toBe('untrusted');
  });

  it('skips malformed items rather than failing the tick', async () => {
    const run = await nodes['feature.assistant.nodes.ingest-commitments']!(
      ctxFor({ body: { items: [{ id: '', summary: 'no id' }, { id: 'x' /* no summary */ }] } }, { sourceKind: 'calendar' }),
    );
    expect(run.outputs).toMatchObject({ created: 0, skipped: 2 });
  });
});

describe('briefing composer (ADR 0023 §12 T3 — loop 5)', () => {
  it('composes a source-grounded brief: citations, why-surfaced, at-risk window', async () => {
    const TENANT = 't-brief';
    await upsertCommitmentBySource(TENANT, {
      owner: { kind: 'self' },
      description: 'Ship the Q3 plan',
      source: { kind: 'drive', externalId: 'f-9', contentHash: 'h9', capturedAt: new Date().toISOString(), url: 'https://drive.google.com/f-9', contentTrust: 'untrusted' },
      // 28h: unambiguously inside the 48h at-risk window AND clear of the
      // 0.5-day rounding boundary in `whyOf` (so it reads "due in 1d", never
      // "due today" depending on the sub-second wall clock at run time).
      dueAt: new Date(Date.now() + 28 * 3600_000).toISOString(),
      confidence: 0.9,
    });
    await upsertCommitmentBySource(TENANT, {
      owner: { kind: 'self' },
      description: 'Long-range roadmap',
      source: srcRef('far'),
      dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    const { composeBriefing } = await import('../src/features/assistant/briefing.js');
    const brief = await composeBriefing(TENANT);
    expect(brief.topCommitments.length).toBe(2);
    expect(brief.atRisk.map((i) => i.description)).toEqual(['Ship the Q3 plan']);
    const top = brief.topCommitments[0]!;
    expect(top.description).toBe('Ship the Q3 plan'); // closer deadline + higher confidence outranks
    expect(top.source).toMatchObject({ kind: 'drive', url: 'https://drive.google.com/f-9', contentTrust: 'untrusted' });
    expect(top.why).toContain('due in');
    expect(top.why).toContain('from connected (untrusted) content');
    expect(brief.headline).toContain('2 open commitment(s)');
  });

});

describe('loop routes (RFC 0052 activation surface)', () => {
  it('registers the loop workflows at boot — schema-clean configs (the credential opt-in is run-level, Option C)', () => {
    for (const wfId of ['assistant.loop.calendar-ingest', 'assistant.loop.drive-ingest']) {
      const def = getRegisteredWorkflow(wfId);
      expect(def, `${wfId} must be in the catalog`).toBeDefined();
      const fetchNode = def!.nodes.find((n) => n.nodeId === 'fetch');
      expect(fetchNode?.typeId).toBe('core.openwop.http.fetch');
      // ADR 0024 §4 / Option C: NOTHING connection-shaped in node config — the
      // pack's published config schema stays authoritative; the opt-in lives
      // on the scheduler job (asserted below) as run.configurable.connections.
      expect(fetchNode?.config?.connection).toBeUndefined();
      expect(def!.nodes.find((n) => n.nodeId === 'ingest')?.typeId).toBe('feature.assistant.nodes.ingest-commitments');
    }
  });

  it('serves unconditionally (toggle graduated); enable/disable manage the scheduler job', async () => {
    // ADR 0023 § Correction — the assistant graduated off its toggle; the loop
    // surface serves always (no 404-while-off).
    const before = await jf<{ loops: Array<{ loopId: string; enabled: boolean }> }>('/v1/host/openwop-app/assistant/loops');
    expect(before.status).toBe(200);
    expect(before.body.loops.map((l) => l.loopId).sort()).toEqual(['calendar-ingest', 'drive-ingest', 'morning-briefing']);
    expect(before.body.loops.every((l) => !l.enabled)).toBe(true);

    const enabled = await jf<{ jobId: string; enabled: boolean }>('/v1/host/openwop-app/assistant/loops/calendar-ingest/enable', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);

    // The job row carries the loop's workflow + the enabling principal
    // (D2 actor discipline) — what the daemon carries onto run.metadata.
    const job = await getJob(enabled.body.jobId);
    expect(job?.workflowId).toBe('assistant.loop.calendar-ingest');
    expect(job?.metadata?.actingUserId).toBeTruthy();
    expect((job?.metadata?.assistantLoop as Record<string, unknown>)?.loopId).toBe('calendar-ingest');
    // ADR 0024 §4 / Option C — the run-level credential opt-in rides the job.
    expect(job?.configurable).toEqual({ connections: ['google'] });
    // ADR 0023 (corrected) — the loop is the Chief-of-Staff AGENT's recurring
    // task: the job carries its REAL rosterId/agentId and resolves to a roster
    // member, so it shows in that agent's Schedules tab (not tenant-only).
    const cos = await findChiefOfStaff('default');
    expect(cos).not.toBeNull();
    expect(job?.rosterId).toBe(cos!.rosterId);
    expect(job?.agentId).toBe(cos!.agentRef.agentId);
    expect(await getRosterEntry(job!.rosterId!)).not.toBeNull();

    const after = await jf<{ loops: Array<{ loopId: string; enabled: boolean; cronExpr?: string }> }>('/v1/host/openwop-app/assistant/loops');
    const cal = after.body.loops.find((l) => l.loopId === 'calendar-ingest');
    expect(cal?.enabled).toBe(true);
    expect(cal?.cronExpr).toBe('*/30 * * * *');

    const disabled = await jf<{ enabled: boolean }>('/v1/host/openwop-app/assistant/loops/calendar-ingest/disable', { method: 'POST', body: '{}' });
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);

    expect((await jf('/v1/host/openwop-app/assistant/loops/nope/enable', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('serves the brief on one batched route (T3)', async () => {
    const res = await jf<{ brief: { headline: string; topCommitments: unknown[]; awaitingApprovalCount: number } }>(
      '/v1/host/openwop-app/assistant/briefing',
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.brief.headline).toBe('string');
    expect(Array.isArray(res.body.brief.topCommitments)).toBe(true);
    expect(typeof res.body.brief.awaitingApprovalCount).toBe('number');
  });

  it('the morning-briefing loop workflow is registered notify-on', () => {
    const def = getRegisteredWorkflow('assistant.loop.morning-briefing');
    expect(def).toBeDefined();
    expect(def!.nodes[0]?.typeId).toBe('feature.assistant.nodes.compose-briefing');
    expect(def!.nodes[0]?.config?.notify).toBe(true);
  });
});
