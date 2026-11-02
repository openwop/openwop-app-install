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
    expect(authFrameSrcFindings('app.example.com', 'https://apis.google.com')).toHaveLength(1);
  });

  it('a default Firebase auth domain needs its exact origin', () => {
    expect(authFrameSrcFindings('acme.firebaseapp.com', GOOGLE)[0]).toContain('https://acme.firebaseapp.com');
    expect(authFrameSrcFindings('acme.firebaseapp.com', `${GOOGLE} https://acme.firebaseapp.com`)).toEqual([]);
    expect(authFrameSrcFindings('acme.web.app', `${GOOGLE} https://acme.web.app`)).toEqual([]);
  });

  it('a Firebase wildcard is refused even where it would make sign-in work', () => {
    const findings = authFrameSrcFindings('acme.firebaseapp.com', `${GOOGLE} https://*.firebaseapp.com`);
    expect(findings.some((f) => f.includes('wildcard https://*.firebaseapp.com'))).toBe(true);
    expect(authFrameSrcFindings(undefined, `${GOOGLE} https://*.web.app`)).toHaveLength(1);
  });

  it('no auth domain configured: only the wildcard rule applies', () => {
    expect(authFrameSrcFindings('', GOOGLE)).toEqual([]);
  });

  it("this repo's firebase.json and production auth domain pass", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const frameSrc = appFrameSrc(readFileSync(join(root, '..', '..', 'firebase.json'), 'utf8'));
    expect(frameSrc, 'the app-wide CSP rule was not found').not.toBeNull();
    // Whatever auth domain this checkout's production build uses (an adopter's own,
    // or none) must be admitted; the showcase's is its custom domain, i.e. 'self'.
    const authDomain = loadEnv('production', root, 'VITE_').VITE_FIREBASE_AUTH_DOMAIN;
    expect(authFrameSrcFindings(authDomain, frameSrc!)).toEqual([]);
    expect(frameSrc).not.toContain('firebaseapp.com');
  });
});
