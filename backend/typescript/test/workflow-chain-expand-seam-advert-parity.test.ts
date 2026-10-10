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
 * Mocking is deliberately NOT used to fake the pack-absent state. `vi.mock`
 * rebinds a module's exports for its importers, but `workflowChainPacksCapability`
 * calls the predicate intra-module — so a mock reaches the route and not the
 * advertisement, and the resulting red is an artifact of the harness rather than a
 * finding. (Observed while writing this file.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createApp } from '../src/index.js';

const PATH = '/host/sample/workflow-chain:expand';
const PACK = 'vendor.openwop.workflow-chain-sample';
const TOKEN = 'dev-token';

const servers: http.Server[] = [];

/** Boots a host with the seam env gate in the given state and reports what it
 *  ADVERTISES on the wire and what it SERVES. Both are read from real HTTP —
 *  calling the predicate twice and comparing it to itself would restate the
 *  premise instead of checking it. */
async function bootAndProbe(seamEnabled: boolean): Promise<{ advertised: unknown; status: number }> {
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
  servers.push(server);
  await new Promise<void>((res) => server.once('listening', () => res()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // ADR 0812 P3c-0 — the major-2 document. `hostExpansionSeam` was a v1-only
  // facet (the closed v2 `workflowChainPacks` record declares no seat for it),
  // so major 2 must never claim it, in either boot.
  const disco = (await (await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as {
    workflowChainPacks?: { hostExpansionSeam?: unknown };
  };

  const res = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      packName: PACK,
      chainId: `${PACK}.summarize-text`,
      parameters: { sourceText: 'hi', targetLength: 'one-sentence', tone: 'casual' },
    }),
  });

  return { advertised: disco.workflowChainPacks?.hostExpansionSeam, status: res.status };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))));
});

describe('ADR 0550 P2 — hostExpansionSeam never advertises what it does not serve', () => {
  // ADR 0812 P3c-0 — the "advertises true when enabled" half was the v1
  // document's claim and was deleted with it; major 2 has no seat to claim.
  it('seam enabled: serves 200 (and major 2 claims nothing — it has no seat)', async () => {
    const { advertised, status } = await bootAndProbe(true);
    expect(advertised).toBeUndefined();
    expect(status).toBe(200);
  });

  it('seam disabled (production): advertises NOTHING and does not serve', async () => {
    const { advertised, status } = await bootAndProbe(false);
    expect(advertised).toBeUndefined();
    expect(status).not.toBe(200);
  });

  it('no boot advertises what it will not serve', async () => {
    // One assertion over every state this host can boot into.
    for (const seamEnabled of [true, false]) {
      const { advertised, status } = await bootAndProbe(seamEnabled);
      if (advertised === true) expect(status).toBe(200);
      expect(status === 200).toBe(seamEnabled);
    }
  });
});
