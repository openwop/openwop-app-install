/**
 * TST-OAS-3 — the A2UI day-1 catalog, DERIVED from its single source of truth,
 * `schemas/v2/interrupt-form.schema.json` (`formV1.catalogVersion` and the
 * `componentV1` branches' single-string `component` enums).
 *
 * The assistant A2UI tests used to hand-copy the set and the version, so the
 * copy and the schema could drift with every test green. The schema is located
 * the way the host's own gate (`host/interruptFormRules.ts`) locates it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from '../../src/host/_repoPath.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function single(v: unknown, what: string): string {
  const e = isRec(v) ? v.enum : undefined;
  if (!Array.isArray(e) || e.length !== 1 || typeof e[0] !== 'string') throw new Error(`interrupt-form schema: ${what} is not a single-string enum`);
  return e[0];
}

function load(): { version: string; components: ReadonlySet<string> } {
  const dir = join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'), 'v2');
  const schema: unknown = JSON.parse(readFileSync(join(dir, 'interrupt-form.schema.json'), 'utf8'));
  const defs = isRec(schema) && isRec(schema.$defs) ? schema.$defs : {};
  const form = defs.formV1;
  const version = single(isRec(form) && isRec(form.properties) ? form.properties.catalogVersion : undefined, 'formV1.catalogVersion');
  const branches = isRec(defs.componentV1) && Array.isArray(defs.componentV1.anyOf) ? defs.componentV1.anyOf : [];
  const components = new Set(branches.map((b, i) => {
    const ref = isRec(b) && typeof b.$ref === 'string' ? b.$ref.replace('#/$defs/', '') : '';
    const def = defs[ref];
    return single(isRec(def) && isRec(def.properties) ? def.properties.component : undefined, `componentV1 branch ${i} (${ref || 'no $ref'})`);
  }));
  // Non-vacuity floor: an empty set would make every "component is in the catalog" check fail
  // loudly, but a mis-read that found one branch would quietly narrow it.
  if (components.size < 2) throw new Error(`interrupt-form schema: componentV1 yielded ${components.size} component(s)`);
  return { version, components };
}

const CATALOG_FROM_SCHEMA = load();
export const A2UI_CATALOG_VERSION: string = CATALOG_FROM_SCHEMA.version;
export const A2UI_CATALOG: ReadonlySet<string> = CATALOG_FROM_SCHEMA.components;
