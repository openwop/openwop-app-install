/**
 * Born-red witnesses for three Assistant / Chief-of-Staff Blockers
 * (docs/steward/CODEBASE-ASSESSMENT.md):
 *
 *   COS-5  — `enableLoop` validates a caller-supplied cron at the ONE
 *            composition owner. An unparseable expression is a typed 400 that
 *            persists NO job (today the route 200s with `{enabled:true}` over a
 *            job that can never fire); a valid-but-rare expression still enables
 *            (it is NOT rejected by a `computeNextFire`-style guard).
 *   COS-7  — the five remaining cross-tenant `.list()` scans read through the
 *            bounded per-tenant index (`listForTenantIndexed`) instead.
 *   COS-13 — `loops.ts` + `capability.ts` emit named observability events for
 *            loop enable/disable and a capability bootstrap failure.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { getJob, resetScheduling } from '../src/host/schedulingService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import {
  __resetAssistantStore,
  listProjects,
  createProject,
  listPendingActions,
  enqueuePendingAction,
} from '../src/features/assistant/assistantService.js';
import { enableLoop, disableLoop } from '../src/features/assistant/loops.js';

let BASE: string;
let server: http.Server;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
  await resetScheduling();
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
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

/** Capture stdout across an async call (the logger writes JSON lines there). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('');
}

describe('COS-5 — enableLoop validates the cron at the composition owner', () => {
  it('rejects an unparseable cron with a 400 and persists NO job', async () => {
    const enable = await jf<{ error?: string }>('/v1/host/openwop-app/assistant/loops/drive-ingest/enable', {
      method: 'POST',
      body: JSON.stringify({ cronExpr: 'not a cron' }),
    });
    expect(enable.status).toBe(400);

    // No inert `enabled:true` job may have been written.
    const after = await jf<{ loops: Array<{ loopId: string; enabled: boolean }> }>('/v1/host/openwop-app/assistant/loops');
    expect(after.body.loops.find((l) => l.loopId === 'drive-ingest')?.enabled).toBe(false);
    // The job row itself does not exist (id shape: assistant:<loopId>:<tenant>).
    expect(await getJob('assistant:drive-ingest:default')).toBeNull();
  });

  it('accepts a valid cron and enables the job', async () => {
    const enable = await jf<{ enabled: boolean; jobId: string }>('/v1/host/openwop-app/assistant/loops/drive-ingest/enable', {
      method: 'POST',
      body: JSON.stringify({ cronExpr: '0 * * * *' }),
    });
    expect(enable.status).toBe(200);
    expect(enable.body.enabled).toBe(true);
    expect((await getJob(enable.body.jobId))?.cronExpr).toBe('0 * * * *');
  });

  it('accepts a valid-but-rare cron (0 0 30 2 *) — proves it is not over-rejected via computeNextFire', async () => {
    // 30 February never fires, so `computeNextFire` returns null — but the
    // expression is syntactically valid and MUST enable. This is the exact case
    // a computeNextFire-based guard would wrongly 400.
    const enable = await jf<{ enabled: boolean }>('/v1/host/openwop-app/assistant/loops/morning-briefing/enable', {
      method: 'POST',
      body: JSON.stringify({ cronExpr: '0 0 30 2 *' }),
    });
    expect(enable.status).toBe(200);
    expect(enable.body.enabled).toBe(true);
  });
});

describe('COS-7 — the entity listers read through the bounded per-tenant index', () => {
  it('listProjects returns only the caller tenant AND does not fall back to a cross-tenant .list()', async () => {
    await createProject('cos7-A', { name: 'A-project' });
    await createProject('cos7-B', { name: 'B-project' });

    // Warm the per-tenant index backfill once (the FIRST listForTenantIndexed
    // arms the durable sentinel via a single ensureTenantIndex → list()).
    await listProjects('cos7-A');

    const listSpy = vi.spyOn(DurableCollection.prototype, 'list');
    const indexedSpy = vi.spyOn(DurableCollection.prototype, 'listForTenantIndexed');
    try {
      const rows = await listProjects('cos7-A');
      expect(rows.map((p) => p.name)).toEqual(['A-project']); // tenant isolation preserved
      expect(indexedSpy).toHaveBeenCalled();                  // bounded path taken
      expect(listSpy).not.toHaveBeenCalled();                 // NOT the cross-tenant scan
    } finally {
      listSpy.mockRestore();
      indexedSpy.mockRestore();
    }
  });

  it('listPendingActions is the same transform (bounded, tenant-isolated)', async () => {
    await enqueuePendingAction('cos7-A', { kind: 'email.send', draft: 'hi A', payload: { to: ['a@x.test'] } });
    await enqueuePendingAction('cos7-B', { kind: 'email.send', draft: 'hi B', payload: { to: ['b@x.test'] } });

    await listPendingActions('cos7-A'); // warm

    const listSpy = vi.spyOn(DurableCollection.prototype, 'list');
    const indexedSpy = vi.spyOn(DurableCollection.prototype, 'listForTenantIndexed');
    try {
      const rows = await listPendingActions('cos7-A');
      expect(rows.map((a) => a.draft)).toEqual(['hi A']);
      expect(indexedSpy).toHaveBeenCalled();
      expect(listSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      indexedSpy.mockRestore();
    }
  });
});

describe('COS-13 — named observability on loop enable/disable', () => {
  it('enableLoop emits a named event (today loops.ts emits nothing)', async () => {
    const out = await captureStdout(async () => {
      await enableLoop('default', 'calendar-ingest', { actingUserId: 'user:cos13', cronExpr: '0 7 * * *' });
    });
    expect(out).toContain('assistant_loop_enabled');
    expect(out).toContain('features.assistant.loops');
  });

  it('disableLoop emits a named event', async () => {
    const out = await captureStdout(async () => {
      await disableLoop('default', 'calendar-ingest');
    });
    expect(out).toContain('assistant_loop_disabled');
  });
});
