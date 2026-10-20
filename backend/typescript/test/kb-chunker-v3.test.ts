/**
 * ADR 0904 P2 — chunker v3.
 *
 *  - a markdown table is never cut mid-table: the window ends before it or takes it
 *    whole (up to 2× the window), so a retrieved chunk never holds half a table;
 *  - an oversize table splits at ROW boundaries with its header repeated, so each piece
 *    is a readable table on its own;
 *  - text with no table chunks EXACTLY as v2 did — pinned against a copy of the v2
 *    splitter on the eval corpus — so a provider collection's cached vectors (keyed by
 *    chunk id + text hash) stay valid through the CHUNKER_VERSION bump and only
 *    table-bearing documents re-embed.
 * Sabotage: drop the "never cut inside a table" step ⇒ the atomic case is red; drop the
 * header repeat ⇒ the oversize case is red; change the window maths ⇒ the v2 parity case
 * is red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkStructured, CHUNKER_VERSION } from '../src/features/kb/kbService.js';

const here = dirname(fileURLToPath(import.meta.url));
const CHUNK = 1200;
const OVERLAP = 150;

/** The v2 `windowSplit`, verbatim, as the parity reference. */
function v2WindowSplit(sectionBody: string): string[] {
  const clean = sectionBody.trim();
  if (clean.length === 0) return [];
  const out: string[] = [];
  let pos = 0;
  while (pos < clean.length) {
    let end = Math.min(pos + CHUNK, clean.length);
    if (end < clean.length) {
      const windowStart = pos + Math.floor(CHUNK * 0.8);
      const slice = clean.slice(windowStart, end);
      const para = slice.lastIndexOf('\n\n');
      const sent = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
      const space = slice.lastIndexOf(' ');
      const rel = para >= 0 ? para : sent >= 0 ? sent + 1 : space;
      if (rel >= 0) end = windowStart + rel + 1;
    }
    const chunk = clean.slice(pos, end).trim();
    if (chunk.length > 0) out.push(chunk);
    if (end >= clean.length) break;
    pos = Math.max(end - OVERLAP, pos + 1);
  }
  return out;
}

const table = (rows: number, label = 'row') =>
  ['| Item | Detail |', '| --- | --- |', ...Array.from({ length: rows }, (_v, i) => `| ${label} ${i} | value for ${label} number ${i} in the inventory |`)].join('\n');
const prose = (n: number) => 'The warehouse runs two shifts and every shift lead signs the handover log. '.repeat(n).trim();

describe('ADR 0904 P2 — chunker v3', () => {
  it('is version 3', () => { expect(CHUNKER_VERSION).toBe(3); });

  it('never cuts inside a table that fits in two windows', () => {
    const t = table(24); // ~1.3k chars: over one window, under two
    expect(t.length).toBeGreaterThan(CHUNK);
    const text = `${prose(14)}\n\n${t}\n\n${prose(6)}`;
    const chunks = chunkStructured(text).map((c) => c.text);
    const holder = chunks.filter((c) => c.includes('| row 0 |'));
    expect(holder).toHaveLength(1);
    expect(holder[0]).toContain(t);
    for (const c of chunks) {
      const rows = c.split('\n').filter((l) => l.startsWith('| row'));
      expect(rows.length === 0 || rows.length === 24, 'a chunk holds all rows or none').toBe(true);
    }
  });

  it('splits an oversize table at row boundaries with the header repeated', () => {
    const t = table(80); // ~5k chars
    const chunks = chunkStructured(`# Inventory\n\n${t}`).map((c) => c.text);
    const pieces = chunks.filter((c) => c.includes('| row '));
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.startsWith('| Item | Detail |\n| --- | --- |\n')).toBe(true);
      for (const line of p.split('\n')) expect(line.startsWith('|') && line.endsWith('|')).toBe(true);
    }
    const seen = pieces.flatMap((p) => p.split('\n').slice(2));
    expect(seen).toEqual(t.split('\n').slice(2)); // every row once, in order
  });

  it('text without a table chunks exactly as v2 (cached vectors stay valid)', () => {
    const corpus = JSON.parse(readFileSync(join(here, 'fixtures/kb-eval/corpus.json'), 'utf8')) as { documents: Array<{ text: string }> };
    const noTable = corpus.documents.map((d) => d.text).filter((t) => !t.split('\n').some((l) => l.trimStart().startsWith('|')));
    expect(noTable.length, 'fixture: many table-free documents').toBeGreaterThan(50);
    for (const text of [...noTable, prose(80)]) {
      // v2 = heading sections then the window splitter; the v3 output for a table-free
      // body must be identical chunk for chunk.
      const v3 = chunkStructured(text);
      const v2 = v3.length === 0 ? [] : (() => {
        const out: string[] = [];
        // Re-derive section bodies the same way chunkStructured does (headings kept in body).
        const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
        let cur: string[] = [];
        const flush = () => { const b = cur.join('\n').trim(); if (b) out.push(...v2WindowSplit(b)); cur = []; };
        for (const line of lines) { if (/^(#{1,6})[ \t]+(.+?)\s*$/.test(line)) { flush(); cur = [line]; } else cur.push(line); }
        flush();
        return out;
      })();
      expect(v3.map((c) => c.text)).toEqual(v2);
    }
  });
});
