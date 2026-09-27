/**
 * Best-effort run-input validation against a workflow's `inputSchema`
 * (ADR 0197 Phase 3). Host courtesy, NOT a new wire rule: the definition
 * type has always said "real hosts validate via Ajv" (executor/types.ts),
 * and `POST /v1/runs` already 400s malformed `inputs` shapes — this extends
 * that same boundary to schema-bearing workflows.
 *
 * Always-on since ADR 0434: this shipped gated on the `run-input-forms` toggle
 * as an explicit opt-in "until the toggle GAs", and that toggle has now
 * graduated. Fail-open by design for the courtesy itself: no schema, or a
 * schema Ajv can't compile ⇒ the run proceeds exactly as before. Only a
 * schema-bearing workflow + an actually-invalid payload gets the 400.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runInputValidation');

// ADR 0729 D2 — a declared `format` is a contract the AUTHOR asked for, and it was
// enforced nowhere: the client renders a localized "not a valid email" beside the field
// (`lib/formEngine.ts`), and the gate accepted the value anyway. `ajv-formats` was already
// a dependency. MEASURED before flipping this: 25 shipped `inputSchema` objects declare
// ZERO formats, so no shipped workflow changes behaviour; and an UNKNOWN format (a name
// Ajv does not know) is IGNORED under `strict:false`, not thrown — which matters, because
// a throw would hit the fail-open catch below and drop the whole guard for that schema.
//
// The logger is not decoration: Ajv emits its unknown-format notice on every COMPILE, and
// the ADR 0474 published-launch path deserializes a fresh `inputSchema` per request (see
// the RIC-1 note below), so the default console logger would fire once per run-create for
// a tenant schema with a custom format. Routed through the module logger and de-duped by
// schema content, reusing RIC-1's mechanism rather than inventing a second one.
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: true,
  logger: {
    log: () => {},
    warn: (...args: unknown[]) => { warnOnce('ajv_schema_notice', args.map(String).join(' ')); },
    error: (...args: unknown[]) => { warnOnce('ajv_schema_error', args.map(String).join(' ')); },
  },
});
addFormats(ajv);

/** De-dupe an Ajv notice by its text, so a fresh-object launch path cannot turn one
 *  authoring mistake into a per-request log line. Bounded: the set holds distinct
 *  notice strings, which are rare and self-correcting. */
const seenNotices = new Set<string>();
function warnOnce(msg: string, detail: string): void {
  if (seenNotices.has(detail)) return;
  seenNotices.add(detail);
  log.warn(msg, { detail });
}

// Definitions are stable catalog objects — cache compiled validators by
// schema identity so repeated launches don't recompile.
const compiled = new WeakMap<object, ValidateFunction | null>();

// RIC-1 — de-dupe the uncompilable-schema warning by schema CONTENT, not object
// identity. The `compiled` WeakMap only dedupes when the caller hands back a
// stable object (head launches). The ADR 0474 published-launch path deserializes
// a FRESH `inputSchema` object per request (`getRevision` → JSON.parse, no
// cache), so an object-keyed dedupe would warn once PER run-create for a promoted
// workflow with a bad schema. Keying on the serialized content bounds it to once
// per distinct uncompilable schema across every launch path. The set holds only
// uncompilable schemas — a rare, self-correcting authoring mistake — so it stays
// tiny.
const warnedUncompilable = new Set<string>();

export interface RunInputError {
  /** Instance path of the failing value (Ajv shape, e.g. `/count`). */
  path: string;
  message: string;
}

/** Validate `inputs` against `inputSchema`. Returns `null` when valid OR when
 *  validation cannot apply (no/uncompilable schema) — callers only act on a
 *  non-empty error list. */
export function validateRunInputs(
  inputSchema: unknown,
  inputs: Record<string, unknown> | undefined | null,
): RunInputError[] | null {
  if (typeof inputSchema !== 'object' || inputSchema === null) return null;
  let validate = compiled.get(inputSchema);
  if (validate === undefined) {
    try {
      validate = ajv.compile(inputSchema);
    } catch (err) {
      // RIC-1 — the courtesy check still fails OPEN (the run proceeds, as
      // before), but the dropped guard must not be SILENT: a schema-bearing
      // workflow whose schema Ajv cannot compile is otherwise indistinguishable
      // from a schema-less one, so the author (who declared it) and the operator
      // never learn their inputs are unvalidated. Warn so the drop is observable,
      // de-duped by schema CONTENT so it fires at most once per distinct bad
      // schema even on the fresh-object published-launch path (see above).
      let key: string | null = null;
      try { key = JSON.stringify(inputSchema); } catch { key = null; }
      if (key === null || !warnedUncompilable.has(key)) {
        if (key !== null) warnedUncompilable.add(key);
        log.warn('run_input_schema_uncompilable', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      validate = null;
    }
    compiled.set(inputSchema, validate);
  }
  if (!validate) return null;
  if (validate(inputs ?? {})) return null;
  return (validate.errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'invalid',
  }));
}
