/**
 * The TOTP enrollment Key URI: issued under the BRAND, and percent-encoded.
 *
 * Issuer: the label an authenticator app files the account under. A white-label
 * deployment that said "OpenWOP" there left people unable to tell which entry
 * was theirs, or a real sign-in page from a look-alike.
 *
 * Encoding: Firebase's `TotpSecret.generateQrCodeUrl` concatenates the issuer
 * and account raw. A plus-addressed account (`owner+tag@…`), which any adopter's
 * users can have, read back as a space, and a brand containing `&`, `:` or `#`
 * split the query or the label. Every case parses the URI with `new URL()` and
 * asserts what an authenticator would recover, never the encoded form.
 *
 * Sabotage-witnessed (2026-10-23), each turns a case red: reverting the issuer
 * to the literal 'OpenWOP'; going back to `generateQrCodeUrl`; dropping
 * `encodeURIComponent` from the label or the issuer parameter; and form-encoding
 * (spaces as `+`).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const SECRET = {
  secretKey: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  hashingAlgorithm: 'SHA1',
  codeLength: 6,
  codeIntervalSeconds: 30,
};

vi.mock('../../brand/brand.js', () => ({ brand: { productName: 'Acme & Co: Habits' } }));
vi.mock('@firebase/app', () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock('@firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: { uid: 'u1', email: 'owner+tag@example.com' } })),
  onIdTokenChanged: vi.fn(),
  multiFactor: vi.fn(() => ({ getSession: vi.fn(async () => ({})) })),
  TotpMultiFactorGenerator: {
    generateSecret: vi.fn(async () => ({
      ...SECRET,
      // The SDK's raw builder: present so a regression back to it is caught.
      generateQrCodeUrl: (account: string, issuer: string) => `otpauth://totp/${issuer}:${account}?secret=${SECRET.secretKey}&issuer=${issuer}`,
    })),
  },
}));

/** What an authenticator app recovers from the URI. */
function parse(uri: string): { type: string; issuer: string; account: string; params: URLSearchParams } {
  const url = new URL(uri);
  expect(url.protocol).toBe('otpauth:');
  // Split the label on its ONE literal ':' before decoding: an issuer's own ':'
  // must arrive encoded, or the split lands in the wrong place.
  const label = url.pathname.replace(/^\//, '');
  const parts = label.split(':');
  expect(parts).toHaveLength(2);
  // The Key URI Format is PERCENT-encoded. `URLSearchParams` form-decodes ('+'
  // reads as a space), which would hide a form-encoded issuer, so the issuer
  // parameter is decoded the strict way an authenticator does.
  const rawIssuer = /[?&]issuer=([^&]*)/.exec(url.search)?.[1];
  expect(rawIssuer, 'issuer parameter present').toBeDefined();
  const params = new URLSearchParams(url.search);
  params.set('issuer', decodeURIComponent(rawIssuer!));
  return { type: url.host, issuer: decodeURIComponent(parts[0]!), account: decodeURIComponent(parts[1]!), params };
}

beforeEach(() => {
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-key');
  vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'example.firebaseapp.com');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'example');
  vi.stubEnv('VITE_FIREBASE_APP_ID', 'app');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('startTotpEnrollment Key URI', () => {
  it('files the account under the brand product name, recovered exactly, with the issuer param equal to the label prefix', async () => {
    const { startTotpEnrollment } = await import('../firebase.js');
    const { otpauthUrl, secretKey } = await startTotpEnrollment();
    const got = parse(otpauthUrl);
    expect(got.type).toBe('totp');
    expect(got.issuer).toBe('Acme & Co: Habits');
    expect(got.issuer).not.toContain('OpenWOP');
    expect(got.params.get('issuer')).toBe(got.issuer);
    // A plus-addressed account survives (a raw '+' would read back as a space).
    expect(got.account).toBe('owner+tag@example.com');
    // The secret passes through byte for byte, and matches the manual key shown.
    expect(got.params.get('secret')).toBe(SECRET.secretKey);
    expect(secretKey).toBe(SECRET.secretKey);
  });
});

describe('buildOtpauthUrl', () => {
  it.each([
    ['plain', 'KickTodo', 'owner@example.com'],
    ['space and ampersand', 'Acme & Co', 'a b@example.com'],
    ['colon and hash', 'Ops: #1', 'ops#1@example.com'],
    ['plus and percent', 'Q+A 100%', 'q+a%x@example.com'],
    ['non-ASCII', 'Équipe Ünïcode', 'zoë@example.com'],
  ])('%s: issuer, account and secret round-trip exactly', async (_label, issuer, account) => {
    const { buildOtpauthUrl } = await import('../firebase.js');
    const got = parse(buildOtpauthUrl(SECRET, account, issuer));
    expect(got.issuer).toBe(issuer);
    expect(got.params.get('issuer')).toBe(issuer);
    expect(got.account).toBe(account);
    expect(got.params.get('secret')).toBe(SECRET.secretKey);
  });

  it('carries the SDK secret parameters, so an authenticator never falls back to guessed defaults', async () => {
    const { buildOtpauthUrl } = await import('../firebase.js');
    const got = parse(buildOtpauthUrl({ ...SECRET, hashingAlgorithm: 'SHA256', codeLength: 8, codeIntervalSeconds: 60 }, 'a@b.co', 'X'));
    expect(got.params.get('algorithm')).toBe('SHA256');
    expect(got.params.get('digits')).toBe('8');
    expect(got.params.get('period')).toBe('60');
  });
});
