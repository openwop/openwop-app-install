/**
 * Tool-argument schema validation — ONE validator for ONE schema class.
 *
 * Agent tools declare an `inputSchema`, and that declaration has two callers:
 * the MCP router (`mcpServerRouter.ts`, `tools/call`) and the chat tool loop
 * (`agentToolProvider.ts`, `executeTool`). Before ADR 0547 only the first of
 * them validated, so one declaration meant two different things depending on
 * who called the tool. This module is the shared validator that gives it one
 * meaning.
 *
 * Scope note (ADR 0547 D2): this is deliberately NOT "the app's Ajv". The host
 * runs several Ajv instances, each owning a *different* schema class — artifact
 * types, RFC 0021 envelopes, eval rubrics, run inputs (draft-07, formats off),
 * pack manifests. The rule is one validator per schema CLASS, shared by every
 * caller of that class; merging unrelated classes would couple schema languages
 * for no gain. Tool `inputSchema` is the class that owns this file.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

/** Compiled Ajv2020 instance shared across requests. The instance is
 *  thread-safe within a Node worker. Tool inputSchemas are added on
 *  first reference and cached by content hash. */
const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaCache = new Map<string, ValidateFunction>();

/**
 * Compile (and memoize) a tool `inputSchema`. Throws if the schema itself is
 * invalid — callers decide whether that is a client error (MCP: invalid params)
 * or a host error (a builtin tool shipping a broken schema).
 */
export function compileToolSchema(schema: Record<string, unknown>): ValidateFunction {
  // Cache key by JSON-stable hash of the schema. Cheap enough — tool
  // schemas are small. `JSON.stringify(schema)` is a deterministic
  // identity because Ajv treats object-property-order semantically.
  //
  // ADR 0547 D4 — `$id` is stripped before compile. The chat path always did
  // this; MCP did not. Now that BOTH callers compile from one Ajv instance, a
  // `$id` shared by two tool schemas would throw on the second registration
  // ("schema with key or id already exists"), so stripping is required rather
  // than merely tidy. Dropping `$id` cannot make an invalid argument set pass:
  // it removes an identity, not a constraint.
  const { $id: _dropId, ...body } = schema;
  const key = JSON.stringify(body);
  let validator = schemaCache.get(key);
  if (!validator) {
    validator = ajv.compile(body);
    schemaCache.set(key, validator);
  }
  return validator;
}

/**
 * Validate tool arguments, returning the chat loop's `{ok, errors}` shape.
 *
 * ADR 0547 D2 — a schema that cannot COMPILE is a host defect (a builtin
 * shipping a broken descriptor), not a bad request, so this reports it as its
 * own outcome rather than silently degrading to "everything is valid". The
 * previous behaviour returned a permissive validator, which disabled argument
 * checking for that tool for the life of the process.
 */
export function validateToolInput(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): { ok: boolean; errors?: string; schemaBroken?: true } {
  let validate: ValidateFunction;
  try {
    validate = compileToolSchema(schema);
  } catch (err) {
    return { ok: false, schemaBroken: true, errors: err instanceof Error ? err.message : String(err) };
  }
  if (validate(input)) return { ok: true };
  return { ok: false, errors: ajv.errorsText(validate.errors) };
}

/** Test seam — clears the compiled-schema cache. Both callers of this class
 *  (the MCP router and the chat tool loop) share it, so a test that mutates a
 *  tool's schema between cases must reset here. */
export function _resetToolSchemaCache(): void {
  schemaCache.clear();
}

/**
 * Can this schema be compiled at all? ADR 0547 D2.
 *
 * Used to decide whether a tool is offerable. A tool whose schema does not
 * compile cannot have its arguments checked, and the host's existing rule is
 * that a tool it cannot describe is not offered to the model — this applies
 * that rule to a case that escaped it. Cheap: the compile is memoized, so the
 * check costs a cache hit for every tool that is fine.
 */
export function toolSchemaCompiles(schema: Record<string, unknown>): boolean {
  try {
    compileToolSchema(schema);
    return true;
  } catch {
    return false;
  }
}
