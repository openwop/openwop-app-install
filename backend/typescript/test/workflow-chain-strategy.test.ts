/**
 * Strategy workflow-chain pack (ADR 0231 §C2/§C3, ADR 0233 board-pack) + the
 * cadence reconcile route.
 *
 * Asserts the THREE chains load from this pack, that each EXPANDED definition
 * binds the digest body into `deliver.message` with exactly one primary output
 * (SPWF-1 / SPWF-7, ADR 0597 §1), that expansion is deterministic and param-keyed
 * (replay), and that PUT /strategy/cadence registers / removes the deterministic
 * scheduler job and refuses a bad cron (the insights-suite reconcile pattern).
 *
 * Sabotage (grade-tests w19, each witnessed red): a portless `digest → deliver`
 * edge, marking every node primary, a random or param-blind `expansionId`, a
 * disable that keeps the job, an unvalidated cron, a job registered under the
 * wrong tenant or workflow id.
 *
 * Cut in w19 as covered by `strategy-chain-execution.test.ts` (both confirmed red
 * under the same sabotage): the hand-kept KNOWN_TYPEIDS membership case (every
 * node is resolved and RUN there), and "board-pack REPORTS its unfilled required
 * param" (its consumer is witnessed by "refuses to schedule board-pack with no
 * orgId…", red under the same sabotage).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { getJob } from '../src/host/schedulingService.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PACK = 'vendor.openwop-app.workflows.strategy';
const CHAINS = ['strategy.weekly-checkin', 'strategy.metric-sync', 'strategy.board-pack'];

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('strategy');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  // The app boot loads the packs; reload explicitly so the registry is fresh
  // even if another test file reset it in this worker.
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  // Scoped to THIS pack (dir name or manifest name): pack-wide load health is
  // chain-pack-export-loads.test.ts's claim, not this file's.
  expect(errors.filter((e) => e.pack === 'strategy' || e.pack === PACK)).toEqual([]);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('strategy chain pack — discovery + expansion', () => {
  it('loads all three chains from the strategy pack', () => {
    for (const id of CHAINS) {
      const e = getChain(id);
      expect(e, id).not.toBeNull();
      expect(e!.packName).toBe(PACK);
    }
  });

  /**
   * SPWF-7 / ADR 0597 §1 — this suite asserted node COUNT and `chainId` and
   * nothing else: not edges, not port bindings, not `outputRole`, not
   * `metadata.unresolvedParams`. It literally called `expandChain(chain, {})`
   * on `strategy.board-pack` — reproducing SPWF-2 in-test — and never looked at
   * the result. These three assertions look.
   */
  it('the EXPANDED shape carries the declared port bindings (SPWF-1 cannot come back silently)', () => {
    for (const id of CHAINS) {
      const def = expandChain(getChain(id)!.chain, { params: { orgId: 'org-probe' } });
      const deliver = def.nodes.find((nd) => nd.typeId === 'feature.notifications.nodes.notify');
      expect(deliver, `${id} has no notify node`).toBeTruthy();
      const intoBody = (def.edges ?? []).filter((e) => e.targetNodeId === deliver!.nodeId && e.targetInput === 'message');
      expect(intoBody.length, `${id}: nothing binds deliver.message — the notification ships title-only`).toBe(1);
      expect(intoBody[0]!.sourceOutput, `${id}: the body edge must name its SOURCE port too`).toBe('content');
      // Exactly one primary, and it is the terminal node.
      expect(def.nodes.filter((nd) => nd.outputRole === 'primary').map((nd) => nd.nodeId)).toEqual([deliver!.nodeId]);
    }
  });

  it('expansion is deterministic — same (chain, params) expands byte-identically', () => {
    for (const id of CHAINS) {
      const chain = getChain(id)!.chain;
      const a = expandChain(chain, { params: { orgId: 'org-probe' } });
      const b = expandChain(chain, { params: { orgId: 'org-probe' } });
      expect(JSON.stringify(b), id).toBe(JSON.stringify(a));
      // …and a DIFFERENT param set must not collide on the same expansion id.
      if (id === 'strategy.board-pack') {
        const other = expandChain(chain, { params: { orgId: 'org-other' } });
        expect(other.metadata?.expansionId).not.toBe(a.metadata?.expansionId);
      }
    }
  });

});

describe('strategy cadence reconcile (ADR 0231)', () => {
  interface CadenceEntry { enabled: boolean; cron: string }
  interface CadenceBody { config: { weeklyCheckin: CadenceEntry }; error?: string; details?: { field?: string } }
  interface Res { status: number; body: CadenceBody }
  function client() {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as CadenceBody };
    };
    return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
  }

  it('PUT registers deterministic jobs; disabling removes them; bad cron 400s', async () => {
    const tenantId = `org:cad-${Date.now()}-${n++}`;
    const c = client();
    const login = await c.post('/host/openwop-app/test/login', { email: `cad-${Date.now()}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    await c.post('/host/openwop-app/orgs', { name: 'Acme' });

    // Enable the weekly check-in cadence.
    const put = await c.put('/host/openwop-app/strategy/cadence', {
      weeklyCheckin: { enabled: true, cron: '0 9 * * 1' },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.config.weeklyCheckin.enabled).toBe(true);

    const readBack = await c.get('/host/openwop-app/strategy/cadence');
    expect(readBack.body.config.weeklyCheckin.cron).toBe('0 9 * * 1');

    // The deterministic job exists and points at the chain-expanded workflow.
    const slugged = (await import('node:crypto')).createHash('sha256').update(tenantId).digest('hex').slice(0, 10);
    const job = await getJob(`strategy-cadence:weeklyCheckin:${slugged}`);
    expect(job).toBeTruthy();
    expect(job!.tenantId).toBe(tenantId);
    expect(job!.workflowId).toBe(`wf.cadence.strategy-weekly-checkin.${slugged}`);
    expect(job!.cronExpr).toBe('0 9 * * 1');

    // Disable ⇒ the job is removed.
    const off = await c.put('/host/openwop-app/strategy/cadence', { weeklyCheckin: { enabled: false, cron: '0 9 * * 1' } });
    expect(off.status).toBe(200);
    expect(await getJob(`strategy-cadence:weeklyCheckin:${slugged}`)).toBeFalsy();

    // Invalid cron fails closed.
    const bad = await c.put('/host/openwop-app/strategy/cadence', { metricSync: { enabled: true, cron: 'not a cron' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('validation_error');
    expect(bad.body.details?.field).toBe('metricSync');
  });
});
