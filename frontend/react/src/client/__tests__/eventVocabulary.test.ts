import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  RENAMED_EVENT_TYPE_COUNT,
  toClientEvent,
  toClientEventType,
  toWireEventType,
} from '../eventVocabulary.js';
import { EVENT_CODEMAP_CORPUS_TAG } from '../eventCodemap.generated.js';

/**
 * ADR 0647 correction (2026-09-10): the SPA polls under major 2 but speaks the
 * v1 event dialect. These legs pin (1) that the seam is derived from the SAME
 * vendored codemap the backend uses, (2) that every renamed row round-trips,
 * and (3) the guard that caught nothing before — the SPA's own literals are
 * v1 spellings that the codemap knows, and it references no v2 spelling
 * (a v2 literal would mean a consumer bypassed the seam).
 */

const REPO_ROOT = join(process.cwd(), '..', '..');
const CODEMAP = join(REPO_ROOT, 'schemas', 'v2', 'event-codemap.json');

interface Row { v1: string; v2: string }
function codemapRows(): Row[] {
  return (JSON.parse(readFileSync(CODEMAP, 'utf8')) as { rows: Row[] }).rows;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('event vocabulary seam — derived from schemas/v2/event-codemap.json', () => {
  it('translates exactly the renamed rows of the vendored codemap (non-vacuous)', () => {
    const renamed = codemapRows().filter((r) => r.v1 !== r.v2);
    expect(renamed.length).toBeGreaterThan(0);
    expect(RENAMED_EVENT_TYPE_COUNT).toBe(renamed.length);
  });

  it('the generated pairs are stamped with the vendored CORPUS_TAG (a re-vendor without regeneration is a red test, not a silent drift)', () => {
    const tag = readFileSync(join(REPO_ROOT, 'schemas', 'CORPUS_TAG'), 'utf8').trim();
    expect(EVENT_CODEMAP_CORPUS_TAG).toBe(tag);
  });

  it('every renamed row round-trips in both directions; identity and unknown types pass through', () => {
    for (const r of codemapRows()) {
      expect(toClientEventType(r.v2)).toBe(r.v1);
      expect(toWireEventType(r.v1)).toBe(r.v2);
    }
    expect(toClientEventType('node.completed')).toBe('node.completed');
    expect(toClientEventType('openwop-app.vendor.thing')).toBe('openwop-app.vendor.thing');
  });

  it('toClientEvent rewrites only the top-level type and returns the same object when nothing changes', () => {
    const same = { type: 'node.completed', payload: { type: 'agent.tool-called' } };
    expect(toClientEvent(same)).toBe(same);
    const wire = { eventId: 'e1', type: 'agent.tool-called', payload: { type: 'agent.tool-called' } };
    const client = toClientEvent(wire);
    expect(client.type).toBe('agent.toolCalled');
    expect(client.payload.type).toBe('agent.tool-called'); // payload is opaque to the codemap
    const typeless: { type?: string; payload: Record<string, never> } = { payload: {} };
    expect(toClientEvent(typeless)).toEqual({ payload: {} });
  });

  it('the SPA branches on v1 spellings only — no consumer references a v2 spelling (it would have bypassed the seam)', () => {
    const rows = codemapRows().filter((r) => r.v1 !== r.v2);
    const v1 = new Set(rows.map((r) => r.v1));
    const v2 = new Set(rows.map((r) => r.v2));
    const referencedV1 = new Set<string>();
    const referencedV2: string[] = [];
    for (const file of walk(join(process.cwd(), 'src'))) {
      if (file.endsWith(join('client', 'eventVocabulary.ts')) || file.endsWith(join('client', 'eventCodemap.generated.ts'))) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/['"`]([a-zA-Z][a-zA-Z0-9.-]*)['"`]/g)) {
        const lit = m[1]!;
        if (v1.has(lit)) referencedV1.add(lit);
        if (v2.has(lit)) referencedV2.push(`${file.slice(process.cwd().length + 1)}: ${lit}`);
      }
    }
    // Non-vacuous: the panels this seam exists for really do branch on renamed types.
    expect(referencedV1.size).toBeGreaterThanOrEqual(5);
    expect(referencedV1.has('agent.toolCalled')).toBe(true);
    expect(referencedV2).toEqual([]);
  });
});
