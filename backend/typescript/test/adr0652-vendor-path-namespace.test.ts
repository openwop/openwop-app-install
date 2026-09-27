import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { VENDOR_ORG, VENDOR_ROOT, isVendorPath, v2MountedRootPrefixes } from '../src/middleware/protocolVersion.js';

/**
 * ADR 0652 / RFC 0181 — `/host/<org>/…` is this host's proprietary namespace:
 * version-agnostic, outside the protocol contract, the header selects nothing.
 * Before this ADR the address answered by ACCIDENT (a derived `/host` manifest
 * prefix + ADR 0646 negotiation), stamped a version header on a non-protocol
 * response, and served the SPA shell to a browser Accept.
 */
let server: Server;
let base = '';
const AUTH = { Authorization: 'Bearer dev-token' };
const SHELL = '<!doctype html><html><body data-shell="adr0652">shell</body></html>';
const VENDOR = `${VENDOR_ROOT}/orgs`;
const TWIN = `/v1${VENDOR_ROOT}/orgs`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const dir = mkdtempSync(join(tmpdir(), 'adr0652-'));
  const shellFile = join(dir, 'app-shell.html');
  writeFileSync(shellFile, SHELL);
  process.env.OPENWOP_SPA_SHELL_FILE = shellFile;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  delete process.env.OPENWOP_SPA_SHELL_FILE;
  await new Promise<void>((r) => server.close(() => r()));
});

const get = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { headers, redirect: 'manual' });

describe('ADR 0652 — /host/<org>/… is the vendor namespace, and the header selects nothing there', () => {
  it('a browser Accept with no header gets the VENDOR JSON, not the SPA shell (it is not a shared manifest name)', async () => {
    const res = await get(VENDOR, { ...AUTH, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.text()).not.toContain('data-shell=');
  });

  it('carries NO OpenWOP-Version response header — with the header, without it, or with a malformed one — and equals the /v1 twin', async () => {
    const twin = await get(TWIN, { ...AUTH, Accept: 'application/json' });
    expect(twin.status).toBe(200);
    expect(twin.headers.get('openwop-version')).toBe('1.1'); // the twin IS versioned
    const twinBody = await twin.json();
    for (const headers of [
      { ...AUTH, Accept: 'application/json' },
      { ...AUTH, Accept: 'application/json', 'OpenWOP-Version': '2' },
      { ...AUTH, Accept: 'application/json', 'OpenWOP-Version': '2.0' },
      { ...AUTH, Accept: 'application/json', 'OpenWOP-Version': '9' },
      { ...AUTH, Accept: 'application/json', 'OpenWOP-Version': 'not-a-version' },
    ]) {
      const res = await get(VENDOR, headers);
      expect(res.status, JSON.stringify(headers)).toBe(200);
      expect(res.headers.get('openwop-version'), JSON.stringify(headers)).toBeNull();
      expect(await res.json()).toEqual(twinBody);
    }
  });

  it('a manifest /host/* operation is still a PROTOCOL path (the vendor branch is scoped to the org root)', async () => {
    expect(isVendorPath('/host/effect-seams')).toBe(false);
    expect(isVendorPath('/host/events')).toBe(false);
    expect(isVendorPath(`/host/${VENDOR_ORG}x/orgs`)).toBe(false); // prefix, not segment
    expect(isVendorPath(VENDOR_ROOT)).toBe(true);
    expect(isVendorPath(`${VENDOR_ROOT}/orgs`)).toBe(true);
    const res = await get('/host/effect-seams', { ...AUTH, Accept: 'application/json', 'OpenWOP-Version': '2' });
    expect(res.headers.get('openwop-version')).toBe('2.0');
  });

  it('the org is registered in the vendored declaration and reserved segments do not collide with it', () => {
    const decl = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'schemas', 'v2', 'declaration.json'), 'utf8')) as {
      extensions?: Record<string, unknown>; reservedOrgs?: string[];
    };
    // RFC 0180 A.5: in effect once a spec-artifacts release carrying the row is installed (2.0.12).
    if (decl.extensions && VENDOR_ORG in decl.extensions) {
      expect(decl.reservedOrgs ?? []).not.toContain(VENDOR_ORG);
    }
    expect(v2MountedRootPrefixes()).toContain('/host'); // the manifest root the namespace shares
  });

  it('the v2 discovery document DECLARES the mount (RFC 0181: advertised, not inferred)', async () => {
    const res = await get('/.well-known/openwop', { Accept: 'application/json', 'OpenWOP-Version': '2' });
    expect(res.status).toBe(200);
    const doc = await res.json() as { extensions?: Record<string, { root?: string; twin?: string; rfc?: string }> };
    const rec = doc.extensions?.[`${VENDOR_ORG}.host`];
    expect(rec?.root).toBe(`${VENDOR_ROOT}/`);
    expect(rec?.twin).toBe(`/v1${VENDOR_ROOT}/`);
    expect(rec?.rfc).toBe('0181');
  });
});
