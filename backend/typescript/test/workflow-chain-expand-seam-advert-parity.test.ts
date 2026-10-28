/**
 * ADR 0550 P2 — the advertise⟺serve parity of the RFC 0013 host-expansion seam.
 *
 * The container lane found this as a REAL dishonest advert: the seam resolves its
 * fixture pack from `@openwop/openwop-conformance` at REQUEST time, that is a
 * devDependency, and the runtime image runs `npm ci --omit=dev` — so the release
 * artifact advertised `workflowChainPacks.hostExpansionSeam` and then answered 404
 * `pack_not_found`.
 *
 * The fix routes the advertisement (`workflowChainPacksCapability`) and the route
 * registration (`registerWorkflowChainExpandSeamRoutes`) through ONE predicate,
 * `isChainExpansionSeamServable()`. That was a code comment and nothing else —
 * `hostExpansionSeam` appeared in no test in this repo. A comment does not fail.
 *
 * WHAT THIS FILE BOUNDS, AND WHAT IT DOES NOT.
 * The predicate has two arms: the env gate and pack resolvability. Only the env
 * arm is reachable here — in the source lane the conformance package is always
 * installed, which is precisely why the defect was structurally invisible to
 * vitest and had to be caught by the container lane
 * (`scripts/release-conformance.sh`). So this file proves the PAIRING: both call
 * sites consult one function, and a host that does not advertise does not serve.
 * It does not re-witness the pack-absent state; the container lane owns that.
 *
 * CORRECTION (ADR 0812 P3c-0, recorded in grade-tests wave 64). The served
 * document is now major 2, whose closed `workflowChainPacks` record has no
 * `hostExpansionSeam` seat (`routes/discovery.ts`, the `v2SubChainsFacet` pick), so
 * NO boot advertises the seam and the advertise half of the parity above can no
 * longer fail (probe `8fw5g4-esap-advert`, forcing the advert on, stayed green).
 * What this file asserts now: the v2 document claims nothing on either boot, the
 * enabled boot serves, and the disabled boot does not MOUNT the route at all — its
 * answer is byte-identical to a path nothing registers. The serve gate is the same
 * `isChainExpansionSeamServable()` the dead v1 advert read (grade-code row
 * WCES-DEAD-1). Two boots, shared by all three cases.
 *
 * Mocking is deliberately NOT used to fake the pack-absent state. `vi.mock`
 * rebinds a module's exports for its importers, but `workflowChainPacksCapability`
 * calls the predicate intra-module — so a mock reaches the route and not the
 * advertisement, and the resulting red is an artifact of the harness rather than a
 * finding. (Observed while writing this file.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createApp } from '../src/index.js';

const PATH = '/host/sample/workflow-chain:expand';
const PACK = 'vendor.openwop.workflow-chain-sample';
const TOKEN = 'dev-token';

interface Probe { advertised: unknown; status: number; body: unknown }
interface Boot { base: string; server: http.Server }

async function boot(seamEnabled: boolean): Promise<Boot> {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  if (seamEnabled) process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  else delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((res) => server.once('listening', () => res()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function post(base: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      packName: PACK,
      chainId: `${PACK}.summarize-text`,
      parameters: { sourceText: 'hi', targetLength: 'one-sentence', tone: 'casual' },
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** What one boot ADVERTISES on the wire and what it SERVES, both read over real
 *  HTTP — calling the predicate twice and comparing it to itself would restate the
 *  premise instead of checking it. */
async function probe(b: Boot): Promise<Probe> {
  // ADR 0812 P3c-0 — the major-2 document. `hostExpansionSeam` was a v1-only
  // facet (the closed v2 `workflowChainPacks` record declares no seat for it).
  const disco = (await (await fetch(`${b.base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as {
    workflowChainPacks?: { hostExpansionSeam?: unknown };
  };
  const served = await post(b.base, PATH);
  return { advertised: disco.workflowChainPacks?.hostExpansionSeam, ...served };
}

/** The disabled boot's answer — measured (grade-tests wave 64): the host's generic
 *  unmatched-route 404, i.e. the seam is not mounted at all. */
const DISABLED_STATUS = 404;
const DISABLED_BODY = { error: 'not_found', message: 'No route matches this request.' };

let enabled: Boot;
let disabled: Boot;
beforeAll(async () => {
  enabled = await boot(true);
  disabled = await boot(false);
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
}, 120_000);
afterAll(async () => {
  await Promise.all([enabled, disabled].map((b) => new Promise<void>((res) => b.server.close(() => res()))));
});

describe('ADR 0550 P2 — hostExpansionSeam never advertises what it does not serve', () => {
  // Twin of `workflow-chain-expand-seam.test.ts` › "1-node chain expands…" for the
  // 200; the half that is unique here is "major 2 claims nothing" on the SAME boot.
  it('seam enabled: serves 200 (and major 2 claims nothing — it has no seat)', async () => {
    const { advertised, status } = await probe(enabled);
    expect(advertised).toBeUndefined();
    expect(status).toBe(200);
  });

  it('seam disabled (production): advertises NOTHING and does not serve', async () => {
    const { advertised, status, body } = await probe(disabled);
    expect(advertised).toBeUndefined();
    expect(status).toBe(DISABLED_STATUS);
    expect(body).toEqual(DISABLED_BODY);
  });

  it('no boot advertises what it will not serve: the disabled seam is UNMOUNTED, not refused', async () => {
    // A refusing handler and a missing route would both be "not 200". The disabled
    // boot must answer exactly as it does for a path nothing registers, and the
    // enabled boot must not (so the comparison is not vacuous).
    const unmounted = await post(disabled.base, '/host/sample/workflow-chain:nothing-registers-this');
    const seam = await post(disabled.base, PATH);
    expect(seam).toEqual(unmounted);
    const enabledSeam = await post(enabled.base, PATH);
    expect(enabledSeam.status).not.toBe(unmounted.status);
    for (const b of [enabled, disabled]) expect((await probe(b)).advertised).toBeUndefined();
  });
});
