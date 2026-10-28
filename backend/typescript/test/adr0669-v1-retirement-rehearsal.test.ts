import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { VENDOR_ROOT } from '../src/middleware/protocolVersion.js';

/**
 * ADR 0669 — the retirement REHEARSAL, now the retired host's standing witness.
 *
 * This file booted the host BOTH ways in one process (`OPENWOP_V1_RETIRED`
 * false and true) and paired every retired-side assertion with its pre-cut
 * control. ADR 0812 P3c removed the pre-cut state from the code, so the
 * controls went with it. The retired-side assertions stay: they are what the
 * cut promised, and nothing else here pins all of them on one boot.
 *
 * Tracker TST-BGF-5. Red when: discovery advertises a non-2.0 `minClientVersion`;
 * the `/v1` front stops answering 410, drops the surviving address from its
 * message, or carries a Deprecation header; a header-less request stops getting
 * the 2.0 response header; a browser on a shared name gets JSON; the asset
 * forward drops the query; or a non-read rides the forward.
 *
 * DOUBLE GUARD (stored asset address): the asset exception forwards through
 * `retiredAssetServePath` AND through `heldByThirdParties`, because the asset root
 * is also a public path (`middleware/auth.ts`). Sabotaging one alone stays green;
 * the forward itself (Location + query) and the write refusal are probed.
 */
let retired: Server;
let retBase = '';
const AUTH = { Authorization: 'Bearer dev-token' };
const SHELL = '<!doctype html><html><body data-shell="adr0669">shell</body></html>';
const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

async function boot(): Promise<{ server: Server; base: string }> {
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  return { server, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_SPA_SHELL_FILE'] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const dir = mkdtempSync(join(tmpdir(), 'adr0669-'));
  const shellFile = join(dir, 'app-shell.html');
  writeFileSync(shellFile, SHELL);
  process.env.OPENWOP_SPA_SHELL_FILE = shellFile;

  ({ server: retired, base: retBase } = await boot());
}, 120_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((r) => retired.close(() => r()));
});

const get = (base: string, path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers, redirect: 'manual' });

describe('ADR 0669 — the retired host, as cut', () => {
  it('RETIRED: the advertisement carries ONLY 2.0, and the three move together', async () => {
    const doc = await (await (await get(retBase, '/.well-known/openwop', {
      ...AUTH, 'OpenWOP-Version': '2',
    })).json()) as Record<string, unknown>;
    // The three moved together at the cut; since ADR 0812 they are constants.
    expect(doc.protocolVersions).toEqual(['2.0']);
    expect(doc.preferredVersion).toBe('2.0');
    expect(doc.minClientVersion).toBe('2.0');
  });

  it('RETIRED: an INBOUND /v1 path is 410 Gone and names the surviving address', async () => {
    const res = await get(retBase, '/v1/.well-known/openwop', AUTH);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; message: string; details: Record<string, unknown> };
    expect(body.error).toBe('protocol_version_unsupported');
    expect(body.message).toMatch(/OpenWOP-Version: 2/);
    expect(body.details.protocolVersions).toEqual(['2.0']);
  });

  it('RETIRED: the vendor TWIN retires with /v1 while the CANONICAL root survives', async () => {
    // RFC 0181: `/host/<org>/…` is version-agnostic and outlives the cut; its
    // `/v1/host/<org>/…` twin is part of the withdrawn path space. This pair is
    // the one most likely to be got wrong, because the host rewrites the
    // canonical form ONTO the twin internally — so a naive refusal would kill
    // both.
    const twin = await get(retBase, `/v1${VENDOR_ROOT}/orgs`, AUTH);
    expect(twin.status).toBe(410);
    const canonical = await get(retBase, `${VENDOR_ROOT}/orgs`, AUTH);
    expect(canonical.status).toBe(200);
    expect(canonical.headers.get('content-type')).toContain('application/json');
  });

  it('RETIRED: the 410 itself carries no Deprecation header', async () => {
    // A refusal that still advertised a deprecation would be claiming a
    // contract it had just withdrawn.
    const res = await get(retBase, '/v1/.well-known/openwop', AUTH);
    expect(res.status).toBe(410);
    expect(res.headers.get('deprecation')).toBeNull();
    expect(res.headers.get('sunset')).toBeNull();
  });

  it('RETIRED: a header-less request defaults to major 2 (the §1.3 flip)', async () => {
    const res = await get(retBase, '/.well-known/openwop', AUTH);
    expect(res.headers.get('openwop-version')).toBe('2.0');
  });

  it('RETIRED: a browser on a SHARED NAME still gets the SPA shell, not JSON', async () => {
    // The hazard ADR 0646 was built for, and the reason it must be rehearsed
    // rather than reasoned about: before content negotiation existed, the only
    // thing keeping a shared name's page apart from its protocol operation was
    // the header-less default being major 1. Retirement flips that default, so
    // on cutover day three SPA pages would have started answering JSON.
    const res = await get(retBase, '/runs', BROWSER);
    const body = await res.text();
    expect(body).toContain('data-shell="adr0669"');
    expect(res.headers.get('openwop-version')).toBeNull();
  });

  // ── Stored asset addresses: the one /v1 address that survives the cut ──────
  // Asset URLs were handed out and SAVED (drawings, documents, run event logs,
  // emails). They are not rewritten — a raw rewrite breaks rows under an
  // integrity hash — so the old address redirects instead of answering 410.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  async function uploadOn(base: string): Promise<string> {
    const up = await fetch(`${base}${VENDOR_ROOT}/media/upload`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ contentBase64: PNG, contentType: 'image/png', name: 'pixel.png' }),
    });
    expect(up.status).toBe(201);
    const url = ((await up.json()) as { url: string }).url;
    expect(url.startsWith(`${VENDOR_ROOT}/assets/`)).toBe(true); // minted unversioned
    return url;
  }

  it('RETIRED: the stored /v1 asset address redirects to the unversioned one, which serves the bytes', async () => {
    const url = await uploadOn(retBase);
    const res = await get(retBase, `/v1${url}?download=1`);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`${url}?download=1`); // query kept
    const followed = await fetch(`${retBase}/v1${url}`); // follows the redirect
    expect(followed.status).toBe(200);
    expect(followed.headers.get('content-type')).toContain('image/png');
    expect((await followed.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('RETIRED: nothing else rides the exception', async () => {
    const url = await uploadOn(retBase);
    const status = (path: string, init: RequestInit = {}) =>
      fetch(`${retBase}${path}`, { ...init, redirect: 'manual', headers: AUTH }).then((r) => r.status);
    // A write to the old asset address is still gone.
    expect(await status(`/v1${url}`, { method: 'POST' })).toBe(410);
    expect(await status(`/v1${url}`, { method: 'DELETE' })).toBe(410);
    // A longer path under the asset root is not a token. CORRECTED by ADR 0806:
    // this used to assert 410, pinning ADR 0669's asset-only exception. Reads of
    // every address outsiders hold now forward, so the old address forwards to
    // its exact unversioned twin — which serves nothing, because it is not a
    // token. The property kept is the one that mattered: no extra byte is served.
    const extra = await fetch(`${retBase}/v1${url}/extra`, { redirect: 'manual', headers: AUTH });
    expect(extra.status).toBe(308);
    expect(extra.headers.get('location')).toBe(`${url}/extra`);
    expect(await status(`${url}/extra`)).toBe(404);
    // Its neighbours in the vendor space, and the protocol, are still gone.
    expect(await status('/v1/host/openwop-app/media/upload', { method: 'POST' })).toBe(410);
    expect(await status('/v1/runs')).toBe(410);
  });
});
