import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { VENDOR_ROOT, PROTOCOL_VERSION_V2, v1DeprecationHeaders } from '../src/middleware/protocolVersion.js';

/**
 * ADR 0669 — the retirement REHEARSAL.
 *
 * `versioning.md` §5 makes retirement atomic, and the corpus EOS clock decides
 * WHEN. Neither says anything about whether the host can actually do it, and
 * until this file existed nothing here did: `OPENWOP_V1_RETIRED` would have
 * been exercised for the first time on the day it mattered, against production,
 * with the overlap already gone. A flag that has never been flipped is a claim,
 * not a mechanism.
 *
 * So this boots the host BOTH ways in one process and asserts the whole cut.
 * Every retired-side assertion is paired with its pre-cut control, because an
 * assertion that passes in both states is measuring nothing — that is the
 * vacuity this repo keeps finding in its own gates.
 *
 * Two boots in one process is also why `v1Retired()` reads the env at CALL
 * time rather than capturing it at import: a module-level snapshot would make
 * the second boot silently inherit the first, and the test would pass while
 * measuring one app twice.
 */
let preCut: Server;
let retired: Server;
let preBase = '';
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

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const dir = mkdtempSync(join(tmpdir(), 'adr0669-'));
  const shellFile = join(dir, 'app-shell.html');
  writeFileSync(shellFile, SHELL);
  process.env.OPENWOP_SPA_SHELL_FILE = shellFile;

  delete process.env.OPENWOP_V1_RETIRED;
  ({ server: preCut, base: preBase } = await boot());
  ({ server: retired, base: retBase } = await boot());
}, 120_000);

afterAll(async () => {
  delete process.env.OPENWOP_V1_RETIRED;
  delete process.env.OPENWOP_SPA_SHELL_FILE;
  await new Promise<void>((r) => preCut.close(() => r()));
  await new Promise<void>((r) => retired.close(() => r()));
});

/** Both apps are live throughout; the flag decides which contract answers. */
async function asRetired<T>(fn: () => Promise<T>): Promise<T> {
  process.env.OPENWOP_V1_RETIRED = 'true';
  try { return await fn(); } finally { delete process.env.OPENWOP_V1_RETIRED; }
}
const get = (base: string, path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers, redirect: 'manual' });

