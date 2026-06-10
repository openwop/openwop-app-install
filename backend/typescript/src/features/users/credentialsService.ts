/**
 * Password credentials store — the email/password baseline (ADR 0002, Phase 2).
 *
 * A `Credential` is the secret half of a local (non-SSO) account: a scrypt
 * password hash plus single-use, hashed-at-rest reset / email-verification
 * tokens. It is keyed to a durable `User` (usersService) by `userId`; the User
 * is the public identity, the Credential is the secret material.
 *
 * SECRET HANDLING (ADR 0002 finding C3, threat-model-secret-leakage):
 *  - passwords are NEVER stored or logged in cleartext — only a scrypt hash
 *    (`scrypt$<salt>$<derived>`), verified in constant time (timingSafeEqual);
 *  - reset / verification tokens are returned to the caller ONCE and stored only
 *    as a sha256 hash with an expiry, so a store leak can't replay them;
 *  - login failures are generic (no user-enumeration: unknown email and wrong
 *    password are indistinguishable to the caller).
 *
 * FAIL-CLOSED (finding H5): authentication composes with the User lifecycle —
 * a disabled User cannot log in even with the correct password (enforced at the
 * route, via usersService.isActiveUser / status).
 *
 * Zero new deps — node:crypto scrypt only (matches the app's zero-runtime-dep
 * posture; no bcrypt/argon import).
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createUser, getUserByPrincipal, type User } from './usersService.js';

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEYLEN = 64;
const RESET_TTL_MS = 60 * 60 * 1000; // 1h
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MIN_PASSWORD_LEN = 8;

export interface Credential {
  userId: string;
  tenantId: string;
  /** Login identifier, lowercased. Unique within a tenant. */
  email: string;
  passwordHash: string;
  emailVerified: boolean;
  resetTokenHash?: string;
  resetExpiresAt?: string;
  verifyTokenHash?: string;
  verifyExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

const store = new DurableCollection<Credential>('users:credential', (c) => c.userId);

/** Raised for caller-facing credential failures. The route layer maps `.code`
 *  to the canonical envelope (401 unauthenticated / 400 validation / 409). */
