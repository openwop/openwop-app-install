import { describe, it, expect } from 'vitest';
import { openStorage } from '../src/storage/index.js';

/**
 * The DSN guard must reject exactly what the DRIVER rejects — no more.
 *
 * WHY THIS EXISTS. A guard added on 2026-09-08 validated `OPENWOP_STORAGE_DSN`
 * with `new URL()`, on the stated premise that "`pg` parses a connection string
 * with `new URL()`". It does not — `pg@8` delegates to `pg-connection-string`,
 * which implements the libpq grammar. `new URL()` is STRICTER, so the guard
 * rejected the Cloud SQL socket form the driver handles fine, and `openStorage`
 * exits the process on it.
 *
 * MEASURED: every Cloud SQL socket deployment of this host was un-startable for
 * two days. It presented as `Container called exit(1)` behind a startup-probe
 * timeout, and the error it printed told operators to "insert a `localhost`
 * placeholder" into a DSN that was already correct.
 *
 * Nothing caught it because every test used either sqlite or a testcontainer
 * TCP DSN — the socket form, which is what PRODUCTION uses, appeared in no
 * test at all. That is the gap this file closes.
 */
describe('OPENWOP_STORAGE_DSN guard', () => {
  /** The exact shape every Cloud SQL guide shows, and the one production uses.
   *  `new URL()` throws on its empty host; the driver does not. */
  const CLOUD_SQL_SOCKET =
    'postgresql://openwop_app:s3cret@/openwop?host=/cloudsql/proj:us-central1:inst';

  it('ACCEPTS the libpq socket form (empty host) — it must reach the driver', async () => {
    // Connecting WILL fail here (no such socket on this machine). That is fine:
    // what matters is WHICH failure. If the guard rejects it, the message is the
    // guard's own. If the guard lets it through, the message comes from the
    // driver trying to connect. Asserting on that distinction is the whole test.
    //
    // Written flat and asserted once: an earlier version wrapped this in
    // `.rejects.toThrow(...).catch(...)`, which swallowed the assertion and
    // passed even with the bug reinstated. Sabotage caught that, review did not.
    const err: unknown = await openStorage(CLOUD_SQL_SOCKET).then(
      () => null,
      (e: unknown) => e,
    );
    const msg = String((err as Error)?.message ?? err ?? '');
    expect(msg).not.toMatch(/not parseable by the driver/);
    expect(msg).not.toMatch(/not a parseable URL/);
  });

  it('REJECTS a DSN the driver genuinely cannot parse, and redacts the password', async () => {
    // An unencoded `/` in the password — the case the guard was written for.
    const err = await openStorage('postgresql://u:pw/x@host:5432/db').catch((e: unknown) => e);
    const msg = String((err as Error)?.message ?? err);
    expect(msg).toMatch(/not parseable by the driver/);
    expect(msg).toMatch(/Percent-encode/);
    expect(msg).not.toMatch(/pw\/x/); // the password never reaches the message
  });

  it('does NOT advise inserting a localhost placeholder — that advice broke a working DSN', async () => {
    const err = await openStorage('postgresql://u:pw/x@host:5432/db').catch((e: unknown) => e);
    const msg = String((err as Error)?.message ?? err);
    // The message may MENTION localhost (to warn against it); it must never
    // instruct the operator to insert one, which is what corrupted a correct
    // Cloud SQL DSN for two days.
    expect(msg).not.toMatch(/Insert a .?localhost.? placeholder/i);
    expect(msg).toMatch(/socket form[\s\S]*SUPPORTED/i);
  });
});
