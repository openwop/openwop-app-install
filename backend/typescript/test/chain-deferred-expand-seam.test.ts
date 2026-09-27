/**
 * RFC 0124 (WCP4) — the `/v1/host/sample/chain/deferred-expand` conformance witness
 * seam (drives the `workflow-chain-deferred-parameters.test.ts` gated host legs
 * NON-VACUOUSLY). Asserts the seam returns the scenario's exact contract so the
 * published legs can't pass by soft-skipping on a 404.
 *
 * seam ON (OPENWOP_TEST_SEAM_ENABLED) ⇒ the real deferred pipeline
 * (expandChain{deferred} → bare-param override → frozen-def fork replay →
 * composePromptTemplate); seam OFF ⇒ 404 (legs soft-skip).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const PATH = '/v1/host/sample/chain/deferred-expand';

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let b: Record<string, unknown> = {};
  try { b = (await res.json()) as Record<string, unknown>; } catch { /* no body */ }
  return { status: res.status, body: b };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('RFC 0124 deferred-expand witness seam (behavioral, non-vacuous)', () => {
  it('bare-param override rebinds the value; :fork replays it; deferred var composes untrusted (R1/R4)', async () => {
    const { status, body } = await post({
      chainId: 'conformance.deferred',
      params: { topic: 'default-topic' },
      override: { topic: 'run-topic' },
      fork: true,
    });
    expect(status).toBe(200);
    expect(body.resolved).toBe('run-topic');       // override wins over default
    expect(body.forkResolved).toBe('run-topic');   // frozen def → byte-stable replay
    expect(body.contentTrust).toBe('untrusted');   // deferred-variable binding fenced
  });

  it('a sensitive param composes as [REDACTED:<credentialRef>] and plaintext appears nowhere (SR-1)', async () => {
    const { status, body } = await post({
      chainId: 'conformance.deferred-sensitive',
      sensitiveParam: 'apiKey',
      credentialRef: 'cred-123',
    });
    expect(status).toBe(200);
    expect(String(body.composed)).toContain('[REDACTED:cred-123]');
    expect(JSON.stringify(body)).not.toContain('conformance-plaintext-'); // provisioned secret value
  });

  it('unknown conformance chainId → 404 chain_not_found', async () => {
    const { status, body } = await post({ chainId: 'conformance.nope' });
    expect(status).toBe(404);
    expect(body.error).toBe('chain_not_found');
  });

  // RFC 0136 B1 — inline-chain deferred expansion returns variables[] with format
  // present IFF minted (req 7 propagation; req 1 string-only; req 2 unknown copied).
  it('inline chain → variables[] carries `format` iff minted (RFC 0136 B1 witness)', async () => {
    const { status, body } = await post({
      chain: {
        parameters: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' }, // req 7 — copied verbatim
            note: { type: 'string', format: 'vendor.acme.freeform' }, // req 2 — unknown, still copied
            count: { type: 'number', format: 'email' }, // req 1 — non-string, format dropped
            plain: { type: 'string' }, // string, no format declared → no format minted
          },
        },
      },
      values: { email: 'a@b.com', note: 'x', count: 3, plain: 'p' },
    });
    expect(status).toBe(200);
    const vars = (body.variables ?? []) as Array<{ name: string; type?: string; format?: string; sensitive?: boolean }>;
    const byName = (n: string) => vars.find((v) => v.name === n);

    expect(byName('email')?.format).toBe('email'); // req 7 — verbatim
    expect(byName('note')?.format).toBe('vendor.acme.freeform'); // req 2 — unknown copied
    expect(byName('count')).toBeTruthy();
    expect(byName('count')).not.toHaveProperty('format'); // req 1 — non-string dropped
    expect(byName('plain')).toBeTruthy();
    expect(byName('plain')).not.toHaveProperty('format'); // string, none declared
    // Names de-prefixed to the bare parameter the caller passed.
    expect(byName('email')?.type).toBe('string');
  });

  it('inline chain — a sensitive string param carries both `format` and `sensitive` (RFC 0136 req 6)', async () => {
    const { status, body } = await post({
      chain: {
        parameters: {
          type: 'object',
          properties: { apiKeyEmail: { type: 'string', format: 'email', 'x-openwop-sensitive': true } },
        },
      },
      values: {},
    });
    expect(status).toBe(200);
    const v = ((body.variables ?? []) as Array<{ name: string; format?: string; sensitive?: boolean }>)
      .find((x) => x.name === 'apiKeyEmail');
    expect(v?.format).toBe('email');
    expect(v?.sensitive).toBe(true);
  });
});