export class CredentialError extends Error {
  constructor(
    public readonly code: 'invalid_credentials' | 'weak_password' | 'email_taken' | 'invalid_token',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  // ALWAYS derive a full KEYLEN key so the cost does not depend on the stored
  // hash's shape (review finding #3): the unknown-email path uses a dummy hash,
  // and if the derivation length tracked the dummy's length the dummy would be
  // cheaper than a real 64-byte verify, leaking account existence via timing.
  const salt = saltHex && /^[0-9a-fA-F]+$/.test(saltHex) ? Buffer.from(saltHex, 'hex') : Buffer.alloc(16);
  const derived = await scrypt(password, salt, KEYLEN);
  if (scheme !== 'scrypt' || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === KEYLEN && timingSafeEqual(derived, expected);
}

/** A well-formed dummy hash (16-byte salt + 64-byte digest, both zero) for the
 *  unknown-email login path: it runs the SAME full-length scrypt as a real
 *  account and never matches a real password (review finding #3). */
const DUMMY_PASSWORD_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(KEYLEN * 2)}`;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

async function getCredentialByEmail(tenantId: string, email: string): Promise<Credential | null> {
  const all = await store.list();
  const norm = normalizeEmail(email);
  return all.find((c) => c.tenantId === tenantId && c.email === norm) ?? null;
}

function assertStrongPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    throw new CredentialError('weak_password', `Password MUST be at least ${MIN_PASSWORD_LEN} characters.`);
  }
}

/**
 * Sign up a local account: create (or reuse) the durable User and attach a
 * password Credential. Returns the User plus a one-time email-verification token
 * (surface it to the caller exactly once — a real host emails a link).
 */
export async function signup(input: {
  tenantId: string;
  email: string;
  password: string;
  displayName?: string;
}): Promise<{ user: User; verifyToken: string }> {
  assertStrongPassword(input.password);
  const email = normalizeEmail(input.email);
  if (await getCredentialByEmail(input.tenantId, email)) {
    throw new CredentialError('email_taken', 'An account with that email already exists.');
  }
  const principalId = `password:${email}`;
  const user = await createUser({
    tenantId: input.tenantId,
    principalId,
    email,
    source: 'password',
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
  const verifyToken = newToken();
  const now = new Date().toISOString();
  const cred: Credential = {
    userId: user.userId,
    tenantId: input.tenantId,
    email,
    passwordHash: await hashPassword(input.password),
    emailVerified: false,
    verifyTokenHash: hashToken(verifyToken),
    verifyExpiresAt: new Date(Date.now() + VERIFY_TTL_MS).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
  await store.put(cred);
  return { user, verifyToken };
}

/**
 * Verify an email + password. Returns the authenticated User on success and
 * throws `invalid_credentials` on ANY failure (unknown email or wrong password —
 * no enumeration). The caller MUST additionally enforce the User lifecycle
 * (disabled => deny, finding H5) — this checks the secret only.
 */
export async function login(input: { tenantId: string; email: string; password: string }): Promise<User> {
  const cred = await getCredentialByEmail(input.tenantId, input.email);
  // Always run a hash comparison to keep timing uniform whether or not the
  // account exists (reduces the user-enumeration side channel).
  const stored = cred?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const ok = await verifyPassword(input.password, stored);
  if (!cred || !ok) {
    throw new CredentialError('invalid_credentials', 'Invalid email or password.');
  }
  const user = await getUserByPrincipal(input.tenantId, `password:${cred.email}`);
  if (!user) {
    // Credential without a user is a corrupt state — fail closed.
    throw new CredentialError('invalid_credentials', 'Invalid email or password.');
  }
  return user;
}

/** Mint a single-use password-reset token (always succeeds silently for an
 *  unknown email — no enumeration; returns null token in that case). */
export async function requestPasswordReset(input: { tenantId: string; email: string }): Promise<{ token: string | null }> {
  const cred = await getCredentialByEmail(input.tenantId, input.email);
  if (!cred) return { token: null };
  const token = newToken();
  cred.resetTokenHash = hashToken(token);
  cred.resetExpiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
  cred.updatedAt = new Date().toISOString();
  await store.put(cred);
  return { token };
}

/** Consume a reset token + set a new password. Throws `invalid_token` if the
 *  token is wrong / expired / already used. */
export async function resetPassword(input: {
  tenantId: string;
  email: string;
  token: string;
  newPassword: string;
}): Promise<void> {
  assertStrongPassword(input.newPassword);
  const cred = await getCredentialByEmail(input.tenantId, input.email);
  if (
    !cred ||
    !cred.resetTokenHash ||
    !cred.resetExpiresAt ||
    cred.resetTokenHash !== hashToken(input.token) ||
    Date.parse(cred.resetExpiresAt) < Date.now()
  ) {
    throw new CredentialError('invalid_token', 'The reset token is invalid or expired.');
  }
  cred.passwordHash = await hashPassword(input.newPassword);
  delete cred.resetTokenHash;
  delete cred.resetExpiresAt;
  cred.updatedAt = new Date().toISOString();
  await store.put(cred);
}

/** Re-mint an email-verification token (no enumeration). */
export async function requestEmailVerification(input: { tenantId: string; email: string }): Promise<{ token: string | null }> {
  const cred = await getCredentialByEmail(input.tenantId, input.email);
  if (!cred || cred.emailVerified) return { token: null };
  const token = newToken();
  cred.verifyTokenHash = hashToken(token);
  cred.verifyExpiresAt = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
  cred.updatedAt = new Date().toISOString();
  await store.put(cred);
  return { token };
}

/** Consume a verification token, marking the email verified. */
export async function verifyEmail(input: { tenantId: string; email: string; token: string }): Promise<void> {
  const cred = await getCredentialByEmail(input.tenantId, input.email);
  if (
    !cred ||
    !cred.verifyTokenHash ||
    !cred.verifyExpiresAt ||
    cred.verifyTokenHash !== hashToken(input.token) ||
    Date.parse(cred.verifyExpiresAt) < Date.now()
  ) {
    throw new CredentialError('invalid_token', 'The verification token is invalid or expired.');
  }
  cred.emailVerified = true;
  delete cred.verifyTokenHash;
  delete cred.verifyExpiresAt;
  cred.updatedAt = new Date().toISOString();
  await store.put(cred);
}

export async function isEmailVerified(tenantId: string, email: string): Promise<boolean> {
  return (await getCredentialByEmail(tenantId, email))?.emailVerified ?? false;
}

/** Test-only: clear all credentials. */
export async function __resetCredentialsStore(): Promise<void> {
  await store.__clear();
}
