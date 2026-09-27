/**
 * `canvas.app-builder` schema-version migration (ADR 0343). Run artifacts are
 * immutable; migration applies ONLY when a WORKING COPY opens — the stored copy
 * catches up on its next save, and `:fork` copies recorded state verbatim.
 *
 * v1 is the only version: every pre-0343 document (no `schemaVersion` field) is
 * v1 by definition, and every 0343 facet is additive + optional, so v1→v1 is the
 * identity. The table exists so the FIRST real (shape-changing) migration slots
 * in as `2: (state) => …` with its own fixture — and so callers already have the
 * one named entry point instead of ad-hoc patching. Deliberately NOT wired into
 * the shared canvas-editor factory yet: a hook with only identity behavior is a
 * consumer-less surface (the ADR 0307 rule); wiring lands with migration #2.
 */

export const APP_DOC_SCHEMA_VERSION = 1;

type AppDocState = Record<string, unknown>;

/** version N entry migrates a version-(N-1) document TO version N. */
const MIGRATIONS: Record<number, (state: AppDocState) => AppDocState> = {
  // 2: (state) => ({ ...state, …reshape… }),   ← the first real migration lands here
};

/** The document's effective schema version (absent = v1 by definition). */
export function appDocVersion(state: AppDocState): number {
  const v = state.schemaVersion;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1;
}

export interface MigrationResult {
  state: AppDocState;
  /** true when any migration step ran (the caller should persist on next save). */
  migrated: boolean;
}

/** Migrate a working-copy document to APP_DOC_SCHEMA_VERSION. Pure — never
 *  mutates the input; a document at (or above) the current version passes
 *  through untouched. A FUTURE version is left alone (fail-open read: a newer
 *  writer's document must not be truncated by an older reader). */
export function migrateAppDoc(state: AppDocState): MigrationResult {
  let version = appDocVersion(state);
  if (version >= APP_DOC_SCHEMA_VERSION) return { state, migrated: false };
  let out = state;
  while (version < APP_DOC_SCHEMA_VERSION) {
    const step = MIGRATIONS[version + 1];
    if (!step) break; // no registered path — leave the document as-is (validators still gate it)
    out = { ...step(structuredClone(out)), schemaVersion: version + 1 };
    version += 1;
  }
  return out === state ? { state, migrated: false } : { state: out, migrated: true };
}
