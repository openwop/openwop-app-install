/**
 * Centralized-registration guard (white-label PRD §3; ADR 0001 §1.2 / §2.2,
 * introduced by #578).
 *
 * The CoLabCare fork shipped a route file that 404'd in production because
 * its `registerXRoutes(app)` call was forgotten in index.ts. This test makes
 * that bug impossible: every `register*Route(s)` export under `src/routes/`
 * MUST be CALLED by `src/routes/registerAllRoutes.ts` (the one ordered module
 * list index.ts mounts) or by a feature module (ADR 0001 §2.2), and index.ts
 * must mount that list exactly once and hand-mount nothing. Add the module to
 * the list — or, for a deliberately unmounted module, add it to the documented
 * allowlist below.
 *
 * "Called" means: a binding IMPORTED FROM that routes/ module is invoked as
 * `local(` in code, with comments and import statements stripped. Two weaker
 * readings each passed a real omission: a plain substring check was satisfied
 * by the import line (8fw1g3-rr-call-removed, vacuous), and a by-NAME call
 * check is satisfied by a different function of the same name —
 * `features/discovery/routes.ts` defines and calls its own
 * `registerDiscoveryRoutes`, which would hide a dropped mount of
 * `routes/discovery.ts`'s. Feature test files are not a mounting surface.
 *
 * Red when a registrar's call is removed or only commented out, when the call
 * is bound to another module, when a new registrar is left unmounted, when
 * index.ts hand-mounts a module, or when index.ts stops calling
 * `registerAllRoutes(` (grade-tests w115 probes `w115g2-rr-*`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { stripComments } from './helpers/stripComments.js';

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

/** Code only: comments (the shared token scanner, so a `/*` inside a string or a
 *  line comment cannot swallow code), then import/re-export statements (single-
 *  or multi-line), so a NAME that is merely imported or mentioned is not a call. */
function stripImportsAndComments(src: string): string {
  return stripComments(src)
    .replace(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"][^'"]+['"];?/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?/gm, '');
}

/** The mounting surface: registerAllRoutes.ts PLUS every non-test feature module
 *  (ADR 0001 §2.2 — a feature mounts its routes through its BackendFeature, which
 *  registerAllRoutes composes via registerBackendFeatures). Returns the registrars
 *  it CALLS, keyed `<routes file>:<export name>`: a call counts only through a
 *  value binding imported from that exact routes/ module (aliases followed). */
function mountedRegistrars(): Set<string> {
  const mounted = new Set<string>();
  const surface = [
    REGISTRAR,
    ...tsFilesUnder(FEATURES_DIR).filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts')),
  ];
  for (const file of surface) {
    const raw = readFileSync(file, 'utf8');
    const code = stripComments(raw);
    const body = stripImportsAndComments(raw);
    for (const m of code.matchAll(/\bimport\s+(?!type\b)\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[2]!.replace(/\.js$/, '.ts'));
      if (dirname(target) !== ROUTES_DIR) continue;
      for (const part of m[1]!.split(',')) {
        const spec = part.trim();
        if (!spec || spec.startsWith('type ')) continue;
        const [imported = '', alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
        const local = alias ?? imported;
        if (new RegExp(`\\b${local}\\(`).test(body)) mounted.add(`${basename(target)}:${imported}`);
      }
    }
  }
  return mounted;
}

/** Measured at 7321e3612: 88 `register*Route(s)` exports under src/routes/;
 *  91 at d5b98aafaa (w115). The floor is a liveness bound, not the ratchet. */
const REGISTRAR_FLOOR = 86;

/** Modules deliberately NOT mounted by registerAllRoutes (document why). */
const UNMOUNTED_ALLOWLIST = new Set<string>([
  // (none today)
]);

describe('registerAllRoutes — every routes/ module is mounted', () => {
  it('lists every register* export from src/routes/', () => {
    const mounted = mountedRegistrars();
    const missing: string[] = [];
    let seen = 0;
    for (const file of readdirSync(ROUTES_DIR)) {
      if (!file.endsWith('.ts') || file === 'registerAllRoutes.ts') continue;
      const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
      for (const m of source.matchAll(/export (?:async )?function (register\w*Routes?)\b/g)) {
        const fn = m[1]!;
        seen++;
        if (UNMOUNTED_ALLOWLIST.has(fn)) continue;
        // A CALL of THIS module's export, not a mention and not a same-named function.
        if (!mounted.has(`${file}:${fn}`)) missing.push(`${fn} (${file})`);
      }
    }
    expect(seen, 'the registrar scan found the routes/ exports').toBeGreaterThanOrEqual(REGISTRAR_FLOOR);
    expect(
      missing,
      `These route registrars are not mounted in registerAllRoutes.ts — a new domain can't ship unregistered: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('index.ts mounts through registerAllRoutes only (no stray register calls)', () => {
    const indexSource = stripComments(readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8'));
    const strays = [...indexSource.matchAll(/\bregister\w+Routes?\(/g)]
      .map((m) => m[0])
      .filter((c) => c !== 'registerAllRoutes(');
    expect(
      strays,
      `index.ts must not hand-mount route modules — move these into routes/registerAllRoutes.ts: ${strays.join(', ')}`,
    ).toEqual([]);
    // "Through registerAllRoutes": with no call at all there are no strays either,
    // and nothing is mounted.
    expect(
      (indexSource.match(/\bregisterAllRoutes\(/g) ?? []).length,
      'index.ts must mount the route list by calling registerAllRoutes( exactly once',
    ).toBe(1);
  });
});
