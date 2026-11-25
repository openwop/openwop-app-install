/**
 * ADR 1160 D1 — every canvas create names its org.
 *
 * `createCanvasForTenant` / `ensureCanvasForTenant` take `orgId` (an org id, or
 * `null` with a `system:` reason in `orgWhy`). The parameter is optional in the
 * TYPE only so the ~200 test call sites need no churn; this ratchet is what makes
 * it required in `src/`:
 *  1. every call's argument text names `orgId` (or spreads `...args.org`, the
 *     renderCore pass-through whose own type requires it), and an `orgId: null`
 *     carries an `orgWhy: 'system:…'` reason;
 *  2. per file, the exact number of create calls, so a NEW create lane fails here
 *     until it is reviewed (a new file fails because it is not listed).
 * Adopter features add their own create lanes through `ratchetTables.json`
 * (`pathTables["adr1160.create"]`), as the ADR 0886 write ratchet does.
 *
 * Sabotage: deleting `orgId,` from the blank-create call in
 * `canvasEditorRoutes.ts` reds pin 1; adding a create call to a reviewed file
 * reds pin 2.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './helpers/stripComments.js';
import { declaredPathTable } from './helpers/featureRatchetTables.js';

const SRC = new URL('../src/', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const CALL = /\b(createCanvasForTenant|ensureCanvasForTenant)\(/g;
const DEFINITION = /export\s+async\s+function\s+(createCanvasForTenant|ensureCanvasForTenant)\(/;

/** The argument text of the call whose `(` is at `open`, by paren balance. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** file → number of create calls, reviewed: each names its org (pin 1). */
const HOST_REVIEWED: Record<string, number> = {
  'features/canvasEditorRoutes.ts': 1, // blank create: the path org
  'host/canvasFromArtifact.ts': 1, // the editor's path org; `system:seed-without-org` when none is given
  'features/slides/routes.ts': 1, // import: the path org
  'features/cad/routes.ts': 1, // import: the path org
  'features/slides/agentTools.ts': 1, // render: the resolved tool org
  'features/drawings/agentTools.ts': 1,
  'features/cad/agentTools.ts': 1,
  'features/campaign-studio/agentTools.ts': 1,
  'features/app-builder/renderCore.ts': 1, // `...args.org`, required by RenderDesignArgs
  'features/app-builder/mcpControlNodes.ts': 1, // system: a run has no org (D6)
  'host/demoAppBuilderSeed.ts': 1, // system: tenant-shared demo
  'features/ui-plugins/routes.ts': 2, // system: the RFC 0238 fixture and the demo artifact
};
const REVIEWED: Record<string, number> = { ...HOST_REVIEWED, ...declaredPathTable<number>('adr1160.create') };

interface Site { file: string; args: string }
function sites(): Site[] {
  const out: Site[] = [];
  for (const path of walk(SRC)) {
    const src = stripComments(readFileSync(path, 'utf8'));
    for (const m of src.matchAll(CALL)) {
      const at = m.index ?? 0;
      if (DEFINITION.test(src.slice(Math.max(0, at - 30), at + m[0].length))) continue;
      out.push({ file: relative(SRC, path), args: argsAt(src, at + m[0].length - 1) });
    }
  }
  return out;
}

describe('ADR 1160 D1 — every canvas create names its org', () => {
  const all = sites();

  it('finds the create lanes (the scan works)', () => {
    expect(all.length).toBeGreaterThanOrEqual(12);
  });

  it.each(all.map((s, i) => [`${s.file} #${i}`, s] as const))('%s names orgId', (_label, s) => {
    const named = /\borgId\b/.test(s.args) || /\.\.\.args\.org\b/.test(s.args);
    expect(named, `${s.file}: a canvas create must pass orgId (ADR 1160 D1)`).toBe(true);
    if (/\borgId:\s*null\b/.test(s.args)) {
      expect(/orgWhy:\s*'system:[^']+'/.test(s.args), `${s.file}: orgId: null needs an orgWhy: 'system:<reason>'`).toBe(true);
    }
  });

  it('pins the create calls per file', () => {
    const counts: Record<string, number> = {};
    for (const s of all) counts[s.file] = (counts[s.file] ?? 0) + 1;
    expect(counts).toEqual(REVIEWED);
  });
});
