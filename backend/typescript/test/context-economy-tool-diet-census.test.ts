/**
 * ADR 1003 D1 — the tool diet never changes what a valid call looks like, for
 * EVERY tool this host can put in front of a model.
 *
 * The first diet stripped `title` at every depth, so the default-on
 * `openwop:kanban.add-todo` reached the model as `{required:['title'],
 * properties:{}}`. Its unit test only ever put `title` in annotation position,
 * so it could not see that. This census runs the real diet over the real
 * population — the booted builtin + feature-registered tool registry, and every
 * pack-declared `schemas/*.input.json` (pack tools reach the model through the
 * BYOK tools round) — and asserts the parameter surface is unchanged.
 *
 * The signature below knows ONE thing about JSON Schema on purpose: that
 * `properties` is a name map. It counts every name in every `properties` map
 * and records every `required` array, so it does not share the diet's own
 * keyword tables (a census built from the code under test agrees with its bugs).
 *
 * Sabotage (witnessed 2026-10-29): restoring the depth-blind `compactValue`
 * reds the add-todo case and both census cases.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { builtinAgentToolIds, builtinAgentTool } from '../src/host/agentToolProvider.js';
import { compactToolSchema } from '../src/providers/toolSchemaCompaction.js';

interface Signature { names: string[]; required: string[] }

/** Every property name (with its path) and every `required` array (with its
 *  path). `examples` is skipped only in keyword position: its values are
 *  sample DATA the diet legitimately drops, not schema. */
function signature(schema: unknown): Signature {
  const names: string[] = [];
  const required: string[] = [];
  const walk = (v: unknown, at: string, inNameMap: boolean): void => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`, false)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v)) {
      if (inNameMap) { names.push(`${at}.${k}`); walk(child, `${at}.${k}`, false); continue; }
      if (k === 'examples') continue;
      if (k === 'required' && Array.isArray(child)) required.push(`${at}=${JSON.stringify(child)}`);
      walk(child, `${at}.${k}`, k === 'properties');
    }
  };
  walk(schema, '$', false);
  return { names: names.sort(), required: required.sort() };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function packInputSchemas(): Array<[string, Record<string, unknown>]> {
  const root = path.resolve(__dirname, '../../../packs');
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const pack of readdirSync(root)) {
    const dir = path.join(root, pack, 'schemas');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.input.json')) continue;
      const parsed: unknown = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      if (isRecord(parsed)) out.push([`${pack}/${f}`, parsed]);
    }
  }
  return out;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Booting registers every feature's agent tools into the registry.
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('tool diet census (ADR 1003 D1)', () => {
  it('the real openwop:kanban.add-todo keeps its title parameter', () => {
    const schema = builtinAgentTool('openwop:kanban.add-todo')?.def.inputSchema;
    if (!schema) throw new Error('openwop:kanban.add-todo is not registered');
    const out = compactToolSchema(schema, true);
    expect(Object.keys(isRecord(out.properties) ? out.properties : {})).toContain('title');
    expect(out.required).toEqual(['title']);
  });

  it('every registered agent tool keeps its parameter names and required arrays', () => {
    const ids = builtinAgentToolIds();
    // Denominator floor: an unbooted registry would make this vacuous.
    expect(ids.length).toBeGreaterThanOrEqual(200);
    const changed = ids.filter((id) => {
      const schema = builtinAgentTool(id)?.def.inputSchema;
      if (!schema) return false;
      return JSON.stringify(signature(compactToolSchema(schema, true))) !== JSON.stringify(signature(schema));
    });
    expect(changed).toEqual([]);
  });

  it('every pack-declared input schema keeps its parameter names and required arrays', () => {
    const schemas = packInputSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(300);
    const changed = schemas
      .filter(([, s]) => JSON.stringify(signature(compactToolSchema(s, true))) !== JSON.stringify(signature(s)))
      .map(([name]) => name);
    expect(changed).toEqual([]);
  });
});
