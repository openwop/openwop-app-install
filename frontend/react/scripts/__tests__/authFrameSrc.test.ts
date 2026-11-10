// @vitest-environment node
/**
 * ADR 1021 D9 — the app CSP's `frame-src` must admit the Firebase auth domain
 * exactly and never a Firebase wildcard. `https://*.firebaseapp.com` let a frame
 * navigate to any Firebase project, an attacker's included; it was removed, and
 * this gate keeps it out while making the one deployment it would break (an auth
 * domain on the default `<project>.firebaseapp.com`) fail the build loudly
 * instead of failing sign-in silently. The last case reads the repo's own
 * firebase.json and .env files, so removing the fix or re-adding the wildcard
 * reddens it.
 *
 * Sabotage-checked (w83 probes): the wildcard match, the `.web.app` suffix, the
 * exact-origin rule, the `'self'` rule, the no-domain early return, the `app`
 * target filter and the directive-name strip in `appFrameSrc`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { authFrameSrcFindings, appFrameSrc } from '../authFrameSrc.mjs';

const GOOGLE = "'self' https://apis.google.com https://accounts.google.com";

describe('check-auth-frame-src', () => {
  it('a custom auth domain needs only self', () => {
    expect(authFrameSrcFindings('app.example.com', GOOGLE)).toEqual([]);
    const findings = authFrameSrcFindings('app.example.com', 'https://apis.google.com');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("frame-src needs 'self'");
  });

  it('a default Firebase auth domain needs its exact origin', () => {
    expect(authFrameSrcFindings('acme.firebaseapp.com', GOOGLE)[0]).toContain('https://acme.firebaseapp.com');
    expect(authFrameSrcFindings('acme.firebaseapp.com', `${GOOGLE} https://acme.firebaseapp.com`)).toEqual([]);
    expect(authFrameSrcFindings('acme.web.app', `${GOOGLE} https://acme.web.app`)).toEqual([]);
  });

  it('a Firebase wildcard is refused even where it would make sign-in work', () => {
    const findings = authFrameSrcFindings('acme.firebaseapp.com', `${GOOGLE} https://*.firebaseapp.com`);
    expect(findings.some((f) => f.includes('wildcard https://*.firebaseapp.com'))).toBe(true);
    const webApp = authFrameSrcFindings(undefined, `${GOOGLE} https://*.web.app`);
    expect(webApp).toHaveLength(1);
    expect(webApp[0]).toContain('wildcard https://*.web.app');
  });

  it('no auth domain configured: only the wildcard rule applies', () => {
    expect(authFrameSrcFindings('', GOOGLE)).toEqual([]);
    // Even a frame-src with no 'self': with no auth domain there is no frame to admit.
    expect(authFrameSrcFindings('', 'https://apis.google.com')).toEqual([]);
    expect(authFrameSrcFindings(undefined, 'https://apis.google.com')).toEqual([]);
  });

  it("this repo's firebase.json and production auth domain pass", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const firebaseJson = readFileSync(join(root, '..', '..', 'firebase.json'), 'utf8');
    const frameSrc = appFrameSrc(firebaseJson);
    expect(frameSrc, 'the app-wide CSP rule was not found').not.toBeNull();
    // The source list, read independently of the parser (firebase.json carries one frame-src).
    expect(frameSrc).toBe(/frame-src ([^;"]+)/.exec(firebaseJson)![1]!.trim());
    // Whatever auth domain this checkout's production build uses (an adopter's own,
    // or none) must be admitted; the showcase's is its custom domain, i.e. 'self'.
    const authDomain = loadEnv('production', root, 'VITE_').VITE_FIREBASE_AUTH_DOMAIN;
    expect(authFrameSrcFindings(authDomain, frameSrc!)).toEqual([]);
    expect(frameSrc).not.toContain('firebaseapp.com');
  });
});
