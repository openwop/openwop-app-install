import { describe, it, expect, beforeEach } from 'vitest';
import { readCollapsedHeaders, writeCollapsedHeaders, toggleCollapsedHeader } from '../navCollapseCookie.js';

function clearCookies(): void {
  for (const row of document.cookie.split('; ')) {
    const name = row.split('=')[0];
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

describe('navCollapseCookie', () => {
  beforeEach(clearCookies);

  it('reads an empty set when no cookie is set', () => {
    expect(readCollapsedHeaders().size).toBe(0);
  });

  it('round-trips a set of header ids', () => {
    writeCollapsedHeaders(new Set(['Platform', 'Operations']));
    expect(readCollapsedHeaders()).toEqual(new Set(['Platform', 'Operations']));
  });

  it('toggles a header on and off', () => {
    expect(toggleCollapsedHeader('Platform')).toEqual(new Set(['Platform']));
    expect(readCollapsedHeaders().has('Platform')).toBe(true);
    expect(toggleCollapsedHeader('Platform')).toEqual(new Set());
    expect(readCollapsedHeaders().has('Platform')).toBe(false);
  });

  it('encodes ids safely (round-trips an id with separators)', () => {
    writeCollapsedHeaders(new Set(['Access & data']));
    expect(readCollapsedHeaders()).toEqual(new Set(['Access & data']));
  });
});
