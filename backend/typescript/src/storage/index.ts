/**
 * Pluggable storage entry point.
 *
 * Default DSN — `sqlite://./data/workflow-engine.db` — opens a sqlite
 * database via better-sqlite3 (synchronous, single file). Production
 * deployers swap this for Postgres / Firestore / DynamoDB by exporting
 * a different `Storage` impl behind the same interface.
 *
 * The `Storage` interface is intentionally narrow — only what the route
 * handlers + executor need. Adding a new storage backend means
 * implementing this interface, not bolting onto sqlite.
 */

import { parse as parsePgConnectionString } from 'pg-connection-string';
import { openSqliteStorage } from './sqlite/index.js';
import { openPostgresStorage } from './postgres/index.js';
import { withEventEra } from './eventEraAdapter.js';
import type { Storage } from './storage.js';

export type { Storage } from './storage.js';

/**
 * Open a Storage backend by DSN. Async because the Postgres backend
 * runs schema migrations during open(); sqlite returns immediately.
 *
 * Supported DSNs:
 *   - `sqlite://<path>`              — local file
 *   - `memory://` or `:memory:`      — in-memory sqlite
 *   - `postgres://...` / `postgresql://...` — Postgres (Cloud SQL)
 */
/**
 * ADR 0551 — is a DSN's storage durable across process restarts?
 *
 * Derived HERE, at DSN parse, because this function is the only place that
 * knows the mapping. Adapter *type* cannot answer it: `memory://` resolves to
 * the SQLite backend at `:memory:` (below), so "it is the sqlite adapter" and
 * "it survives a restart" are different questions. Anything that re-derives
 * this from the adapter instance is re-implementing DSN semantics and will
 * drift.
 *
 * Used by the workspace readiness check — a capability whose contract includes
 * durability must not be advertised on a profile that cannot provide it.
 */
export function storageDurability(dsn: string): 'process' | 'durable' {
  if (dsn === ':memory:' || dsn.startsWith('memory://')) return 'process';
  if (dsn === 'sqlite://:memory:') return 'process';
  return 'durable';
}

/**
 * v2 charter Phase 4 (P4-C) — every Storage this host runs on is wrapped in the
 * era adapter here, at the ONE constructor, so `spec/v2/core/persistence.md`
 * §"The seat" ("not a wrapper some call sites bypass") holds by construction:
 * there is no unwrapped Storage for a call site to reach. The adapter stamps the
 * era on `insertRun`, holds each run's log to its era vocabulary on
 * `appendEvent`/`appendEventsBatch`, and translates on `listEvents`.
 */
/** A DSN with the password replaced. A malformed DSN is an operator error that
 *  gets logged and pasted into issues, so it must never carry the credential —
 *  and the value is malformed precisely when we cannot parse it, so redact
 *  textually rather than via `new URL()`. */
export function redactDsn(dsn: string): string {
  // CORRECTED 2026-09-10 — the password class was `[^@/?#]*`, which cannot match
  // a password CONTAINING one of those characters. That is precisely the
  // password this function is most often called on: the guard below exists to
  // report an unencoded `/`, `@`, `?` or `#`, and for every such DSN the
  // replacement silently did not apply and the cleartext password went into the
  // error message and the logs. Caught by asserting the password is ABSENT from
  // the message, not by asserting the message is present.
  //
  // Greedy to the LAST `@`: a well-formed DSN has exactly one, so this is
  // identical there; a malformed one redacts MORE, which is the safe direction.
  return dsn.replace(/^([a-zA-Z][\w+.-]*:\/\/[^:@]*:)[\s\S]*@/, '$1***@');
}

/** Reject a DSN the DRIVER cannot parse — and nothing else.
 *
 *  CORRECTED 2026-09-10. This validated with `new URL()` on the stated premise
 *  that "`pg` parses a connection string with `new URL()`". **It does not.**
 *  `pg@8` delegates to `pg-connection-string` (a declared dependency), which
 *  implements the libpq grammar — including the Cloud SQL socket form
 *  `postgres://user:pw@/db?host=/cloudsql/...`, whose EMPTY host `new URL()`
 *  rejects but the driver handles correctly.
 *
 *  So the guard rejected a DSN the driver supports, and `openStorage` exits the
 *  process on it. MEASURED: it bricked every Cloud SQL socket deployment of
 *  this host from 2026-09-08 (when it landed) until this fix — two days in
 *  which no revision could start, presenting as `Container called exit(1)`
 *  with a startup-probe timeout. The advice it printed was actively wrong: it
 *  told operators to insert a `localhost` placeholder into a DSN that already
 *  worked.
 *
 *  The lesson is the shape, not the parser: **a guard must validate against the
 *  same mechanism the guarded code uses.** Validating against a stricter proxy
 *  turns every input the proxy alone rejects into a false positive — and a
 *  fail-closed false positive is an outage.
 *
 *  Its real value is kept: `pg-connection-string` DOES throw on an unencoded
 *  reserved character in the password, which is the case this was written for,
 *  and that message still fires. */
function assertParseablePostgresDsn(dsn: string): void {
  try {
    parsePgConnectionString(dsn);
  } catch {
    throw new Error(
      `OPENWOP_STORAGE_DSN is not parseable by the driver: ${redactDsn(dsn)}. ` +
        'Percent-encode any reserved character in the password (a `/`, `@`, `?` or `#` from ' +
        '`openssl rand -base64` will break parsing), or draw the password from an ' +
        'alphanumeric alphabet. Note the libpq socket form ' +
        '(`postgresql://user:pw@/dbname?host=/cloudsql/<instance>`) is SUPPORTED — ' +
        'do not add a `localhost` placeholder to work around this error.',
    );
  }
}

export async function openStorage(dsn: string): Promise<Storage> {
  if (dsn.startsWith('sqlite://')) {
    const path = dsn.slice('sqlite://'.length);
    return withEventEra(openSqliteStorage(path));
  }
  if (dsn === ':memory:' || dsn.startsWith('memory://')) {
    // Re-use the sqlite backend with a memory file. Avoids carrying a
    // second in-memory implementation in the sample.
    return withEventEra(openSqliteStorage(':memory:'));
  }
  if (dsn.startsWith('postgres://') || dsn.startsWith('postgresql://')) {
    assertParseablePostgresDsn(dsn);
    return withEventEra(await openPostgresStorage(dsn));
  }
  throw new Error(
    `Unsupported storage DSN scheme: ${redactDsn(dsn)}. ` +
      'Built-in support: sqlite://<path>, memory://, postgres://<dsn>. ' +
      'See src/storage/README.md to add Firestore / DynamoDB.',
  );
}
