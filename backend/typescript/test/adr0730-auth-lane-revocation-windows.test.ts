/**
 * ADR 0730 C.3 — every advertised auth lane whose revocation rule NAMES A
 * WINDOW carries `revocationWindowSeconds`, asserted on the SERVED v2 root.
 *
 * WHY A SEPARATE BOOT. The corpus scenario `v2-lane-issuer-advertised` covers
 * this rule, and it passed on this host BEFORE the window existed — because
 * with no workload trust root configured the `workload` lane is not emitted,
 * so its windowed-rule assertion ranged over an empty set. A green there was
 * evidence about the environment, not about the host. This file configures the
 * lane so the assertion has something to range over.
 *
 * `identity.md` §2.2: "`revocationWindowSeconds` (integer >= 1) MUST be
 * advertised wherever the rule names a window (`exp-and-recheck`,
 * `short-lived`, `rebind`)."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';

/** The rules that name a window (identity.md §2.2). */
const WINDOWED = new Set(['exp-and-recheck', 'exp-only', 'short-lived', 'rebind']);

let server: Server;
let lanes: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Enable the workload lane so its rule is actually advertised.
  process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = 'urn:test:aud';
  process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST = 'spiffe://example.org/ns/default=urn:test:root';
  // The oidc lane (`exp-only`) is the windowed lane now that `workload` is not.
  // Never contacted: the advert reads config only, no JWKS fetch happens here.
  process.env.OPENWOP_OIDC_ISSUER = 'https://issuer.invalid';
  process.env.OPENWOP_OIDC_AUDIENCE = 'urn:test:aud';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const doc = await (await fetch(`${base}/.well-known/openwop`, {
    headers: { Authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' },
  })).json() as { auth?: { lanes?: Array<Record<string, unknown>> } };
  lanes = doc.auth?.lanes ?? [];
}, 120_000);   // a boot dies at the HOOK timeout, which --testTimeout does not raise

afterAll(async () => {
  delete process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE;
  delete process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST;
  delete process.env.OPENWOP_OIDC_ISSUER;
  delete process.env.OPENWOP_OIDC_AUDIENCE;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('auth lane revocation windows (identity.md §2.2)', () => {
  it('the workload lane is actually advertised — otherwise everything below is vacuous', () => {
    expect(lanes.length, 'the v2 auth family must be served at all').toBeGreaterThan(0);
    expect(lanes.some((l) => l.lane === 'workload'), 'workload identity is configured above, so the lane must appear').toBe(true);
  });

  it('every windowed rule carries an integer window >= 1', () => {
    const windowed = lanes.filter((l) => WINDOWED.has(String(l.revocation)));
    expect(windowed.length, 'at least one windowed lane, or this leg proves nothing').toBeGreaterThan(0);
    for (const l of windowed) {
      expect(Number.isInteger(l.revocationWindowSeconds), `${String(l.lane)} (${String(l.revocation)}) must advertise an integer window`).toBe(true);
      expect(l.revocationWindowSeconds as number).toBeGreaterThanOrEqual(1);
    }
  });

  it("the workload lane advertises its §2.2 row's rule, `delegation-expiry`, and no window", () => {
    // CORRECTED 2026-09-23 (ADR 0743). This leg pinned `short-lived` + the mint
    // ceiling — a rule §2.2 lists for `mtls`, not `workload`, and the 2.36 suite's
    // `v2-lane-issuer-advertised` reds on it. The workload row names exactly
    // `delegation-expiry`, which names no window.
    const wl = lanes.filter((l) => l.lane === 'workload');
    expect(wl.length).toBeGreaterThan(0);
    for (const l of wl) {
      expect(l.revocation).toBe('delegation-expiry');
      expect(l).not.toHaveProperty('revocationWindowSeconds');
    }
  });

  it('no lane claims `exp-and-recheck` — this host performs no revocation recheck', () => {
    // `oidcVerifier.ts` verifies signature/iat/exp/nbf and nothing else: no
    // introspection, no userinfo, no revocation list. Advertising a recheck
    // window would tell a verifier revocation lands within it, which is false.
    // If a real recheck is ever implemented, this leg is the one to delete.
    expect(lanes.map((l) => l.revocation)).not.toContain('exp-and-recheck');
  });
});
