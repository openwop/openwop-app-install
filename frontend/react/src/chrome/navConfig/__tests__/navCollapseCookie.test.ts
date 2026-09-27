import { describe, it, expect, beforeEach } from 'vitest';
import { readExpandedHeaders, writeExpandedHeaders, toggleExpandedHeader } from '../navCollapseCookie.js';

function clearCookies(): void {
  for (const row of document.cookie.split('; ')) {
    const name = row.split('=')[0];
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

describe('navCollapseCookie', () => {
  beforeEach(clearCookies);

  it('defaults to only Workspace expanded when no cookie is set', () => {
    expect(readExpandedHeaders()).toEqual(new Set(['Workspace']));
  });

  it('ignores the legacy collapsed-ids cookie (default still applies)', () => {
    document.cookie = 'openwop.nav.collapsed=Platform%2COperations; path=/';
    expect(readExpandedHeaders()).toEqual(new Set(['Workspace']));
  });

  it('round-trips a set of header ids', () => {
    writeExpandedHeaders(new Set(['Platform', 'Operations']));
    expect(readExpandedHeaders()).toEqual(new Set(['Platform', 'Operations']));
  });

  it('an explicit empty set sticks (collapsing the default does not resurrect it)', () => {
    writeExpandedHeaders(new Set());
    expect(readExpandedHeaders().size).toBe(0);
  });

  it('toggles a header on and off (first toggle starts from the default set)', () => {
    expect(toggleExpandedHeader('Platform')).toEqual(new Set(['Workspace', 'Platform']));
    expect(readExpandedHeaders().has('Platform')).toBe(true);
    expect(toggleExpandedHeader('Platform')).toEqual(new Set(['Workspace']));
    expect(readExpandedHeaders().has('Platform')).toBe(false);
  });

  it('collapsing the default Workspace group persists', () => {
    expect(toggleExpandedHeader('Workspace')).toEqual(new Set());
    expect(readExpandedHeaders().size).toBe(0);
  });

  it('encodes ids safely (round-trips an id with separators)', () => {
    writeExpandedHeaders(new Set(['Access & data']));
    expect(readExpandedHeaders()).toEqual(new Set(['Access & data']));
  });
});
