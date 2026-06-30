/**
 * App-tier migration runner (ADR 0052 §D5).
 *
 * The DB schema runner (`storage/{sqlite,postgres}/schema.ts`) owns DDL keyed by
 * `LATEST_SCHEMA_VERSION`. THIS runner owns **non-schema, app-level** one-shots —
 * re-seeding a pack, moving a config key, rewriting stored blobs, backfilling
 * from an external source — expressed over the `Storage` API rather than raw
 * DDL. It runs on boot AFTER the schema migrations, in order, exactly once,
 * keyed by its own monotonic counter in `__app_meta.app_migration_version`.
 *
 * Discipline (mirrors the schema runner):
 *  - **Forward-only** — append entries; never renumber or mutate a shipped one.
 *  - **Skip-intermediate** — apply every entry above the recorded counter.
 *  - **Idempotent** — a re-run MUST be a no-op. This is what lets the runner be
 *    safe on a fresh install (nothing to backfill → each entry no-ops) AND on an
 *    install that predates app-version tracking (counter defaults to 0 → the gap
 *    replays correctly), without needing to distinguish the two.
 *  - **Concurrency-safe** — there is NO advisory lock (matching the DB schema
 *    runner, which relies on `IF NOT EXISTS` DDL). On a multi-instance rolling
 *    deploy several instances boot at once and EACH calls this, so an entry's
 *    `run` MUST tolerate concurrent execution (e.g. upsert / `ON CONFLICT`, not a
 *    naive read-then-insert) — idempotent-under-serial is not enough. A migration
 *    that cannot be made concurrency-safe MUST ship in a release flagged a
 *    required stop (ADR 0052 §D2) so it runs against a single drained instance.
 */

import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { backfillProfileReadPermissions } from './agentProfileService.js';
import { builtinToolNamespaces } from './agentToolProvider.js';

const log = createLogger('host.appMigrations');

export const APP_MIGRATION_KEY = 'app_migration_version';

/** A single app-tier migration. `version` is its position in the monotonic
 *  sequence; `run` MUST be idempotent. */
export interface AppMigration {
  version: number;
  name: string;
  run(storage: Storage): Promise<void>;
}

/** The ordered app-migration set. Append-only — the first real entry lands with
 *  the feature that needs a non-schema backfill. Empty is valid (no-op runner). */
export const APP_MIGRATIONS: readonly AppMigration[] = [
  {
    // ADR 0102 — backfill existing agent profiles so the per-tool permission
    // gate permits the host's builtin tools (web research / knowledge / fetch /
    // compute). Without this, a profile whose `permissions.read/write` only lists
    // illustrative domain ids would have ALL builtin tool calls blocked once
    // `OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED` is flipped on. Idempotent set-union
    // on `permissions.read`; profiles with no `permissions` block stay ungated.
    version: 1,
    name: 'backfill-builtin-tool-permissions',
    async run(): Promise<void> {
      const updated = await backfillProfileReadPermissions(builtinToolNamespaces());
      log.info('app_migration_backfill_tool_permissions', { profilesUpdated: updated });
    },
  },
];

/** Highest version present in `migrations` (0 when empty). */
export function latestAppMigration(migrations: readonly AppMigration[] = APP_MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

/**
 * Apply every migration above the recorded counter, in ascending order, then
 * record the new counter. `migrations` is injectable for tests; production uses
 * the module-level `APP_MIGRATIONS`. Forward-only + idempotent (see header), so
 * calling it on every boot is safe.
 */
export async function runAppMigrations(
  storage: Storage,
  migrations: readonly AppMigration[] = APP_MIGRATIONS,
): Promise<{ applied: number[] }> {
  const recorded = Number((await storage.getAppMeta(APP_MIGRATION_KEY)) ?? '0');
  const pending = migrations
    .filter((m) => m.version > recorded)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return { applied: [] };
  for (const m of pending) {
    log.info('app_migration_apply', { version: m.version, name: m.name });
    await m.run(storage);
  }
  await storage.setAppMeta(APP_MIGRATION_KEY, String(latestAppMigration(migrations)));
  return { applied: pending.map((m) => m.version) };
}
