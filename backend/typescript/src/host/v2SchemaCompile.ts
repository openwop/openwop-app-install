/**
 * Compile ONE vendored `schemas/v2/` schema with ajv, registering every sibling
 * it reaches by a relative-filename `$ref` (transitively).
 *
 * RFC 0266: the pack/manifest validators used to compile the flat v1 copy of
 * their schema, which is self-contained. The v2 copies are not: they `$ref`
 * `ids.schema.json#/$defs/…` (and the prompt schemas `./prompt-template…`), so a
 * bare `ajv.compile` throws MissingRefError. This was the chain loader's private
 * `registerSiblingRefs` (ADR 0713 / WHD-15); it is shared now because every
 * manifest loader needs exactly it.
 *
 * Deliberately the CLOSURE and not "every file in the directory": these
 * validators gate what serves, and an unrelated sibling that fails to register
 * must not be able to take a loader down with it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/** Register, under its own `$id`, every sibling schema `doc` reaches by a
 *  relative-filename `$ref` (`ids.schema.json#/…` or `./prompt-ref.schema.json`). */
export function registerV2SiblingRefs(ajv: Ajv2020, dir: string, doc: unknown, seen: Set<string>): void {
  if (Array.isArray(doc)) { for (const x of doc) registerV2SiblingRefs(ajv, dir, x, seen); return; }
  if (!doc || typeof doc !== 'object') return;
  for (const [key, value] of Object.entries(doc)) {
    if (key !== '$ref' || typeof value !== 'string') { registerV2SiblingRefs(ajv, dir, value, seen); continue; }
    const file = (value.split('#')[0] ?? '').replace(/^\.\//, '');
    // A sibling is a bare filename: no scheme, no path. Anything else is either a
    // local `#/…` pointer (empty `file`) or not ours to fetch.
    if (file.length === 0 || file.includes('/') || file.includes(':') || seen.has(file)) continue;
    seen.add(file);
    const sibling = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
    ajv.addSchema(sibling);
    registerV2SiblingRefs(ajv, dir, sibling, seen);
  }
}

export interface CompileV2Options {
  /** ajv `allErrors` (default true). */
  allErrors?: boolean;
  /** Register `ajv-formats` (default true). */
  formats?: boolean;
}

/** Compile `<v2Dir>/<file>` with its `$ref` closure. Throws on a missing or
 *  uncompilable schema; callers decide whether that fails open or closed. */
export function compileV2Schema(v2Dir: string, file: string, opts: CompileV2Options = {}): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: opts.allErrors ?? true, strict: false });
  if (opts.formats ?? true) addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(v2Dir, file), 'utf8')) as Record<string, unknown>;
  registerV2SiblingRefs(ajv, v2Dir, schema, new Set([file]));
  return ajv.compile(schema);
}
