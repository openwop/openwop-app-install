/**
 * ADR 1160 D3 — every RAW canvas read is reviewed.
 *
 * `getCanvasForTenant(` and `listCanvasesForTenant(` load canvases by tenant
 * alone. They decide nothing about the org or the owner, so each call must sit
 * behind THE predicate (`canvasReadAllowed` / `canvasWriteAllowed` /
 * `assertCanvasRunAccess`), or be a system lane that acts for the tenant. This
 * pins, per file, the exact number of such calls with the reason they are safe.
 * A new raw read in a reviewed file changes the count and fails here until it is
 * reviewed; a new FILE fails because it is not listed. It is the read twin of
 * `adr0886-canvas-write-gate-ratchet` and the create twin of
 * `adr1160-canvas-create-org-ratchet`. Adopter features add theirs through
 * `ratchetTables.json` (`pathTables["adr1160.rawRead"]`).
 *
 * Sabotage: adding a `getCanvasForTenant(` call to `documents/routes.ts` (which
 * has none since P2) reds the pin.
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

const RAW = /\b(getCanvasForTenant|listCanvasesForTenant)\(/g;
const DEFINITION = /export\s+async\s+function\s+(getCanvasForTenant|listCanvasesForTenant)\(/g;

/** file → [raw read count, why each is safe]. */
const HOST_REVIEWED: Record<string, [number, string]> = {
  'host/canvasSurface.ts': [6, 'getCanvasForCaller / getCanvasForWriter (load, then THE predicate); restoreCanvasVersion head read (callers gate first); ensureCanvasForTenant own-row returns (system fixtures); canvasForLegacyIdemKey (the seed, called by a gated route)'],
  'features/canvasEditorRoutes.ts': [1, 'loadCanvas: type pin, path-org match, then canvasReadAllowed / canvasWriteAllowed'],
  'host/dataBinding.ts': [1, "assertCanvasRunAccess(scope, canvas, 'write')"],
  'host/collab/collabServer.ts': [3, 'ticket, claim-seed and upgrade: collabCanvasReadable (= canvasReadAllowed) and canvasWriteAllowed'],
  'host/collab/collabRoom.ts': [3, 'system:the room persists for members the JOIN authorized (ADR 0886 D2)'],
  'routes/presentRemote.ts': [1, 'authorizePresentRemote: the token org must be the canvas org, then canvasWriteAllowed'],
  'routes/uiPlugins.ts': [1, 'resolveArtifact: type pin, then canvasReadAllowed'],
  'features/sharing/sharingService.ts': [7, 'canvasEntitlement checks existence, then getCanvasForCaller plus the link-org match; the public resolvers serve links whose publisher the entitlement re-checks'],
  'features/comments/commentsService.ts': [2, 'canvas_document / canvas_slides: the path-org match, then canvasReadAllowed'],
  'features/campaign-studio/routes.ts': [1, 'loadPlan: canvasReadAllowed and the project-org check, then canvasWriteAllowed'],
  'features/campaign-studio/planLinks.ts': [1, 'setPlanLink re-check after loadPlan authorized the caller (type only)'],
  'features/app-builder/renderCore.ts': [1, 'after applyRepair (getCanvasForCaller + canvasWriteAllowed) wrote it: reads its org for the link'],
  'features/app-builder/syncWebhook.ts': [2, 'system:inbound sync, the binding org must be the canvas org; writes go through applyRepair as the binder'],
  'features/app-builder/canvasRetention.ts': [1, 'system:retention sweep of abandoned transient canvases'],
  'features/app-builder/dataExport.ts': [2, 'system:the tenant data export (admin, workspace-wide by contract)'],
  'host/demoAppBuilderSeed.ts': [2, 'system:the demo seed reads its own deterministic ids'],
};
const REVIEWED: Record<string, [number, string]> = { ...HOST_REVIEWED, ...declaredPathTable<[number, string]>('adr1160.rawRead') };

describe('ADR 1160 D3 — every raw canvas read is reviewed', () => {
  it('pins the raw reads per file', () => {
    const found: Record<string, number> = {};
    for (const f of walk(SRC)) {
      const src = stripComments(readFileSync(f, 'utf8'));
      const n = (src.match(RAW)?.length ?? 0) - (src.match(DEFINITION)?.length ?? 0);
      if (n > 0) found[relative(SRC, f)] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(REVIEWED).map(([f, [n]]) => [f, n])));
  });

  it('every row gives a reason', () => {
    for (const [f, [, why]] of Object.entries(REVIEWED)) expect(why.length, f).toBeGreaterThan(10);
  });
});
