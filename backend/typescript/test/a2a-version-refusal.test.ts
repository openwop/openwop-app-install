/**
 * ADR 0552 P1/P2 / RFC 0152 §B — "A host MUST NOT silently downgrade an
 * authenticated request."
 *
 * P1's version of this file was written when the host served A2A 0.3 only, and
 * its central case was `A2A-Version: 1.0` → refused. `servesA2AVersion()`
 * already existed and was already tested, but had NO production call site: five
 * assertions exercised the function's own arithmetic and would have passed
 * identically while every request was silently downgraded. A predicate nothing
 * calls does not refuse anything.
 *
 * P2 SHIPPED the 1.0 codec, so `1.0` is now served and the refusal case moved
 * to a version this host genuinely does not speak. That is the correct
 * migration, and it is worth being explicit that the assertion did not weaken:
 * what P1 pinned was "an explicit version outside `A2A_SUPPORTED_VERSIONS` is
 * refused, never downgraded", and that is what is pinned below — the array
 * grew, the rule did not move. The refusal is still asserted at the wire: a
 * real POST carrying a real header, checking that the body is an error AND that
 * no dispatch happened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { A2A_SUPPORTED_VERSIONS } from '../src/host/a2aProfile.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const PATH = '/v1/host/openwop-app/a2a';

interface RpcBody {
  jsonrpc?: string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: Array<{ '@type'?: string; reason?: string; domain?: string; metadata?: Record<string, string> }>;
  };
}

/** POST `agent/getCard` — the cheapest real method, so a leaked response is
 *  unmistakably a served request rather than an incidental error. */
async function post(headers: Record<string, string>): Promise<{ status: number; body: RpcBody }> {
  const res = await fetch(`${BASE}${PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'agent/getCard', params: {} }),
  });
  let body: RpcBody = {};
  try { body = (await res.json()) as RpcBody; } catch { /* no body */ }
  return { status: res.status, body };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('RFC 0152 §B — A2A version negotiation refuses rather than downgrades', () => {
  it('REFUSES an explicit unsupported version, and does not serve the request', async () => {
    // A version this host does not serve, chosen from OUTSIDE the SSoT so the
    // case survives the array growing again (P4 will shrink it).
    const unsupported = '0.2';
    expect(A2A_SUPPORTED_VERSIONS as readonly string[]).not.toContain(unsupported);
    const { status, body } = await post({ 'A2A-Version': unsupported });
    // Transport stays 200 — this endpoint's contract for every request error.
    expect(status).toBe(200);
    // ADR 0744 — `VersionNotSupportedError` -32009 (A2A 1.0.1 §3.3.2), not
    // the generic -32600 this answered before.
    expect(body.error?.code).toBe(-32009);
    expect(body.error?.message).toContain(unsupported);
    // The refusal must be ACTIONABLE: the peer learns what to retry with. §9.5
    // `Any[]`; `ErrorInfo.metadata` is map<string,string>, so the list is
    // comma-joined (openwop TODO.md decision D1).
    expect(body.error?.data).toEqual([
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'VERSION_NOT_SUPPORTED',
        domain: 'a2a-protocol.org',
        metadata: { supportedVersions: A2A_SUPPORTED_VERSIONS.join(',') },
      },
    ]);
    // The downgrade itself: a card in `result` would mean it was served anyway.
    expect(body.result).toBeUndefined();
  });

  it('SERVES an explicit supported version, under that version\'s codec', async () => {
    const { body } = await post({ 'A2A-Version': '0.3' });
    expect(body.error).toBeUndefined();
    expect((body.result as { protocolVersion?: string } | undefined)?.protocolVersion).toBe('0.3');
  });

  it('ADR 0552 P2 — `A2A-Version: 1.0` reaches the 1.0 CODEC, not the 0.3 one', async () => {
    // The half of §B that only becomes assertable once 1.0 is served: an
    // explicit 1.0 request must be answered under 1.0 SEMANTICS. Serving it
    // with the 0.3 handler would be the silent downgrade wearing a 200 — so
    // this asserts the 0.3 method name is REJECTED under a 1.0 header, which
    // only the 1.0 codec does.
    const { status, body } = await post({ 'A2A-Version': '1.0' });
    expect(status).toBe(200);
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32601);
    expect(body.error?.message).toContain('0.3 name');
  });

  it('serves a request with NO header — §B binds the 1.0 sender, not the 0.3 peer', async () => {
    // The compatibility leg, and it did NOT relax when 1.0 landed: an absent
    // header still means 0.3 (the upstream receiver rule §B restates), so an
    // existing peer keeps reaching the legacy codec. If this ever goes red,
    // either the refusal has been widened into "require the header" or the
    // header-less default has drifted to 1.0 — both break every 0.3 peer.
    const { body } = await post({});
    expect(body.error).toBeUndefined();
    expect((body.result as { protocolVersion?: string } | undefined)?.protocolVersion).toBe('0.3');
  });

  it('refuses garbage and conflicting duplicate headers — neither states a served version', async () => {
    expect((await post({ 'A2A-Version': 'not-a-version' })).body.error?.code).toBe(-32009);
    // Node collapses a repeat into `a, b`; two versions is not one version.
    const res = await fetch(`${BASE}${PATH}`, {
      method: 'POST',
      headers: [
        ['authorization', `Bearer ${TOKEN}`],
        ['content-type', 'application/json'],
        ['a2a-version', '0.3'],
        ['a2a-version', '1.0'],
      ],
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'agent/getCard', params: {} }),
    });
    expect(((await res.json()) as RpcBody).error?.code).toBe(-32009);
  });

  it('the advertised card version is one this host actually serves', async () => {
    // Pins the pairing the refusal depends on: refusing everything outside
    // A2A_SUPPORTED_VERSIONS is only honest if the card advertises from it.
    const { body } = await post({});
    const advertised = (body.result as { protocolVersion?: string } | undefined)?.protocolVersion;
    expect(A2A_SUPPORTED_VERSIONS as readonly string[]).toContain(advertised);
  });

  it('every served version has a codec — the advert cannot outrun the handler', async () => {
    // ADR 0552's standing rule, at the wire: "the entry and the behaviour land
    // together or not at all". For each version in the SSoT, a request under
    // that header must NOT be refused as unsupported (-32009). A version added
    // to the array without a codec branch reds here.
    for (const v of A2A_SUPPORTED_VERSIONS) {
      const { body } = await post({ 'A2A-Version': v });
      expect(body.error?.code, `A2A ${v} is advertised but refused as unsupported`).not.toBe(-32009);
    }
  });
});
