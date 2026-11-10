/**
 * ADR 1031 P2 — a feature package's own entries in the frontend build-chain gates'
 * exception lists. A package may own `<feature dir>/gateDeclarations.json`
 * (first-party `src/features/<id>/` or an adopter's `src/adopter/features/<id>/`);
 * each gate merges the entries it understands with its host list and applies the
 * same rule to the union. Paths inside are relative to the feature directory; this
 * returns them prefixed to the `src/`-relative form the gates key on.
 *
 * JSON rather than TS so these plain-Node gates read it without a loader.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @returns {Array<{ srcRel: string, decl: Record<string, unknown> }>} */
export function featureGateDeclarations(src) {
  const out = [];
  for (const base of ['features', 'adopter/features']) {
    const dir = join(src, base);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = join(dir, e.name, 'gateDeclarations.json');
      if (existsSync(f)) out.push({ srcRel: `${base}/${e.name}`, decl: JSON.parse(readFileSync(f, 'utf8')) });
    }
  }
  return out;
}

/** The `[file, ...rest]` rows a feature declares under `gate.key`, with `file` made `src/`-relative. */
export function declaredRows(src, gate, key) {
  return featureGateDeclarations(src).flatMap(({ srcRel, decl }) =>
    ((decl[gate] ?? {})[key] ?? []).map(([file, ...rest]) => [`${srcRel}/${file}`, ...rest]));
}
