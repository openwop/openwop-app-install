/**
 * ADR 1031 P2 — feature-owned rows of the PATH- and ID-keyed exception tables in
 * the repo's source-scanning ratchets, read SYNCHRONOUSLY (several ratchets build
 * their tables at collection time, inside `describe` / `it.each`).
 *
 * A feature package may own `<feature dir>/ratchetTables.json`:
 *
 *   {
 *     "pathTables": { "<table>": { "<path relative to the feature dir>": <row> } },
 *     "idTables":   { "<table>": { "<id>": <row> } }
 *   }
 *
 * A ratchet merges `declaredPathTable(<table>)` (keys made `src/`-relative, so
 * `features/<id>/x.ts` or `adopter/features/<id>/x.ts`) or `declaredIdTable(<table>)`
 * with its own host table and runs its unchanged assertions over the union. Rows
 * are reviewed exactly like host rows; a stale one fails the ratchet's own
 * no-ghost check. (Rows that need code — a RegExp, an imported constant — use the
 * async `ratchetDeclarations.ts` instead: featureRatchetDeclarations.ts.)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { featureSourceRoots } from './featureSourceRoots.js';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

interface TablesFile { pathTables?: Record<string, Record<string, unknown>>; idTables?: Record<string, Record<string, unknown>> }

function files(): Array<{ srcRel: string; tables: TablesFile }> {
  const out: Array<{ srcRel: string; tables: TablesFile }> = [];
  for (const root of featureSourceRoots()) {
    for (const d of readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = join(root, d.name, 'ratchetTables.json');
      if (existsSync(f)) out.push({ srcRel: relative(SRC_ROOT, join(root, d.name)).split(sep).join('/'), tables: JSON.parse(readFileSync(f, 'utf8')) as TablesFile });
    }
  }
  return out;
}

/** `{ 'features/<id>/<file>': row }` over every feature's `pathTables[table]`. */
export function declaredPathTable<T>(table: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const { srcRel, tables } of files()) {
    for (const [file, row] of Object.entries(tables.pathTables?.[table] ?? {})) out[`${srcRel}/${file}`] = row as T;
  }
  return out;
}

/** The src-relative paths of every feature's `pathTables[table]` (a path LIST table). */
export function declaredPathList(table: string): string[] {
  return Object.keys(declaredPathTable(table));
}

/** `{ id: row }` over every feature's `idTables[table]`. */
export function declaredIdTable<T>(table: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const { tables } of files()) Object.assign(out, tables.idTables?.[table] ?? {});
  return out as Record<string, T>;
}
