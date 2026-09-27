/**
 * WFMC-1 — the canvas and workflow collab lanes SHARE one room map, and only the
 * workflow side is namespaced: `collabServer.ts:368` builds
 * `kind === 'workflow-collab' ? \`wf:${resourceId}\` : resourceId`. So a canvas
 * whose id literally began `wf:` would land on the SAME room key as the workflow
 * of the remaining id — two different resources co-editing one CRDT document.
 *
 * `WORKFLOW_ID_PATTERN` permits `:`, so the hazard is not hypothetical at the
 * grammar level. What makes it unreachable is that canvas ids are SERVER-MINTED
 * with a `canvas-` prefix — a protection by CONSTRUCTION that, before this file,
 * nothing asserted. That is the failure mode this session keeps finding: a
 * protection provided by never doing something passes every test whether or not
 * it still holds. Change the mint (or accept a client-supplied canvas id) and the
 * collision becomes live with no test to notice.
 *
 * These legs pin the property, not the prose.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { WORKFLOW_ID_PATTERN } from '../src/host/workflowDefinitionValidation.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const T = 'tRoomNs';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('WFMC-1 — a canvas can never mint into the wf: room namespace', () => {
  it('a freshly created canvas id is `canvas-`-prefixed, on BOTH the plain and idempotent paths', async () => {
    const plain = await createCanvasForTenant(T, { canvasTypeId: 'canvas.document', name: 'A' });
    const idem = await createCanvasForTenant(T, { canvasTypeId: 'canvas.document', name: 'B', idempotencyKey: 'k1' });
    for (const [label, rec] of [['plain', plain], ['idempotent', idem]] as const) {
      expect(rec.canvasId.startsWith('canvas-'), `${label}: ${rec.canvasId}`).toBe(true);
      expect(rec.canvasId.startsWith('wf:'), `${label} must not enter the workflow namespace`).toBe(false);
    }
    // The idempotent path must REPLAY the same row rather than mint a second id.
    const again = await createCanvasForTenant(T, { canvasTypeId: 'canvas.document', name: 'B', idempotencyKey: 'k1' });
    expect(again.canvasId).toBe(idem.canvasId);
  });

  it('the create route accepts no caller-supplied canvasId (the only way to choose one)', () => {
    const routes = readFileSync(join(SRC, 'features', 'canvasEditorRoutes.ts'), 'utf8');
    // Both markers must be the ROUTE REGISTRATIONS, not the bare paths: the paths
    // also appear in the file's docblock at the top, and anchoring the end marker
    // there put it BEFORE the start marker, silently yielding an empty slice.
    const from = routes.indexOf("app.post(`${ORG}/canvases`");
    const to = routes.indexOf("app.post(`${ORG}/canvases/from-artifact`");
    expect(from, 'the create arm must be located').toBeGreaterThan(-1);
    expect(to, 'the from-artifact arm must be located AFTER it').toBeGreaterThan(from);
    const createArm = routes.slice(from, to);
    expect(createArm.length, 'a non-empty arm, or this leg is vacuous').toBeGreaterThan(200);
    expect(createArm).not.toMatch(/body\.canvasId/);
  });

  it('EVERY canvas-id mint in canvasSurface is the `canvas-` literal (the class, not one site)', () => {
    const surface = readFileSync(join(SRC, 'host', 'canvasSurface.ts'), 'utf8');
    const mints = surface.match(/canvasId:\s*`[^`]*`/g) ?? [];
    expect(mints.length, 'there must be mint sites to check — a zero here would be a broken search').toBeGreaterThan(0);
    for (const m of mints) expect(m, m).toContain('`canvas-');
  });

  it('the one-sided namespacing is still what makes the prefix load-bearing', () => {
    const server = readFileSync(join(SRC, 'host', 'collab', 'collabServer.ts'), 'utf8');
    // workflow rooms prefixed, canvas rooms RAW — if this ever became two-sided the
    // legs above would be belt-and-braces rather than the actual guard.
    expect(server).toMatch(/kind === 'workflow-collab' \? `wf:\$\{resourceId\}` : resourceId/);
  });

  it('control: the workflow id grammar PERMITS `:`, so the hazard is real at the grammar level', () => {
    expect(WORKFLOW_ID_PATTERN.test('wf:something')).toBe(true);
    expect(WORKFLOW_ID_PATTERN.test('plain-id')).toBe(true);
    // ...and a `canvas-`-prefixed id is a legal workflow id too, which is why the
    // guard has to be the canvas prefix and not some property of the grammar.
    expect(WORKFLOW_ID_PATTERN.test('canvas-2f1c')).toBe(true);
  });
});
