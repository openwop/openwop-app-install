/**
 * ADR 0412 P5 — goals advertisement ↔ behavior parity.
 *
 * History: the P0 revision of this file also scanned shipped deploy artifacts
 * for a truthy `OPENWOP_GOALS_ENABLED`, because the advertisement was AHEAD of
 * behavior (no verifier, no-op continuation). P5 wired the behavior and
 * reconciled the advertised set, so that scan leg is deleted per its own
 * instruction — the flag may now ship enabled.
 *
 * What must stay true forever:
 *  - flag unset → no `agents.goals` capability is advertised;
 *  - flag on → the advertised set is EXACTLY the honored one:
 *    `judge: verifier` (a registered verifier judges an immutable snapshot) and
 *    `continuation: ['schedule','manual']` — `commitment` stays OUT until a
 *    commitment seam actually arms it; `heartbeat` stays honest-omitted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { registerGoalVerifier, __clearGoalVerifiers } from '../src/features/goals/goalVerifiers.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const prior = process.env.OPENWOP_GOALS_ENABLED;

beforeAll(async () => {
  delete process.env.OPENWOP_GOALS_ENABLED;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});

afterAll(async () => {
  if (prior === undefined) delete process.env.OPENWOP_GOALS_ENABLED;
  else process.env.OPENWOP_GOALS_ENABLED = prior;
  __clearGoalVerifiers();
  await new Promise<void>((res) => server.close(() => res()));
});

async function advertisement(): Promise<{ agents?: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/.well-known/openwop`);
  expect(res.status).toBe(200);
  return (await res.json()) as { agents?: Record<string, unknown> };
}

describe('ADR 0412 P5 — advertisement ↔ behavior parity', () => {
  it('flag unset → no agents.goals capability is advertised', async () => {
    delete process.env.OPENWOP_GOALS_ENABLED;
    const doc = await advertisement();
    expect(doc.agents?.goals).toBeUndefined();
  });

  it('flag on → EXACTLY the honored set: judge verifier + schedule/manual (commitment stays out)', async () => {
    process.env.OPENWOP_GOALS_ENABLED = 'true';
    const doc = await advertisement();
    const goals = doc.agents?.goals as { judge?: string; continuation?: string[] } | undefined;
    expect(goals?.judge).toBe('verifier');
    expect(goals?.continuation).toEqual(['schedule', 'manual']);
    delete process.env.OPENWOP_GOALS_ENABLED;
  });

  it('the judge claim is non-vacuous: an advertised evaluation round-trips through a registered verifier', async () => {
    process.env.OPENWOP_GOALS_ENABLED = 'true';
    registerGoalVerifier('guard:judge', async () => ({ satisfied: true, confidence: 1, runId: 'run-guard' }));
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
    const created = await fetch(`${BASE}/v1/host/openwop-app/goals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        objective: 'Advertisement honesty probe',
        completion: { check: 'verifier', verifierRef: 'guard:judge' },
        continuation: { mode: 'manual' },
        bounds: { maxLoopIterations: 3 },
      }),
    });
    expect(created.status).toBe(200);
    const goal = (await created.json()) as { id: string };
    const evaluated = await fetch(`${BASE}/v1/host/openwop-app/goals/${goal.id}/evaluate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ snapshotRef: 'guard:ref', snapshotHash: 'guard-hash' }),
    });
    expect(evaluated.status).toBe(200);
    const result = (await evaluated.json()) as { goal: { state: string } };
    expect(result.goal.state).toBe('satisfied');
    delete process.env.OPENWOP_GOALS_ENABLED;
  });
});
