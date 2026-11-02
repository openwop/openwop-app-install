/**
 * ADR 1018 D1 (`CW68WF-1`) — the embed snippet's `src` must be ABSOLUTE.
 *
 * It is pasted on a customer's site. Production's base is the relative `/api`, and a
 * relative `src` resolves against the customer's origin and 404s, so every snippet the
 * console handed out was dead. Breaks if any base shape the app ships yields a URL
 * whose origin is not the console's, or a doubled slash.
 */
import { describe, it, expect } from 'vitest';
import { embedScriptUrl } from '../../../client/chatWidgetClient.js';

const ORIGIN = 'https://app.openwop.dev';
const PATH = '/host/openwop-app/public/widget/embed.js';

describe('embedScriptUrl (ADR 1018 D1)', () => {
  it('resolves the production relative base against the console origin', () => {
    expect(embedScriptUrl('/api', ORIGIN)).toBe(`${ORIGIN}/api${PATH}`);
  });
  it('drops a trailing slash instead of doubling it', () => {
    expect(embedScriptUrl('/api/', ORIGIN)).toBe(`${ORIGIN}/api${PATH}`);
  });
  it('keeps a versioned base (embed.js strips /vN itself)', () => {
    expect(embedScriptUrl('/api/v1', ORIGIN)).toBe(`${ORIGIN}/api/v1${PATH}`);
  });
  it('leaves an absolute base on its own origin (dev, white-label)', () => {
    expect(embedScriptUrl('http://localhost:8080', ORIGIN)).toBe(`http://localhost:8080${PATH}`);
    expect(embedScriptUrl('https://api.example.com/', ORIGIN)).toBe(`https://api.example.com${PATH}`);
  });
});
