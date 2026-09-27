/**
 * UX_UPGRADE-media R2 (MED2-R2) — NO media surface verb emits a credential.
 *
 * `serveToken` is a bearer credential to the bytes: redeemable on a route that
 * is globally auth-exempt, ~100-year TTL, no revocation short of deleting the
 * asset. `serveUrl` is not a second thing — it is that token in a path.
 *
 * Both verbs here are `role:'action'`, so their outputs are RECORDED in the run
 * event log, and run reads gate only on `run.tenantId === req.tenantId` with no
 * org scoping and no output redaction. A member of org B, 403'd on org A's
 * media routes, can read a run's events.
 *
 * The first cut of this round hardened `select` — which has ZERO chain
 * consumers — and cited `createAssetFromServeUrl`'s allowlist as the safe
 * precedent while that allowlist carried the credential, and FOUR shipped node
 * packs call it. The realized value was nil and the busier door stayed open.
 * This asserts the property across the whole surface rather than one verb, so
 * the next verb added inherits the check instead of the oversight.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAsset } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';

const TENANT = 'org:media-cred';
const ORG = 'org-1';
let server: http.Server;

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('base64');

let token = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const d = getToggleDefault('media');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');

  const stored = await mediaStorage.put(TENANT, { contentBase64: png, contentType: 'image/png' });
  token = stored.serveToken;
  await createAsset({
    tenantId: TENANT, orgId: ORG, name: 'shared.png', contentType: 'image/png',
    sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken,
    uploadedBy: 'u-1',
  } as never);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/**
 * Every credential-shaped thing anywhere in a value.
 *
 * CORRECTED: the first version searched for a SPECIFIC token string, which
 * silently missed the real leak — `createAssetFromServeUrl` MINTS A NEW asset
 * with a NEW token, so the credential in its output was never the one passed
 * in. A sabotage probe came back green and the fix looked verified when it was
 * not. The property is structural (no credential field, no serve path), so
 * assert it structurally rather than hunting one value.
 */
function credentialsIn(v: unknown, path = '$', found: string[] = []): string[] {
  if (typeof v === 'string') {
    if (/\/assets\/[A-Za-z0-9_-]{8,}/.test(v)) found.push(`${path} = ${v}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => credentialsIn(x, `${path}[${i}]`, found));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'serveToken' || k === 'serveUrl' || k === 'storageRef') found.push(`${path}.${k}`);
      credentialsIn(x, `${path}.${k}`, found);
    }
  }
  return found;
}

const surface = () =>
  buildHostSurfaceBundle({ tenantId: TENANT, runId: 'run-1' })
    .features.media as Record<string, (a: Record<string, unknown>) => Promise<Record<string, unknown>>>;

describe('MED2-R2 — no recorded surface output carries a byte credential', () => {
  it('select emits no token, in any field, at any depth', async () => {
    const out = await surface().select!({ orgId: ORG, limit: 5 });
    expect((out.assets as unknown[]).length, 'the verb still returns a selection').toBeGreaterThan(0);
    expect(credentialsIn(out), 'no credential may appear anywhere').toEqual([]);
  });

  it('createAssetFromServeUrl emits no token either — the verb four packs actually call', async () => {
    const out = await surface().createAssetFromServeUrl!({ orgId: ORG, url: mediaStorage.serveUrl(token) });
    expect(out.assetId, 'the caller still gets a usable handle').toBeTruthy();
    // Note this verb MINTS a new asset, so its credential is a NEW token — the
    // reason a value-based search missed it entirely.
    expect(credentialsIn(out), 'no credential may appear anywhere').toEqual([]);
  });

  it('the token IS the credential (the premise this rests on)', async () => {
    // Without this, "the token is absent" could be satisfied by a token that is
    // worthless — and the whole finding would be theatre. A bare fetch of the
    // serve route, with NO auth, returns the bytes.
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}${mediaStorage.serveUrl(token)}`);
    expect(res.status, 'the serve route is auth-exempt by design (RFC 0055)').toBe(200);
  });
});
