/**
 * An Ajv2020 that validates schemas against ONE process-wide compiled copy of
 * the JSON Schema 2020-12 meta-schema (boot-time perf, 2026-10-08).
 *
 * Why: a pack loader that needs `$id` isolation creates a fresh Ajv2020 per
 * pack load, and every fresh instance compiles the 2020-12 meta-schema the
 * first time it validates a schema (~10 ms each). MEASURED 2026-10-08 at load ~7:
 * `createApp` median 589 → 442 ms with this class (Ajv inclusive 505 → 335 ms).
 * An earlier "~1.3 s of 2.0 s" reading was taken on a machine at load 23 and was
 * inflated (ADR 0863 D2 correction). The meta-schema is the same document for
 * every instance, so compiling it once is semantically free.
 *
 * What is shared, and what is NOT:
 *   - SHARED: only the meta-schema validators (the `validateSchema` step).
 *     They are pure functions of the meta-schema and never see a user `$id`.
 *   - NOT shared: every user schema still compiles on the caller's own
 *     instance, so `$id` registration stays per-instance and a `$id` reused
 *     across two packs never collides.
 *
 * Semantics are unchanged: `compile`/`addSchema` still call `validateSchema`
 * before compiling, an invalid schema still throws
 * `schema is invalid: <errorsText>` with the same text (the shared instance uses
 * the same options), and `ajv.errors` is set as before. A schema declaring a
 * `$schema` OTHER than 2020-12 falls back to the instance's own meta-schema
 * lookup, exactly the pre-change path.
 *
 * Usage rule: construct it with `strict: false` and no added formats/keywords.
 * The shared meta step honours only `allErrors` (one shared instance per value);
 * a caller that adds formats or runs strict could get different meta-validation
 * output from a plain instance, so such callers should keep a plain Ajv2020.
 */

import Ajv2020 from 'ajv/dist/2020.js';

const META_SCHEMA_ID = 'https://json-schema.org/draft/2020-12/schema';

const sharedMeta = new Map<boolean, Ajv2020>();

function metaValidatorFor(allErrors: boolean): Ajv2020 {
  let ajv = sharedMeta.get(allErrors);
  if (!ajv) {
    ajv = new Ajv2020({ allErrors, strict: false });
    sharedMeta.set(allErrors, ajv);
  }
  return ajv;
}

export class SharedMetaAjv2020 extends Ajv2020 {
  override validateSchema(schema: unknown, throwOrLogError?: boolean): boolean | Promise<unknown> {
    if (typeof schema === 'boolean') return true;
    const declared = (schema as { $schema?: unknown } | null)?.$schema;
    if (declared !== undefined && declared !== META_SCHEMA_ID) {
      // Non-2020-12 (or malformed) `$schema`: the original lookup, with its own errors.
      return super.validateSchema(schema as object, throwOrLogError);
    }
    const meta = metaValidatorFor(this.opts.allErrors === true);
    const valid = meta.validateSchema(schema as object, false) as boolean;
    this.errors = meta.errors ?? null;
    if (!valid && throwOrLogError) {
      const message = 'schema is invalid: ' + this.errorsText();
      if (this.opts.validateSchema === 'log') this.logger.error(message);
      else throw new Error(message);
    }
    return valid;
  }
}

/** Test seam: how many shared meta instances exist (one per `allErrors` value). */
export function sharedMetaInstanceCount(): number {
  return sharedMeta.size;
}
