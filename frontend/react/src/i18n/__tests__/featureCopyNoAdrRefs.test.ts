/**
 * User-visible copy never cites internal ADR / RFC numbers.
 *
 * Owner request 2026-10-07 ("remove all references to ADRs and RFCs"): copy
 * reads as product language, not as a pointer into our decision log
 * ("Sandboxed front-end plugin packs (RFC 0117/0119)"). The backend half —
 * toggle labels/descriptions and bundle labels — is
 * `backend/typescript/test/feature-copy-no-adr-refs.test.ts`. This pins EVERY
 * locale catalog in the SPA (every namespace, all four locales) plus the
 * English fallback `label:` / `hint:` literals a route manifest declares for
 * the nav. Comments are skipped: they are for engineers, not users.
 *
 * ALLOWLIST is empty on purpose. If a string genuinely must say "RFC" (an
 * external standard a user needs by name), add `path:key` with the reason —
 * but reword first; "RFC 1918" became "LAN", for example.
 *
 * Sabotage (wave 51 probes): an ADR/RFC citation planted in any locale catalog value
 * or a route manifest's nav label reds the matching case; dropping a locale from the
 * scan reds the non-vacuity case.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');
const LOCALES = ['en', 'es', 'pt-BR', 'fr'] as const;

const ALLOWLIST: Readonly<Record<string, string>> = {};

function files(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === '__tests__' || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

/** The locale a catalog belongs to, read from its FILE NAME (`<area>/i18n/<locale>.ts`)
 *  or its DIRECTORY segment (`i18n/locales/<locale>/*.ts`) — never a substring of the
 *  absolute path (`'/fr'` matched `/frontend/`, so the fr floor counted every catalog). */
function localeOf(p: string): string | null {
  const r = relative(SRC, p).split(sep).join('/');
  if (!r.endsWith('.ts')) return null;
  return LOCALES.find((l) => r.endsWith(`/i18n/${l}.ts`) || r.startsWith(`i18n/locales/${l}/`)) ?? null;
}

/** Every locale catalog: `<area>/i18n/<locale>.ts` and `i18n/locales/<locale>/*.ts`. */
const CATALOGS = files(SRC, (p) => localeOf(p) !== null);
const ROUTE_MANIFESTS = files(SRC, (p) => /\/routes\.tsx?$/.test(p));

const NUMBERED = /\b(ADR|RFC)[\s-]?\d{3,4}\b/i;
const BARE = /\b(ADR|RFC)s?\b/;
const cites = (s: string): boolean => NUMBERED.test(s) || BARE.test(s);

/** Non-comment lines of a file, optionally narrowed. */
function lines(file: string, keep: (line: string) => boolean = () => true): Array<[string, string]> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => [`${relative(SRC, file)}:${i + 1}`, line] as [string, string])
    .filter(([, line]) => !/^\s*(\/\/|\/\*|\*)/.test(line) && keep(line));
}

const NAV_COPY_LINE = (l: string): boolean => /\b(label|hint)\s*:\s*['"`]/.test(l);

const key = (where: string, line: string): string => `${where.replace(/:\d+$/, '')}:${/^\s*['"]?([\w.-]+)['"]?\s*:/.exec(line)?.[1] ?? '?'}`;

describe('user-visible copy cites no ADR / RFC numbers (all locales, all namespaces)', () => {
  // Floors = the MEASURED truth on 2026-10-16 (e3c2492be), none a multiple of 10:
  // 132 catalogs in EACH locale, 88 route manifests, 153 nav label/hint lines. A walk
  // or filter that silently reads less than that reds here instead of passing on less.
  it('non-vacuity: every locale has catalogs, and route manifests are read', () => {
    for (const l of LOCALES) {
      expect(CATALOGS.filter((p) => localeOf(p) === l).length, l).toBeGreaterThanOrEqual(132);
    }
    expect(ROUTE_MANIFESTS.length).toBeGreaterThanOrEqual(88);
    expect(ROUTE_MANIFESTS.flatMap((f) => lines(f, NAV_COPY_LINE)).length).toBeGreaterThanOrEqual(153);
  });

  it('positive control: the matcher flags the copy this guard exists for', () => {
    expect(cites("uiPluginsHint: 'Sandboxed front-end plugin packs (RFC 0117/0119)',")).toBe(true);
    expect(cites("title: 'treated as untrusted (ADR 0038 §C).',")).toBe(true);
    expect(cites("body: 'capabilities that land behind their governing RFCs:',")).toBe(true);
    expect(cites("uiPluginsHint: 'Sandboxed front-end plugin packs',")).toBe(false);
  });

  it('no locale catalog string cites an ADR or RFC', () => {
    const offenders = CATALOGS.flatMap((f) => lines(f))
      .filter(([where, line]) => cites(line) && !(key(where, line) in ALLOWLIST))
      .map(([where, line]) => `${where} ${line.trim().slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });

  it('no route-manifest nav label / hint fallback cites an ADR or RFC', () => {
    const offenders = ROUTE_MANIFESTS.flatMap((f) => lines(f, NAV_COPY_LINE))
      .filter(([, line]) => cites(line))
      .map(([where, line]) => `${where} ${line.trim().slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });
});
