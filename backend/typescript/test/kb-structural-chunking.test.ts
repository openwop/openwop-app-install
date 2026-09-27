/**
 * ADR 0398 Phase 1 — structural, heading-aware chunking.
 *
 * Pins: the chunker segments on markdown headings (never orphaning a heading from its
 * body, never straddling two sections), stays DETERMINISTIC (same text → same chunks, so
 * hydrate re-chunk matches ingest), carries the section's `headingPath` intrinsically, and
 * `chunkText` is a faithful projection of `chunkStructured`. Plus an end-to-end proof that
 * a search hit surfaces the populated `headingPath` (was hardcoded `[]`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { chunkStructured, chunkText, CHUNKER_VERSION, createCollection, ingestDocument, search } from '../src/features/kb/kbService.js';

const HEADED = [
  '# Onboarding',
  'New hires complete setup in the first week.',
  '## First Week',
  'Account setup, security training, and a buddy assignment.',
  '# Time Off',
  'Paid time off accrues monthly and is requested two weeks ahead.',
].join('\n');

describe('chunkStructured (ADR 0398 P1)', () => {
  it('is deterministic — same text yields identical chunks', () => {
    expect(chunkStructured(HEADED)).toEqual(chunkStructured(HEADED));
  });

  it('chunkText is exactly the chunk texts of chunkStructured', () => {
    expect(chunkText(HEADED)).toEqual(chunkStructured(HEADED).map((c) => c.text));
  });

  it('carries the nested headingPath per section', () => {
    const chunks = chunkStructured(HEADED);
    const firstWeek = chunks.find((c) => c.text.includes('buddy assignment'));
    expect(firstWeek?.headingPath).toEqual(['Onboarding', 'First Week']); // nesting chain
    const timeOff = chunks.find((c) => c.text.includes('accrues monthly'));
    expect(timeOff?.headingPath).toEqual(['Time Off']); // a new level-1 pops the stack
  });

  it('never orphans a heading — the heading line rides with its section body', () => {
    const chunks = chunkStructured(HEADED);
    const onboarding = chunks.find((c) => c.headingPath[0] === 'Onboarding' && c.headingPath.length === 1);
    expect(onboarding?.text).toContain('# Onboarding');
    expect(onboarding?.text).toContain('first week');
  });

  it('a heading-less document is one section with an empty headingPath', () => {
    const chunks = chunkStructured('Just a paragraph with no headings at all.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toEqual([]);
  });

  it('a section longer than the window sub-splits, all pieces sharing the headingPath', () => {
    const long = `# Big Section\n${'sentence. '.repeat(400)}`; // > chunkChars → multiple windows
    const chunks = chunkStructured(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.headingPath[0] === 'Big Section')).toBe(true);
  });

  it('normalizes CRLF before the ^-anchored heading regex', () => {
    const crlf = '# Title\r\nBody line one.\r\n## Sub\r\nBody two.';
    const chunks = chunkStructured(crlf);
    expect(chunks.some((c) => c.headingPath.includes('Title'))).toBe(true);
    expect(chunks.some((c) => c.headingPath.includes('Sub'))).toBe(true);
  });

  it('exports a chunker version > 1 (folded into the vector signature)', () => {
    expect(CHUNKER_VERSION).toBeGreaterThan(1);
  });
});

describe('headingPath end-to-end (ADR 0398 P1)', () => {
  const tenantId = 'tenant-chunk';
  const orgId = 'org-chunk';
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbchunk-')) });
    initHostExtPersistence(await openStorage('memory://'));
  });

  it('a search hit surfaces the section heading path (was hardcoded [])', async () => {
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Handbook' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Handbook', text: HEADED });
    const hits = await search(tenantId, orgId, col.collectionId, 'buddy assignment security training', 5, 'hybrid');
    const top = hits.find((h) => h.text.includes('buddy assignment'));
    expect(top).toBeTruthy();
    expect(top!.headingPath).toEqual(['Onboarding', 'First Week']);
  });
});
