/**
 * Centralized-registration guard (white-label PRD §3).
 *
 * The CoLabCare fork shipped a route file that 404'd in production because
 * its `registerXRoutes(app)` call was forgotten in index.ts. This test makes
 * that bug impossible: every `register*Route(s)` export under `src/routes/`
 * MUST be referenced by `src/routes/registerAllRoutes.ts` (the one ordered
 * module list index.ts mounts). Add the module to the list — or, for a
 * deliberately unmounted module, add it to the documented allowlist below.
 *
 * "Referenced" means CALLED: `fn(` in code, after import statements and
 * comments are stripped. A plain substring check was satisfied by the IMPORT
 * line, so deleting the `registerHealthRoutes(…)` call itself stayed green
 * (8fw1g3-rr-call-removed, vacuous in round 1) — the exact CoLabCare bug. The
 * registrar count is floored at the measured truth so an empty scan cannot read
 * as clean. Sabotage-witnessed: the removed call (rr-call-removed-r2), a stray
 * hand-mount in index.ts (rr-stray), a new unmounted registrar (rr-unmounted-new).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_DIR = join(__dirname, '..', 'src', 'routes');
const REGISTRAR = join(ROUTES_DIR, 'registerAllRoutes.ts');
const FEATURES_DIR = join(__dirname, '..', 'src', 'features');

/** Every `.ts` file under `dir`, recursively. Feature packages nest their
 *  source in subdirectories (`features/crm/`, `features/notifications/`, …), so
 *  a flat scan would miss a subdirectory feature that mounts a `routes/`
 *  registrar (ADR 0010 — notifications is the first to do so). */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The mounting surface: registerAllRoutes.ts PLUS every feature module
 *  (ADR §2.2 — a feature mounts its routes through its BackendFeature, which
 *  registerAllRoutes composes via registerBackendFeatures). A registrar
 *  referenced from either site counts as mounted. */
function mountingSurface(): string {
  let src = stripImportsAndComments(readFileSync(REGISTRAR, 'utf8'));
  for (const file of tsFilesUnder(FEATURES_DIR)) src += '\n' + stripImportsAndComments(readFileSync(file, 'utf8'));
  return src;
}

/** Code only: drop import/re-export statements (single- or multi-line), block
 *  comments and line comments, so a NAME that is merely imported or mentioned
 *  does not count as a mount. */
function stripImportsAndComments(src: string): string {
  // Order matters: line comments go FIRST, so a `/*` inside one (a route glob in
  // prose, e.g. "`/v1/content/*`") cannot open a block comment that swallows code.
  // Block comments are stripped only where they open a line (JSDoc / banner style).
  return src
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"][^'"]+['"];?/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?/gm, '');
}

/** Measured at 7321e3612: 88 `register*Route(s)` exports under src/routes/. */
const REGISTRAR_FLOOR = 86;

/** Modules deliberately NOT mounted by registerAllRoutes (document why). */
const UNMOUNTED_ALLOWLIST = new Set<string>([
  // (none today)
]);

describe('registerAllRoutes — every routes/ module is mounted', () => {
  it('lists every register* export from src/routes/', () => {
    const registrarSource = mountingSurface();
    const missing: string[] = [];
    let seen = 0;
    for (const file of readdirSync(ROUTES_DIR)) {
      if (!file.endsWith('.ts') || file === 'registerAllRoutes.ts') continue;
      const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
      for (const m of source.matchAll(/export (?:async )?function (register\w*Routes?)\b/g)) {
        const fn = m[1]!;
        seen++;
        if (UNMOUNTED_ALLOWLIST.has(fn)) continue;
        // A CALL site, not a mention: the import line and comments were stripped.
        if (!new RegExp(`\\b${fn}\\(`).test(registrarSource)) missing.push(`${fn} (${file})`);
      }
    }
    expect(seen, 'the registrar scan found the routes/ exports').toBeGreaterThanOrEqual(REGISTRAR_FLOOR);
    expect(
      missing,
      `These route registrars are not mounted in registerAllRoutes.ts — a new domain can't ship unregistered: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('index.ts mounts through registerAllRoutes only (no stray register calls)', () => {
    const indexSource = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const strays = [...indexSource.matchAll(/\bregister\w+Routes?\(/g)]
      .map((m) => m[0])
      .filter((c) => c !== 'registerAllRoutes(');
    expect(
      strays,
      `index.ts must not hand-mount route modules — move these into routes/registerAllRoutes.ts: ${strays.join(', ')}`,
    ).toEqual([]);
  });
});
