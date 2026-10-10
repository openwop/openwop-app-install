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
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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

/** Every locale catalog: `<area>/i18n/<locale>.ts` and `i18n/locales/<locale>/*.ts`. */
const CATALOGS = files(SRC, (p) => {
  const r = relative(SRC, p);
  return LOCALES.some((l) => r.endsWith(`/i18n/${l}.ts`) || r.startsWith(`i18n/locales/${l}/`)) && r.endsWith('.ts');
});
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

const key = (where: string, line: string): string => `${where.replace(/:\d+$/, '')}:${/^\s*['"]?([\w.-]+)['"]?\s*:/.exec(line)?.[1] ?? '?'}`;

describe('user-visible copy cites no ADR / RFC numbers (all locales, all namespaces)', () => {
  it('non-vacuity: every locale has catalogs, and route manifests are read', () => {
    for (const l of LOCALES) {
      expect(CATALOGS.filter((p) => p.includes(`/${l}`)).length, l).toBeGreaterThan(50);
    }
    expect(ROUTE_MANIFESTS.length).toBeGreaterThan(20);
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
    const offenders = ROUTE_MANIFESTS.flatMap((f) => lines(f, (l) => /\b(label|hint)\s*:\s*['"`]/.test(l)))
      .filter(([, line]) => cites(line))
      .map(([where, line]) => `${where} ${line.trim().slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });
});
