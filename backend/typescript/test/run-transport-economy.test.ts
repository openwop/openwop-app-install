/**
 * RFC 0115 — Run Transport Economy. Reference-host conformance for the
 * conditional GET (sequence-derived ETag + If-None-Match/304) and
 * Content-Encoding negotiation on GET /v1/runs/{runId}.
 *
 * Node's global `fetch` (undici) transparently decompresses gzip and strips
 * `Content-Encoding`, so the encoding assertions use the low-level `http`
 * client to read raw bytes + headers and gunzip manually.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import * as zlib from 'node:zlib';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createApp } from '../src/index.js';
import { getEventLog } from '../src/executor/eventLog.js';

/** Decode a Content-Encoding back to identity bytes (mirrors the encoders). */
function decode(enc: string, body: Buffer): Buffer {
  if (enc === 'gzip') return gunzipSync(body);
  if (enc === 'br') return brotliDecompressSync(body);
  // zstd: the host advertises it on Node ≥22.15 (where node:zlib gained
  // zstdDecompressSync); decode it so the round-trip test tracks the host's
  // honest contentEncodings advertisement instead of throwing.
  if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(body);
  throw new Error(`test decoder missing for advertised encoding '${enc}'`);
}

let server: http.Server;
let BASE: string;
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
  await new Promise<void>((res) => {
    server = app.listen(0, () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

/** Raw GET — no auto-decompression — returning status, headers, and bytes. */
function rawGet(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${BASE}${path}`,
      { headers: { authorization: `Bearer ${TOKEN}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
  });
}

async function createCompletedRun(): Promise<string> {
  const res = await fetch(`${BASE}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ workflowId: 'openwop-app.uppercase', tenantId: 'demo', inputs: { text: 'hi' } }),
  });
  const { runId } = (await res.json()) as { runId: string };
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const snap = await rawGet(`/v1/runs/${runId}`);
    const status = (JSON.parse(snap.body.toString('utf8')) as { status: string }).status;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  return runId;
}

describe('RFC 0115 — restTransport advertisement', () => {
  it('advertises conditionalRunGet + an honest, non-empty contentEncodings list', async () => {
    const res = await rawGet('/.well-known/openwop');
    const body = JSON.parse(res.body.toString('utf8')) as {
      capabilities: { restTransport?: { conditionalRunGet?: boolean; contentEncodings?: string[] } };
    };
    const rt = body.capabilities.restTransport;
    expect(rt?.conditionalRunGet).toBe(true);
    // gzip is the SHOULD baseline on any Node build; br/zstd only appear where
    // the runtime can encode them. The advert must be a subset of the RFC 0115
    // enum {gzip,br,zstd}.
    expect(rt?.contentEncodings).toContain('gzip');
    for (const enc of rt?.contentEncodings ?? []) expect(['gzip', 'br', 'zstd']).toContain(enc);
  });
});

describe('RFC 0115 — conditional GET on /v1/runs/{runId}', () => {
  it('emits a strong ETag on 200 and honors If-None-Match with 304 (empty body)', async () => {
    const runId = await createCompletedRun();

    const first = await rawGet(`/v1/runs/${runId}`);
    expect(first.status).toBe(200);
    const etag = first.headers['etag'];
    expect(typeof etag).toBe('string');
    expect(etag!.startsWith('"')).toBe(true); // strong validator, no W/ prefix
    expect(etag!.startsWith('W/')).toBe(false);
    expect(first.headers['vary']).toMatch(/Accept-Encoding/i);

    const revalidate = await rawGet(`/v1/runs/${runId}`, { 'if-none-match': etag! });
    expect(revalidate.status).toBe(304);
    expect(revalidate.body.length).toBe(0);
  });

  it('keeps the ETag stable while the run does not advance, and changes it when it does', async () => {
    const runId = await createCompletedRun();
    const before = (await rawGet(`/v1/runs/${runId}`)).headers['etag'] as string;

    // Stable across repeated reads with no intervening transition.
    expect((await rawGet(`/v1/runs/${runId}`)).headers['etag']).toBe(before);

    // Advance the run's persisted event log (same storage the handler reads
    // its sequence from) → the sequence-derived ETag MUST change.
    await getEventLog().append({ runId, type: 'host.test.tick', payload: { n: 1 } });

    const after = (await rawGet(`/v1/runs/${runId}`)).headers['etag'] as string;
    expect(after).not.toBe(before);

    // The previously-cached ETag is now stale → a conditional GET re-downloads
    // (200), it does NOT spuriously 304.
    const stale = await rawGet(`/v1/runs/${runId}`, { 'if-none-match': before });
    expect(stale.status).toBe(200);
  });
});

describe('RFC 0115 — Content-Encoding negotiation', () => {
  it('every advertised encoding round-trips byte-identically to identity (Content-Encoding + Vary set)', async () => {
    const runId = await createCompletedRun();

    const identity = await rawGet(`/v1/runs/${runId}`); // no Accept-Encoding
    expect(identity.headers['content-encoding']).toBeUndefined();

    // Drive the witness off the host's own advert so it can't drift from what
    // the host actually serves (gzip is the baseline; br when present).
    const disc = JSON.parse((await rawGet('/.well-known/openwop')).body.toString()) as {
      capabilities: { restTransport?: { contentEncodings?: string[] } };
    };
    const advertised = disc.capabilities.restTransport?.contentEncodings ?? [];
    expect(advertised).toContain('gzip');

    for (const enc of advertised) {
      const res = await rawGet(`/v1/runs/${runId}`, { 'accept-encoding': enc });
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe(enc);
      expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
      expect(decode(enc, res.body).equals(identity.body)).toBe(true);
    }
  });

  it('honors server preference (br before gzip) when the client accepts both', async () => {
    const runId = await createCompletedRun();
    const advertised = (
      JSON.parse((await rawGet('/.well-known/openwop')).body.toString()) as {
        capabilities: { restTransport?: { contentEncodings?: string[] } };
      }
    ).capabilities.restTransport?.contentEncodings ?? [];
    const res = await rawGet(`/v1/runs/${runId}`, { 'accept-encoding': 'gzip, br' });
    // The chosen encoding is whichever the host prefers among what it serves.
    const expected = advertised.includes('br') ? 'br' : 'gzip';
    expect(res.headers['content-encoding']).toBe(expected);
    expect(decode(expected, res.body).equals((await rawGet(`/v1/runs/${runId}`)).body)).toBe(true);
  });

  it('falls back to identity when the client accepts no encoding we serve', async () => {
    const runId = await createCompletedRun();
    const res = await rawGet(`/v1/runs/${runId}`, { 'accept-encoding': 'identity' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