describe('ADR 0669 — retirement is one atomic flip, rehearsed', () => {
  it('PRE-CUT control: the advertisement carries both majors and prefers 1.1', async () => {
    const doc = (await (await get(preBase, '/.well-known/openwop', AUTH)).json()) as Record<string, unknown>;
    expect(doc.protocolVersions).toEqual(['1.1', '2.0']);
    expect(doc.preferredVersion).toBe('1.1');
    // `minClientVersion` is a 2.x obligation (§1.5) and is advertised only in
    // the v2 document, so its ABSENCE here is the correct v1 shape. Asserting
    // `'1.0'` was my error, not the host's — and it is the kind of error a
    // control assertion is supposed to catch in the cheap direction.
    expect(doc.minClientVersion).toBeUndefined();
  });

  it('RETIRED: the advertisement carries ONLY 2.0, and the three move together', async () => {
    const doc = await asRetired(async () => (await (await get(retBase, '/.well-known/openwop', {
      ...AUTH, 'OpenWOP-Version': '2',
    })).json()) as Record<string, unknown>);
    // The point of the ADR: these cannot disagree, because all three derive
    // from one predicate. If a future edit sets them independently, this is
    // the assertion that notices.
    expect(doc.protocolVersions).toEqual([PROTOCOL_VERSION_V2]);
    expect(doc.preferredVersion).toBe(PROTOCOL_VERSION_V2);
    expect(doc.minClientVersion).toBe(PROTOCOL_VERSION_V2);
  });

  it('PRE-CUT control: /v1 is served, and says it is deprecated', async () => {
    const res = await get(preBase, '/v1/.well-known/openwop', AUTH);
    expect(res.status).not.toBe(410);
    expect(res.headers.get('deprecation')).toMatch(/^@\d+$/);
  });

  it('RETIRED: an INBOUND /v1 path is 410 Gone and names the surviving address', async () => {
    const res = await asRetired(() => get(retBase, '/v1/.well-known/openwop', AUTH));
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; message: string; details: Record<string, unknown> };
    expect(body.error).toBe('protocol_version_unsupported');
    expect(body.message).toMatch(/OpenWOP-Version: 2/);
    expect(body.details.protocolVersions).toEqual([PROTOCOL_VERSION_V2]);
  });

  it('RETIRED: the vendor TWIN retires with /v1 while the CANONICAL root survives', async () => {
    // RFC 0181: `/host/<org>/…` is version-agnostic and outlives the cut; its
    // `/v1/host/<org>/…` twin is part of the withdrawn path space. This pair is
    // the one most likely to be got wrong, because the host rewrites the
    // canonical form ONTO the twin internally — so a naive refusal would kill
    // both.
    const twin = await asRetired(() => get(retBase, `/v1${VENDOR_ROOT}/orgs`, AUTH));
    expect(twin.status).toBe(410);
    const canonical = await asRetired(() => get(retBase, `${VENDOR_ROOT}/orgs`, AUTH));
    expect(canonical.status).not.toBe(410);
  });

  it('RETIRED: no Deprecation header — asserted where the guard is actually REACHABLE', () => {
    // CORRECTED after sabotage. The first version of this test fetched
    // `/.well-known/openwop` with `OpenWOP-Version: 2` and asserted no
    // `Deprecation` header — and it PASSED with the guard removed, because on
    // that path the header was never going to be set anyway: the middleware
    // only sets it for a versioned path or `major === 1`, and post-cut neither
    // can occur. The assertion was true for a reason that had nothing to do
    // with the code it claimed to be testing.
    //
    // The guard is not dead, though: `v1DeprecationHeaders()` is exported and
    // called directly (`adr0654-…` does exactly that), so the invariant belongs
    // at the unit level where it IS reachable.
    expect(v1DeprecationHeaders()).not.toBeNull();
    process.env.OPENWOP_V1_RETIRED = 'true';
    try {
      expect(v1DeprecationHeaders()).toBeNull();
    } finally {
      delete process.env.OPENWOP_V1_RETIRED;
    }
    expect(v1DeprecationHeaders()).not.toBeNull();
  });

  it('RETIRED: the 410 itself carries no Deprecation header', async () => {
    // The reachable HTTP half: pre-cut this exact path DOES carry `Deprecation`
    // (the control above proves it), so a refusal that still advertised a
    // deprecation would be claiming a contract it had just withdrawn.
    const res = await asRetired(() => get(retBase, '/v1/.well-known/openwop', AUTH));
    expect(res.status).toBe(410);
    expect(res.headers.get('deprecation')).toBeNull();
    expect(res.headers.get('sunset')).toBeNull();
  });

  it('RETIRED: a header-less request defaults to major 2 (the §1.3 flip)', async () => {
    const res = await asRetired(() => get(retBase, '/.well-known/openwop', AUTH));
    expect(res.headers.get('openwop-version')).toBe(PROTOCOL_VERSION_V2);
  });

  it('RETIRED: a browser on a SHARED NAME still gets the SPA shell, not JSON', async () => {
    // The hazard ADR 0646 was built for, and the reason it must be rehearsed
    // rather than reasoned about: before content negotiation existed, the only
    // thing keeping a shared name's page apart from its protocol operation was
    // the header-less default being major 1. Retirement flips that default, so
    // on cutover day three SPA pages would have started answering JSON.
    const res = await asRetired(() => get(retBase, '/runs', BROWSER));
    const body = await res.text();
    expect(body).toContain('data-shell="adr0669"');
    expect(res.headers.get('openwop-version')).toBeNull();
  });
});
