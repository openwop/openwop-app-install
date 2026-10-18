/**
 * ADR 0886 D1 — the canvas WRITE-gate ratchet.
 *
 * Every lane that writes a `host.canvas` row must decide the write in the
 * canvas OWNER's org (`canvasWriteAllowed` / `getCanvasForWriter`, the run
 * lane's `assertCanvasRunAccess(…, 'write')`, or the editor factory's
 * `loadCanvas(…, 'write')`). Before ADR 0886 every lane asked the READ question,
 * so a writer in org A wrote org B's project canvases through org A's door.
 *
 * Three pins, all derived from the CALLS (comments stripped), not the imports:
 *  1. per file, the exact number of `updateCanvasForTenant(` /
 *     `deleteCanvasForTenant(` / `restoreCanvasVersion(` calls, with the gate
 *     that file is reviewed to use. A NEW call in a reviewed file changes the
 *     count and fails here until someone reviews its gate; a new FILE fails
 *     because it is not listed.
 *  2. per file, the ordered `need` of every `loadCanvas(…, 'read'|'write')` call
 *     in the editor factory and its `extraRoutes`. Flipping a write verb to
 *     `'read'` fails here; a non-literal `need` fails too.
 *  3. per file, the number of `canvasWriteAllowed(` / `getCanvasForWriter(`
 *     calls — the lanes that write WITHOUT a mutator call (share mint, collab
 *     joins, the present remote) are pinned here (SL2CD-3).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Comments out, so a call named in prose is never counted (or hidden). */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MUTATOR = /\b(updateCanvasForTenant|deleteCanvasForTenant|restoreCanvasVersion)\(/g;
const DEFINITION = /export\s+async\s+function\s+(updateCanvasForTenant|deleteCanvasForTenant|restoreCanvasVersion)\(/g;

/** file → [mutator call count, the gate the file is reviewed to use]. A gate
 *  starting `system:` is a lane with no human caller to gate (a cascade, a
 *  retention sweep, a seed) or one gated upstream; its reason is the review. */
const REVIEWED: Record<string, [number, string]> = {
  'features/canvasEditorRoutes.ts': [3, "loadCanvas(tenantId, req.params.canvasId, user.userId, 'write')"],
  'host/canvasSurface.ts': [2, "assertCanvasRunAccess(scope, await load(canvasId), 'write')"],
  'host/dataBinding.ts': [1, "assertCanvasRunAccess(scope, canvas, 'write')"],
  'features/slides/agentTools.ts': [1, 'canvasWriteAllowed('],
  'features/drawings/agentTools.ts': [1, 'canvasWriteAllowed('],
  'features/cad/agentTools.ts': [1, 'canvasWriteAllowed('],
  'features/campaign-studio/agentTools.ts': [1, 'canvasWriteAllowed('],
  'features/app-builder/surface.ts': [1, 'canvasWriteAllowed('],
  'features/documents/routes.ts': [1, 'canvasWriteAllowed('],
  'routes/uiPlugins.ts': [1, 'canvasWriteAllowed('],
  'host/collab/collabRoom.ts': [1, 'system:the room derive — the JOIN is the write gate (collabServer assertCollabWrite + the cookie-lane check, ADR 0886 D2)'],
  'features/app-builder/canvasRetention.ts': [1, 'system:retention sweep of abandoned transient canvases'],
  'features/kicktodo-creator/candidateDeathSubscribers.ts': [1, 'system:lifecycle cascade when the owning candidate is deleted'],
  'features/projects/feature.ts': [1, 'system:the project-deletion cascade (ADR 0839 D2)'],
  'host/demoAppBuilderSeed.ts': [1, 'system:demo seed reset of its own deterministic ids'],
};

/** file → the ordered `need` of each `loadCanvas(` call. */
const LOAD_NEEDS: Record<string, string[]> = {
  // present-remote, get, PATCH, DELETE, versions, version, restore
  'features/canvasEditorRoutes.ts': ['write', 'read', 'write', 'write', 'read', 'read', 'write'],
  // export(write scope), exports list, publish, sync-binding PUT, GET, DELETE, sync
  'features/app-builder/routes.ts': ['write', 'read', 'write', 'write', 'read', 'write', 'write'],
  'features/cad/routes.ts': ['read', 'read'],
  'features/slides/routes.ts': ['read'],
  'features/document-editor/routes.ts': ['read'],
};

/** SL2CD-3 — file → the number of WRITE-PREDICATE calls it makes. The mutator
 *  pin above cannot see lanes that write by OTHER means (a public share link, a
 *  live collab room, a present remote's control channel); removing the gate
 *  from any of them changes this count. */
const WRITE_PREDICATE = /\b(canvasWriteAllowed|getCanvasForWriter)\(/g;
const WRITE_PREDICATE_DEF = /export\s+async\s+function\s+(canvasWriteAllowed|getCanvasForWriter)\(/g;
const PREDICATE_CALLS: Record<string, number> = {
  'host/canvasSurface.ts': 2, // getCanvasForWriter's own call + assertCanvasRunAccess('write')
  'features/canvasEditorRoutes.ts': 2, // loadCanvas(…, 'write') + the GET's view-only answer
  'features/sharing/sharingService.ts': 1, // ADR 0887 D1: `canvasEntitlement`, shared by app_builder_canvas + slides_canvas (mint AND the per-read publisher re-check)
  'host/collab/collabServer.ts': 2, // ticket/claim-seed (assertCollabWrite) + the cookie WS lane
  'routes/presentRemote.ts': 1, // authorizePresentRemote
  'routes/uiPlugins.ts': 1,
  'features/slides/agentTools.ts': 1,
  'features/drawings/agentTools.ts': 1,
  'features/cad/agentTools.ts': 1,
  'features/campaign-studio/agentTools.ts': 1,
  'features/app-builder/surface.ts': 1,
  'features/documents/routes.ts': 1,
};

describe('ADR 0886 D1 — every canvas write lane is pinned to a write gate', () => {
  const files = walk(SRC);

  it('every file that writes a canvas is reviewed, with its exact call count and its gate present', () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      const src = code(f);
      const n = (src.match(MUTATOR)?.length ?? 0) - (src.match(DEFINITION)?.length ?? 0);
      if (n > 0) found[relative(SRC, f)] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(REVIEWED).map(([f, [n]]) => [f, n])));
    for (const [f, [, gate]] of Object.entries(REVIEWED)) {
      if (gate.startsWith('system:')) continue;
      expect(code(join(SRC, f)), `${f} must use ${gate}`).toContain(gate);
    }
  });

  it("every editor-factory loadCanvas call states a LITERAL need, and write verbs say 'write'", () => {
    const found: Record<string, string[]> = {};
    for (const f of files) {
      const src = code(f);
      const needs = [...src.matchAll(/\bloadCanvas\([^)]*?,\s*'(read|write)'\)/g)].map((m) => m[1]!);
      // A non-literal `need` (a variable) is invisible to the pin — refuse it.
      const calls = [...src.matchAll(/\bloadCanvas\(/g)].length
        - [...src.matchAll(/async function loadCanvas\(/g)].length;
      expect(calls, `${relative(SRC, f)}: every loadCanvas call must pass a literal 'read' | 'write'`).toBe(needs.length);
      if (needs.length) found[relative(SRC, f)] = needs;
    }
    expect(found).toEqual(LOAD_NEEDS);
  });

  it('every lane that writes by other means keeps its write-predicate calls (SL2CD-3)', () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      const src = code(f);
      const n = (src.match(WRITE_PREDICATE)?.length ?? 0) - (src.match(WRITE_PREDICATE_DEF)?.length ?? 0);
      if (n > 0) found[relative(SRC, f)] = n;
    }
    expect(found).toEqual(PREDICATE_CALLS);
  });
});
