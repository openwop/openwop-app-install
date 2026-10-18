/**
 * ADR 0359 Phase 5 — the FE↔backend collab-registration drift pin. Every
 * first-party canvas type that registers `collab: true` on the backend
 * (`registerCanvasEditorRoutes` cfg) MUST declare the matching chassis binding
 * kind here, and vice versa — a one-sided flip means either a socket that 404s
 * a provisioning chassis, or a chassis that never provisions a served room.
 * The backend twin lives in backend/typescript/test/collab-authboundary.test.ts
 * (registry parity). Pack types are deliberately absent (v1 exclusion).
 *
 * Both sides are DERIVED, not hand-listed (/grade-tests w46): the FE set is every
 * definition under `features/*\/definition.tsx` that declares `collab` (and a
 * source scan proves no `collab:` declaration lives anywhere else), the backend
 * set is read from the backend route sources. A new collab type on EITHER side
 * reds the set-equality leg; the pinned kind map reds a kind flip.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';
import { slidesDefinition } from '../../features/slides/definition.js';

const FRONTEND_SRC = join(process.cwd(), 'src'); // vitest runs from frontend/react
const BACKEND_FEATURES = join(process.cwd(), '..', '..', 'backend', 'typescript', 'src', 'features');

/** Every FE canvas definition module (the SOURCE OF TRUTH the chassis reads). */
const definitionModules = import.meta.glob<Record<string, unknown>>('../../features/*/definition.tsx', { eager: true });

function feCollabKinds(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mod of Object.values(definitionModules)) {
    for (const exp of Object.values(mod)) {
      if (!exp || typeof exp !== 'object') continue;
      const def = exp as { canvasTypeId?: unknown; collab?: unknown };
      if (typeof def.canvasTypeId === 'string' && def.collab !== undefined) out[def.canvasTypeId] = def.collab;
    }
  }
  return out;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, files); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
  }
  return files;
}

/** Resolve `canvasTypeId: <expr>` — a string literal, or an imported const. */
function resolveTypeId(expr: string, file: string): string {
  const lit = /^'([^']+)'$/.exec(expr);
  if (lit) return lit[1]!;
  const src = readFileSync(file, 'utf8');
  const imp = new RegExp(`import\\s*\\{[^}]*\\b${expr}\\b[^}]*\\}\\s*from\\s*'([^']+)'`).exec(src);
  if (!imp) throw new Error(`cannot resolve ${expr} in ${file}`);
  const target = join(dirname(file), imp[1]!.replace(/\.js$/, '.ts'));
  const def = new RegExp(`export const ${expr}\\s*=\\s*'([^']+)'`).exec(readFileSync(target, 'utf8'));
  if (!def) throw new Error(`cannot find export const ${expr} in ${target}`);
  return def[1]!;
}

/** Backend `registerCanvasEditorRoutes` calls whose TOP-LEVEL cfg says `collab: true`. */
function backendCollabTypeIds(): string[] {
  const ids: string[] = [];
  for (const file of walk(BACKEND_FEATURES)) {
    const src = readFileSync(file, 'utf8');
    const calls = [...src.matchAll(/^( *)registerCanvasEditorRoutes\(deps, \{$/gm)];
    calls.forEach((m, i) => {
      const indent = m[1]!.length + 2; // the cfg's own top-level property indent
      const end = calls[i + 1]?.index ?? src.length;
      const chunk = src.slice(m.index, end);
      const prop = (key: string): RegExpExecArray | null => new RegExp(`^ {${indent}}${key}:\\s*([^,\\n]+),`, 'm').exec(chunk);
      const collab = prop('collab');
      if (!collab || collab[1]!.trim() !== 'true') return;
      const typeId = prop('canvasTypeId');
      if (!typeId) throw new Error(`collab: true without a top-level canvasTypeId in ${file}`);
      ids.push(resolveTypeId(typeId[1]!.trim(), file));
    });
  }
  return ids.sort();
}

describe('collab-capable canvas types (ADR 0359 Phase 5)', () => {
  it('pins each first-party type to its binding kind (derived from every FE definition)', () => {
    expect(feCollabKinds()).toEqual({
      'canvas.document': 'document',           // y-prosemirror surface
      'canvas.slides': 'elements',             // frames + tree
      'canvas.app-builder': 'elements',        // frames + tree (+ graph projection)
      'canvas.drawing': 'elements',
      'canvas.cad': 'elements',
      'canvas.campaign': 'elements',
      // ADR 0458 §2.3 — frames (single 'outline') + tree (days/children).
      'canvas.challenge-outline': 'elements',
    });
  });

  it('no collab declaration lives outside the globbed definition modules', () => {
    const declaring = walk(FRONTEND_SRC)
      .filter((f) => /^\s*collab:\s*'(elements|document)'/m.test(readFileSync(f, 'utf8')))
      .map((f) => relative(FRONTEND_SRC, f).split(sep).join('/'))
      .sort();
    const globbed = Object.keys(definitionModules).map((k) => k.replace(/^\.\.\/\.\.\//, '')).sort();
    expect(declaring.length).toBeGreaterThan(0);
    expect(declaring.every((f) => globbed.includes(f))).toBe(true);
  });

  it('the FE collab set equals the backend `collab: true` registrations (both directions)', () => {
    expect(existsSync(BACKEND_FEATURES)).toBe(true);
    const backend = backendCollabTypeIds();
    // Positive control on the parser: it must find real registrations.
    expect(backend.length).toBeGreaterThanOrEqual(7);
    expect(backend.every((id) => id.startsWith('canvas.'))).toBe(true);
    expect(Object.keys(feCollabKinds()).sort()).toEqual(backend);
  });

  it('every elements-kind type has traits the collab shape can bind (frames or elements)', () => {
    const fe = feCollabKinds();
    const defs = Object.values(definitionModules).flatMap((m) => Object.values(m))
      .filter((d): d is { canvasTypeId: string; frames?: { key?: string }; elements?: unknown[] } =>
        !!d && typeof d === 'object' && typeof (d as { canvasTypeId?: unknown }).canvasTypeId === 'string')
      .filter((d) => fe[d.canvasTypeId] === 'elements');
    expect(defs).toHaveLength(6);
    for (const def of defs) {
      const hasFrames = Boolean(def.frames?.key);
      const hasElements = Array.isArray(def.elements) && def.elements.length > 0;
      expect(hasFrames || hasElements, def.canvasTypeId).toBe(true);
    }
  });

  it('slide ids are deterministic across clients: two independent coercions of the SAME raw doc agree', () => {
    // The churn risk is two clients coercing the same RAW doc and minting
    // different ids (a CRDT id war). Pinned literals, not the coercer's output.
    const raw = (): Record<string, unknown> => ({ title: 'T', slides: [{ id: 'slide-7', layout: 'blank' }, { layout: 'blank' }] });
    const ids = (d: object): (string | undefined)[] => ((d as { slides?: { id?: string }[] }).slides ?? []).map((s) => s.id);
    const clientA = slidesDefinition.coerceDoc(raw());
    const clientB = slidesDefinition.coerceDoc(raw());
    expect(ids(clientA)).toEqual(['slide-7', 'slide-2']); // preserved when present; index-derived when absent
    expect(ids(clientB)).toEqual(['slide-7', 'slide-2']);
    // Re-coercing an already-coerced doc keeps them (idempotent).
    expect(ids(slidesDefinition.coerceDoc(Object.fromEntries(Object.entries(clientA))))).toEqual(['slide-7', 'slide-2']);
  });
});
