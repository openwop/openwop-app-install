/**
 * A validator for one major's run-event `$defs`, from the corpus PACKAGE (not
 * the vendored copy — see corpusSchema.ts), siblings registered by walking
 * `$ref`s. `defsFor(1)('approval.overridden')(payload)`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';

const req = createRequire(`${process.cwd()}/`);
const SCHEMAS = join(req.resolve('@openwop/spec-artifacts/package.json'), '..', 'schemas');

export type EventValidator = ((d: unknown) => boolean) & { errors?: unknown };

export function defsFor(major: 1 | 2): (type: string) => EventValidator {
  const dir = major === 1 ? SCHEMAS : join(SCHEMAS, 'v2');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (req('ajv-formats').default ?? req('ajv-formats'))(ajv);
  const root = JSON.parse(readFileSync(join(dir, 'run-event-payloads.schema.json'), 'utf8')) as { $defs: Record<string, unknown> & { _typeIndex: { properties: Record<string, { $ref: string }> } } };
  const registered = new Set<string>(['run-event-payloads.schema.json']);
  ajv.addSchema(root, 'run-event-payloads.schema.json');
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n === null || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') {
        const file = v.split('#')[0]?.split('/').pop() ?? '';
        if (file.endsWith('.schema.json') && !registered.has(file)) {
          registered.add(file);
          const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { $id?: string };
          ajv.addSchema(doc, file);
          if (typeof doc.$id === 'string') { try { ajv.addSchema(doc, doc.$id); } catch { /* dup */ } }
          walk(doc);
        }
      } else walk(v);
    }
  };
  walk(root);
  return (type) => {
    const ref = root.$defs._typeIndex.properties[type]?.$ref;
    const v = ref ? ajv.getSchema(`run-event-payloads.schema.json${ref}`) : undefined;
    if (!v) throw new Error(`major ${major}: no def for ${type}`);
    return v as EventValidator;
  };
}
