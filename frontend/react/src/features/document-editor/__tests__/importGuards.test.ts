/**
 * UX_UPGRADE-document-editor DOC-G1 + DOC-G2 — the .docx import's two decisions.
 */
import { describe, it, expect } from 'vitest';
import { importWarningsOf, importWouldDestroyContent } from '../importGuards.js';

describe('DOC-G2 — confirm only when there is something to lose', () => {
  it('a document with content would be destroyed', () => {
    expect(importWouldDestroyContent('Quarterly plan')).toBe(true);
  });

  it('an empty or whitespace-only document would not', () => {
    // The common path is importing INTO a fresh document; a confirmation there
    // is noise, and noise is how confirmations stop being read.
    expect(importWouldDestroyContent('')).toBe(false);
    expect(importWouldDestroyContent('   \n\t ')).toBe(false);
  });
});

describe('DOC-G1 — the conversion messages the client used to drop', () => {
  it('returns the messages the route serialized', () => {
    expect(importWarningsOf({ html: '<p/>', warnings: ['Unrecognised paragraph style: Caption', 'An image was dropped'] }))
      .toEqual(['Unrecognised paragraph style: Caption', 'An image was dropped']);
  });

  it('de-duplicates — mammoth emits one message per OCCURRENCE', () => {
    // A table-heavy file repeats the same sentence dozens of times; a raw list
    // would bury the one message that differs.
    const many = Array.from({ length: 40 }, () => 'Unrecognised paragraph style: Caption');
    expect(importWarningsOf({ warnings: [...many, 'An image was dropped'] }))
      .toEqual(['Unrecognised paragraph style: Caption', 'An image was dropped']);
  });

  it('is empty for a clean import — no warning must be shown', () => {
    expect(importWarningsOf({ html: '<p/>', warnings: [] })).toEqual([]);
    expect(importWarningsOf({ html: '<p/>' })).toEqual([]);
  });

  it('survives a malformed or absent payload rather than throwing mid-import', () => {
    // The import has ALREADY replaced the document by this point; throwing here
    // would report a failure for work that succeeded.
    expect(importWarningsOf(null)).toEqual([]);
    expect(importWarningsOf(undefined)).toEqual([]);
    expect(importWarningsOf({ warnings: 'not an array' })).toEqual([]);
    expect(importWarningsOf({ warnings: [1, null, 'real', '  '] })).toEqual(['real']);
  });
});
