/**
 * CC-CHAIN-4 — the retired Campaign Studio tour alias stays out of the template
 * gallery and cannot be minted as a new workflow, while replay keeps resolving it.
 *
 * MEASURED on app.openwop.dev (373d4863a, 2026-11-12): `GET /workflow-chains`
 * listed `tour.campaign-studio.first-brief` and `POST /workflows/from-chain`
 * instantiated it (201), although walkthroughIds.ts documents it as "Excluded
 * from every user-facing listing so it never double-shows next to the seeded
 * walkthrough". Its run page then could not render the walkthrough step.
 *
 * Pins: the alias is absent from the chain listing; from-chain refuses it with a
 * typed 410 (`reason: retired_alias`) whose message points to Guided
 * walkthroughs (the replacement id also rides `details.replacedBy`, but the wire
 * error redactor masks dotted ids, so clients cannot rely on reading it); the
 * zero-config seeder never seeds the alias into a tenant's ownership index
 * (which /builder and the `/` picker list), while it still seeds a current
 * walkthrough chain (control); a current walkthrough chain is still listed
 * (control). The alias stays registered so old runs replay/fork.
 *
 * Red when: the listing filter, the from-chain refusal or the seeder skip is removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { getChain } from '../src/host/workflowChainPackLoader.js';
import { LEGACY_CAMPAIGN_STUDIO_ID } from '../src/features/walkthroughs/walkthroughIds.js';
import { seedZeroConfigWorkflows } from '../src/host/seedWorkflows.js';
import { listOwned } from '../src/host/workflowOwnership.js';
import { seedWorkflowId } from '../src/host/workflowId.js';

let server: http.Server;
let PORT: number;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = '';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const url = (p: string) => `http://127.0.0.1:${PORT}/host/openwop-app${p}`;
async function cookie(): Promise<string> {
  const r = await fetch(url('/workflows'));
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

describe('CC-CHAIN-4 — retired tour alias', () => {
  it('the alias chain is installed (so this test is not vacuous)', () => {
    expect(getChain(LEGACY_CAMPAIGN_STUDIO_ID), 'walkthroughs chain pack must be mounted in tests').toBeTruthy();
  });

  it('is absent from the template listing; other walkthrough chains are still listed', async () => {
    const r = await fetch(url('/workflow-chains'), { headers: { cookie: await cookie() } });
    expect(r.status).toBe(200);
    const ids = ((await r.json()) as { chains: { chainId: string }[] }).chains.map((c) => c.chainId);
    expect(ids).not.toContain(LEGACY_CAMPAIGN_STUDIO_ID);
    expect(ids.some((id) => id.startsWith('walkthrough.'))).toBe(true);
  });

  it('from-chain refuses it with a typed 410 that points to Guided walkthroughs', async () => {
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie() },
      body: JSON.stringify({ chainId: LEGACY_CAMPAIGN_STUDIO_ID }),
    });
    expect(r.status).toBe(410);
    const body = (await r.json()) as { error: string; message: string; details?: { reason?: string } };
    expect(body.error).toBe('not_found');
    expect(body.details).toMatchObject({ reason: 'retired_alias' });
    // The human-readable pointer survives the wire (no dotted id for the redactor to mask).
    expect(body.message).toMatch(/Guided walkthroughs/);
  });

  it('the zero-config seeder never seeds the alias into a tenant; it still seeds a current walkthrough', async () => {
    const TENANT = 'user:cc-chain-4-seed';
    await seedZeroConfigWorkflows(TENANT);
    const owned = (await listOwned(TENANT)).map((r) => r.workflowId);
    expect(owned).not.toContain(seedWorkflowId(LEGACY_CAMPAIGN_STUDIO_ID));
    expect(owned.some((id) => id.startsWith('wf.seed.walkthrough'))).toBe(true);
  });
});
