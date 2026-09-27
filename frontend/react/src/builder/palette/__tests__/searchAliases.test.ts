/**
 * Brand-alias search expansion (day-1 UX P4 / B2) — pins the recall contract:
 * brand tokens expand to capability terms, the raw query always stays a match
 * term, non-brand queries expand to themselves only.
 */
import { describe, expect, it } from 'vitest';

import { expandQuery } from '../searchAliases.js';

describe('expandQuery', () => {
  it('expands a brand token and reports it', () => {
    const { terms, brands } = expandQuery('Gmail');
    expect(terms[0]).toBe('gmail'); // raw query kept first
    expect(terms).toContain('email');
    expect(brands).toEqual(['gmail']);
  });

  it('expands brand tokens inside a longer query', () => {
    const { terms, brands } = expandQuery('outlook send');
    expect(terms).toContain('outlook send'); // the raw phrase still matches
    expect(terms).toContain('email');
    expect(brands).toEqual(['outlook']);
  });

  it('leaves non-brand queries untouched', () => {
    const { terms, brands } = expandQuery('http request');
    expect(terms).toEqual(['http request']);
    expect(brands).toEqual([]);
  });

  it('empty query expands to nothing', () => {
    expect(expandQuery('   ')).toEqual({ terms: [], brands: [] });
  });
});
