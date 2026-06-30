/**
 * App-version recording (ADR 0052 §D4).
 *
 * On boot — after the DB schema migrations have run — record the running app
 * version in `__app_meta`, detect a fresh install vs. an upgrade-from-prior, and
 * run any pending app-tier migrations (§D5) before stamping the new version.
 *
 * The recorded `app_version` is what distinguishes a fresh install (no row) from
 * an upgrade (an older row), and is the anchor an operator/log uses to answer
 * "which version did this instance come from."
 */

import type { Storage } from '../storage/storage.js';
import { APP_VERSION } from '../version.js';
import { createLogger } from '../observability/logger.js';
import { runAppMigrations } from './appMigrations.js';

const log = createLogger('host.appVersion');

export const APP_VERSION_KEY = 'app_version';

export interface AppVersionTransition {
  /** `first-record`: no prior version (a fresh store, or one predating version
   *  tracking). `upgrade`: a different prior version. `same`: unchanged. */
  kind: 'first-record' | 'upgrade' | 'same';
  from: string | null;
  to: string;
}

/**
 * Record `APP_VERSION`, run pending app-migrations, and return the transition.
 * Idempotent: a same-version boot runs the (idempotent) app-migrations and
 * re-stamps nothing new.
 */
export async function recordAppVersion(storage: Storage): Promise<AppVersionTransition> {
  const prior = await storage.getAppMeta(APP_VERSION_KEY);
  let kind: AppVersionTransition['kind'];
  if (prior === null) {
    kind = 'first-record';
    log.info('app_version_first_record', { version: APP_VERSION });
  } else if (prior !== APP_VERSION) {
    kind = 'upgrade';
    log.info('app_upgrade', { from: prior, to: APP_VERSION });
  } else {
    kind = 'same';
  }

  // §D5 — apply any pending app-tier migrations BEFORE stamping the new version,
  // so a crash mid-upgrade re-runs them next boot (the version isn't advanced
  // until migrations succeed).
  await runAppMigrations(storage);

  if (kind !== 'same') await storage.setAppMeta(APP_VERSION_KEY, APP_VERSION);
  return { kind, from: prior, to: APP_VERSION };
}
