/**
 * ADR 0630 layer 1 — the module-graph gate, pinned both ways.
 *
 * Half of these run the classifier on fixtures (each verdict, the allowlist
 * match, the stale-entry failure). The other half run the gate on the REAL
 * tree, and the one that matters most is the sabotage: the real tree with an
 * EMPTY allowlist must go RED through the real entry point, naming a real file
 * and a real distribution. A gate proven only on fixtures has been proven to
 * work on fixtures; this repo's dominant defect family is the gate that is
 * green because it never ran (#3070), and the child-process case is what rules
 * that out here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classify,
  scanFeatureImports,
  registryDirToId,
  registryIds,
  checkFeatureImportBoundary,
  formatReport,
  INVARIANT,
  type AllowlistEntry,
} from '../../../scripts/check-feature-import-boundary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = join(ROOT, 'scripts', 'check-feature-import-boundary.mjs');
const ALLOWLIST = join(ROOT, 'scripts', 'feature-import-boundary.allowlist.json');

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'owp-boundary-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmp, 'src-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return dir;
}

const noExclusions = { frontend: new Map<string, string[]>(), backend: new Map<string, string[]>() };

describe('registry parsing', () => {
  it('maps a registry dir to its feature id through the <camel>Feature convention', () => {
    const map = registryDirToId([
      "import { crmFeature } from './crm/routes.js';",
      "import { discoveryFeature } from './product-discovery/routes.js';",
      "import type { FeatureRoute } from '../chrome/featureTypes.js';",
    ].join('\n'));
    expect(map.get('crm')).toBe('crm');
    expect(map.get('product-discovery')).toBe('discovery'); // dir ≠ id, the id wins
    expect(map.has('chrome')).toBe(false);
  });

  it('reads the same id universe gen-distribution reads', () => {
    expect([...registryIds("import { advisoryBoardFeature } from './advisory-board/routes.js';")]).toEqual(['advisory-board']);
  });
});

describe('scanFeatureImports', () => {
  it('finds static, dynamic and side-effect imports of features/* from outside src/features, and nothing else', () => {
    const src = tree({
      'App.tsx': [
        "const A = lazy(() => import('./features/commerce/StorefrontPage.js'));",
        "import { matchStore } from './features/commerce/storeRoute.js';",
        "import './features/cad/styles.css';",
        "import { x } from './chrome/thing.js';",
        "import { FRONTEND_FEATURES } from './features/registry.js';", // the registry API itself — permitted
        "// prose: a comment mentioning features/forms/PublicFormPage.js is not an import",
      ].join('\n'),
      'chat/Panel.tsx': "import { y } from '../features/comments/CommentsPanel.js';",
      'chat/Panel.test.tsx': "import { y } from '../features/forms/x.js';", // tests are out of scope
      'features/crm/x.ts': "import { z } from '../forms/y.js';", // inside features — layer 1b, not this gate
    });
    const hits = scanFeatureImports(src, src).map((h) => `${h.file}:${h.line} ${h.dir}`);
    expect(hits).toEqual([
      'App.tsx:1 commerce',
      'App.tsx:2 commerce',
      'App.tsx:3 cad',
      'chat/Panel.tsx:1 comments',
    ]);
  });
});

describe('classify — one verdict per way "reachable" fails', () => {
  const dirToId = new Map([['commerce', 'commerce'], ['users', 'users'], ['forms', 'forms']]);
  const backendIds = new Set(['commerce', 'users', 'forms', 'docs']);
  const bundleOf = new Map([['commerce', 'commerce']]);
  const hit = (file: string, dir: string, line = 1) => ({ file, line, spec: `./features/${dir}/x.js`, dir });

  it('a core feature is permitted and counted, never flagged', () => {
    const r = classify({ imports: [hit('App.tsx', 'users')], dirToId, backendIds, core: ['users'], bundleOf, exclusions: noExclusions, allowlist: [] });
    expect(r.violations).toEqual([]);
    expect(r.permittedCore.map((p) => p.id)).toEqual(['users']);
  });

  it('an excludable feature is a violation that NAMES the distributions its import defeats', () => {
    const exclusions = { frontend: new Map([['commerce', ['kicktodo', 'slim-proof']]]), backend: new Map() };
    const r = classify({ imports: [hit('App.tsx', 'commerce', 23)], dirToId, backendIds, core: [], bundleOf, exclusions, allowlist: [] });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.kind).toBe('excludable');
    expect(r.violations[0]!.detail).toContain("'commerce' (bundle 'commerce') is EXCLUDED by kicktodo, slim-proof");
    expect(formatReport(r)).toContain('App.tsx:23 imports features/commerce/x.js');
  });

  it('an excludable feature no committed manifest excludes is still a violation (any include-mode manifest that omits it is defeated)', () => {
    const r = classify({ imports: [hit('App.tsx', 'forms')], dirToId, backendIds, core: [], bundleOf, exclusions: noExclusions, allowlist: [] });
    expect(r.violations[0]!.detail).toContain("'forms' (standalone) is excludable");
  });

  it('a backend-only id with frontend code is frontend-unregistered — the filter has nothing to remove', () => {
    const exclusions = { frontend: new Map(), backend: new Map([['docs', ['no-sales']]]) };
    const r = classify({ imports: [hit('App.tsx', 'docs')], dirToId, backendIds, core: [], bundleOf, exclusions, allowlist: [] });
    expect(r.violations[0]!.kind).toBe('frontend-unregistered');
    expect(r.violations[0]!.detail).toContain('has no FRONTEND registry entry');
    expect(r.violations[0]!.detail).toContain('no-sales exclude it on the backend only');
  });

  it('a dir in neither registry is unregistered — outside the mechanism, not defeated by it', () => {
    const r = classify({ imports: [hit('App.tsx', 'site')], dirToId, backendIds, core: [], bundleOf, exclusions: noExclusions, allowlist: [] });
    expect(r.violations[0]!.kind).toBe('unregistered');
    expect(r.violations[0]!.id).toBeNull();
    expect(r.violations[0]!.detail).toContain('NO registry id');
  });

  it('an allowlist entry matches on (file, feature) and moves the import to the backlog', () => {
    const allowlist: AllowlistEntry[] = [{ file: 'App.tsx', feature: 'commerce', owner: 'features/commerce', why: 'public storefront route' }];
    const r = classify({ imports: [hit('App.tsx', 'commerce'), hit('App.tsx', 'commerce', 2)], dirToId, backendIds, core: [], bundleOf, exclusions: noExclusions, allowlist });
    expect(r.violations).toEqual([]);
    expect(r.allowlisted).toHaveLength(2);
    expect(r.stale).toEqual([]);
  });

  it('an unregistered dir is allowlisted by its dir name (it has no id to key on)', () => {
    const allowlist: AllowlistEntry[] = [{ file: 'App.tsx', feature: 'site', owner: 'features/site', why: 'needs an id' }];
    const r = classify({ imports: [hit('App.tsx', 'site')], dirToId, backendIds, core: [], bundleOf, exclusions: noExclusions, allowlist });
    expect(r.violations).toEqual([]);
    expect(r.allowlisted).toHaveLength(1);
  });

  it('an allowlist entry that matches nothing is STALE and fails — the list is shrink-only and exact', () => {
    const allowlist: AllowlistEntry[] = [{ file: 'Gone.tsx', feature: 'commerce', owner: 'features/commerce', why: 'fixed last week' }];
    const r = classify({ imports: [], dirToId, backendIds, core: [], bundleOf, exclusions: noExclusions, allowlist });
    expect(r.stale).toHaveLength(1);
    expect(formatReport(r)).toContain("Gone.tsx × 'commerce'");
  });
});

describe('the real tree', () => {
  it('is green against the committed allowlist, and the allowlist is exact (no stale entries)', () => {
    const r = checkFeatureImportBoundary();
    expect(r.violations, formatReport(r)).toEqual([]);
    expect(r.stale, formatReport(r)).toEqual([]);
    // The backlog exists; the gate is not green because the tree is clean.
    expect(r.allowlisted.length).toBeGreaterThan(0);
  });

  it('every allowlist entry carries an owner and a reason', () => {
    const parsed = JSON.parse(readFileSync(ALLOWLIST, 'utf8')) as { entries: AllowlistEntry[] };
    for (const e of parsed.entries) {
      expect(e.owner, JSON.stringify(e)).toMatch(/^features\//);
      expect(e.why.length, JSON.stringify(e)).toBeGreaterThan(20);
    }
  });

  it('SABOTAGE — with an empty allowlist the gate goes RED through its real entry point, naming a real import and a real distribution', () => {
    const empty = join(tmp, 'empty-allowlist.json');
    writeFileSync(empty, '{"entries":[]}');
    let status = 0;
    let out = '';
    try {
      out = execFileSync('node', [GATE], {
        cwd: ROOT,
        env: { ...process.env, OPENWOP_BOUNDARY_ALLOWLIST: empty },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      status = err.status ?? -1;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    expect(status).toBe(1);
    expect(out).toContain(INVARIANT);
    // The headline instance from #3627: a public page hard-imported by App.tsx
    // that a committed manifest excludes. Which manifest is measured, not
    // remembered — assert the SHAPE ("is EXCLUDED by <name>"), not a name.
    expect(out).toMatch(/frontend\/react\/src\/App\.tsx:\d+ imports features\/forms\/PublicFormPage\.js — 'forms' \(standalone\) is EXCLUDED by [a-z-]+/);
    expect(out).toMatch(/features\/site has NO registry id/);
  });
});
