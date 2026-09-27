/**
 * `spec/v2/core/runs.md` §`configurable` (RFC 0171 §D.1) — under major 2
 * `RunOptions.configurable` is a CLOSED, nested, versioned object.
 *
 * v1's `configurable` is an open bag: any key, any depth, and the dotted
 * `ai.provider` spelling is legal because nothing closes the object. v2 replaced
 * that with a typed schema whose root and every section are
 * `additionalProperties: false`, `version` is REQUIRED (`const 1`), and a vendor
 * key lives under `extensions.<org>` rather than as a dotted string key. So the
 * same body that a v1 caller may send is a `400 validation_error` under major 2.
 *
 * This validator is major-2 ONLY. The v1 create path is untouched: it keeps the
 * per-workflow `configurableSchema` check and nothing else, exactly as before.
 *
 * The schema is READ from the vendored corpus (`schemas/v2/`), never re-typed —
 * a hand-written copy of a closed schema is the drift class `check:schemas`
 * exists to catch.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { locateRepoSchemasDir } from './_repoPath.js';

let compiled: ValidateFunction | null | undefined;

/**
 * The compiled validator, or `null` when the vendored v2 corpus is not on disk
 * (a deploy that carries only the runtime bundle). Silence is the honest answer
 * there: a host that cannot read the closed schema does not get to claim it
 * enforces it, and the v1 behaviour is what remains.
 */
function validator(): ValidateFunction | null {
  if (compiled !== undefined) return compiled;
  try {
    const dir = join(
      locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'),
      'v2',
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    // `configurable.schema.json` $refs `budget-policy.schema.json` by relative
    // filename, so the referenced artifact is registered under BOTH its `$id`
    // and the relative name the $ref uses.
    const budget = JSON.parse(readFileSync(join(dir, 'budget-policy.schema.json'), 'utf8')) as Record<string, unknown>;
    ajv.addSchema(budget);
    ajv.addSchema(budget, 'budget-policy.schema.json');
    compiled = ajv.compile(
      JSON.parse(readFileSync(join(dir, 'configurable.schema.json'), 'utf8')) as Record<string, unknown>,
    );
  } catch {
    compiled = null;
  }
  return compiled;
}

/**
 * `null` when `configurable` satisfies the closed v2 schema (or cannot be
 * checked); otherwise a human-readable first failure for the `400
 * validation_error` envelope.
 */
export function v2ConfigurableViolation(configurable: unknown): string | null {
  const validate = validator();
  if (validate === null) return null;
  if (validate(configurable)) return null;
  const first = validate.errors?.[0];
  if (first === undefined) return 'configurable does not satisfy schemas/v2/configurable.schema.json';
  return `${first.instancePath || '/'} ${first.message ?? 'is invalid'}`.trim();
}

