/**
 * ADR 1136 D8 — `shownUrl`, the one rule for how a URL leaves a session row:
 * origin and path only, since a query string or fragment can carry typed text.
 */
import { describe, it, expect } from 'vitest';
import { shownUrl } from '../src/features/computer-use/shownUrl.js';

describe('shownUrl', () => {
  it('keeps origin and path, drops query and fragment', () => {
    expect(shownUrl('https://a.example/x/y?q=secret#frag')).toBe('https://a.example/x/y');
    expect(shownUrl('http://a.example:8080/?y=1')).toBe('http://a.example:8080/');
  });
  it('omits a non-web or unparsable URL instead of passing it through', () => {
    expect(shownUrl('javascript:alert(1)')).toBeUndefined();
    expect(shownUrl('data:text/html,hi')).toBeUndefined();
    expect(shownUrl('not a url')).toBeUndefined();
    expect(shownUrl(undefined)).toBeUndefined();
  });
});
