/**
 * Adopter first-deploy diagnostics.
 *
 * Both behaviours here were measured on a real white-label Cloud Run bring-up,
 * where each cost significant time precisely because the failure did not name
 * its own cause. The assertions are about the DIAGNOSTIC, not the mechanism:
 * they fail if a future change makes these errors generic again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStorage, redactDsn } from '../src/storage/index.js';
import { readSecretEnv, resetSecretEnvWarnings } from '../src/host/secretEnv.js';

describe('storage DSN diagnostics', () => {
  const SOCKET_FORM = 'postgresql://kicktodo:pw@/kicktodo?host=/cloudsql/p:us-central1:i';

  // CORRECTED 2026-09-10. This test used to demand that the libpq socket form be
  // REJECTED with "EMPTY host" + "insert a localhost placeholder". That pinned the
  // defect: the driver (`pg-connection-string`) parses the socket form fine, and
  // the guard's `new URL()` was stricter than the driver, so every Cloud SQL
  // deployment of this host was un-startable for two days while this test was
  // green. The guard now validates with the driver's own parser; the socket form
  // MUST reach the driver, and the advice that corrupted a working DSN is gone.
  it('ACCEPTS the libpq socket form — it is the driver\'s job to connect, not the guard\'s to refuse', async () => {
    const err: unknown = await openStorage(SOCKET_FORM).then(() => null, (e: unknown) => e);
    const msg = String((err as Error)?.message ?? err ?? '');
    expect(msg).not.toMatch(/not parseable by the driver|not a parseable URL/);
    expect(msg).not.toMatch(/Insert a .?localhost.? placeholder/i);
  });

  it('never puts the password in the error', async () => {
    // A DSN the driver genuinely rejects (unencoded `/` in the password) — the
    // socket form no longer produces a guard error at all, so the redaction has
    // to be witnessed on a message the guard actually emits. The password here
    // CONTAINS a reserved character on purpose: the old redaction class
    // `[^@/?#]*` could not match such a password, so the cleartext leaked into
    // the very message written to report it.
    const withSecret = 'postgresql://user:hunter2/SuperSecret@localhost:5432/db';
    await expect(openStorage(withSecret)).rejects.toThrow(/\*\*\*/);
    await expect(openStorage(withSecret)).rejects.not.toThrow(/hunter2/);
  });

  it('points at percent-encoding when the password itself breaks parsing', async () => {
    // A `/` from `openssl rand -base64` inside the userinfo — a HOST is present,
    // so the empty-host branch must not claim it.
    await expect(openStorage('postgresql://u:a/b@localhost/db')).rejects.toThrow(/Percent-encode/);
  });

  it('redacts the password but keeps the DSN legible', () => {
    expect(redactDsn('postgresql://u:secret@localhost/db?host=/x')).toBe(
      'postgresql://u:***@localhost/db?host=/x',
    );
    expect(redactDsn('sqlite://./data/x.db')).toBe('sqlite://./data/x.db');
  });

  it('does not reject a DSN that parses', async () => {
    // Reaches the driver rather than the guard: any throw here is a connection
    // failure, never the URL diagnostic.
    await expect(
      openStorage('postgresql://u:p@localhost:1/db?host=/cloudsql/p:r:i'),
    ).rejects.not.toThrow(/not a parseable URL/);
  });
});

describe('secret env whitespace', () => {
  const VAR = 'OPENWOP_TEST_SECRET_ENV';
  beforeEach(() => { resetSecretEnvWarnings(); delete process.env[VAR]; });
  afterEach(() => { delete process.env[VAR]; });

  it('strips the trailing newline that `openssl … | gcloud secrets create` stores', () => {
    process.env[VAR] = 'a'.repeat(64) + '\n';
    expect(readSecretEnv(VAR)).toBe('a'.repeat(64));
  });

  it('leaves a clean value byte-identical', () => {
    process.env[VAR] = 'a'.repeat(64);
    expect(readSecretEnv(VAR)).toBe('a'.repeat(64));
  });

  it('returns undefined when unset rather than an empty string', () => {
    expect(readSecretEnv(VAR)).toBeUndefined();
  });

  it('makes a newline-suffixed token compare EQUAL to the clean one', () => {
    // The regression this exists for: raw reads differ by one byte, the admin
    // route's length check fails, and every request 401s with no explanation.
    const clean = 'b'.repeat(64);
    process.env[VAR] = `${clean}\n`;
    expect(process.env[VAR]).not.toBe(clean);
    expect(readSecretEnv(VAR)).toBe(clean);
  });
});
