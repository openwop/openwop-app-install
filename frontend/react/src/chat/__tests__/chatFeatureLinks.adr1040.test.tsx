/**
 * ADR 1040 D7 F4 (Book AI P47) — feature links in assistant markdown.
 *
 * A registered scheme's link becomes an IN-APP router link only when the
 * feature's resolver answers, for this viewer, with a same-origin path. Every
 * refusal renders the link text as plain text (no anchor at all):
 *   unregistered scheme · resolver returns null · resolver throws ·
 *   `javascript:` · `data:` · `https://evil.com` · `//evil.com` · `/\evil.com` ·
 *   a backslash anywhere · a control character · a relative path.
 * Ordinary `https` links are unchanged (a new tab). Registration refuses the
 * browser's own and dangerous schemes.
 *
 * Not witnessed here (stated): the link is handed the NORMALIZED path, but
 * react-router's <Link> resolves dot segments itself, so passing the raw string
 * instead stays green; the `//` refusal after normalization is what matters,
 * and that is witnessed (the dot-segment cases).
 *
 * Double guard (stated, measured): `//evil.com` is refused both by the
 * `startsWith('//')` check and by the same-origin `URL` check, so removing
 * either ONE alone stays green; removing both reds the protocol-relative case.
 *
 * Red when: MessageRenderer stops routing registered schemes through
 * `ChatFeatureLink`, or `isSafeInAppPath` (chat/lib/chatLinkResolvers.ts) drops
 * any of its checks, or `chatUrlTransform` keeps unregistered schemes.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MessageRenderer } from '../MessageRenderer.js';
import { __unregisterChatLinkResolver, registerChatLinkResolver, isSafeInAppPath } from '../lib/chatLinkResolvers.js';

let answer: () => unknown = () => '/books/123';
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  answer = () => '/books/123';
  registerChatLinkResolver('bookai', async (id) => { asked.push(id); return answer() as string | null; });
});
afterEach(() => { cleanup(); __unregisterChatLinkResolver('bookai'); });

async function show(md: string) {
  const r = render(<MemoryRouter><MessageRenderer content={md} markdown /></MemoryRouter>);
  await act(async () => { for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0)); });
  return r;
}

describe('feature links', () => {
  it('a resolved link is an in-app link to the resolver\'s route, not a new tab', async () => {
    const { container } = await show('See [your draft](bookai:book/123).');
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('/books/123');
    expect(a?.getAttribute('target')).toBeNull();
    expect(a?.textContent).toBe('your draft');
    expect(asked).toEqual(['book/123']);
  });

  it('`scheme://id` resolves the same id', async () => {
    await show('[x](bookai://book/9)');
    expect(asked).toEqual(['book/9']);
  });

  const refused: Array<[string, () => unknown]> = [
    ['null', () => null],
    ['a throw', () => { throw new Error('boom'); }],
    ['javascript:', () => 'javascript:alert(1)'],
    ['data:', () => 'data:text/html,<script>alert(1)</script>'],
    ['an external URL', () => 'https://evil.com/x'],
    ['a protocol-relative URL', () => '//evil.com/x'],
    ['a backslash host', () => '/\\evil.com'],
    ['a backslash anywhere', () => '/books\\..\\x'],
    ['a control character', () => '/books/\n1'],
    ['a relative path', () => 'books/123'],
    ['a dot-segment escape to //', () => '/..//evil.com/x'],
    ['a dot-slash escape to //', () => '/.//evil.com'],
    ['a non-string', () => 42],
  ];
  for (const [what, fn] of refused) {
    it(`refuses ${what}: the link text stays plain text`, async () => {
      answer = fn;
      const { container } = await show('See [your draft](bookai:book/123).');
      expect(container.querySelector('a')).toBeNull();
      expect(screen.getByText('your draft')).toBeTruthy();
    });
  }

  it('an unregistered scheme is blanked by the default sanitizer and never resolved', async () => {
    const { container } = await show('[x](other:thing/1)');
    expect(container.querySelector('a')?.getAttribute('href') ?? '').toBe('');
    expect(asked).toEqual([]);
  });

  it('ordinary https links are unchanged (new tab)', async () => {
    const { container } = await show('[docs](https://example.com/a)');
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/a');
    expect(a?.getAttribute('target')).toBe('_blank');
  });

  it('registration refuses the browser\'s own and dangerous schemes, and duplicates', () => {
    for (const s of ['javascript', 'data', 'http', 'https', 'mailto', 'file', 'BAD', 'x']) {
      expect(() => registerChatLinkResolver(s, () => null), s).toThrow();
    }
    expect(() => registerChatLinkResolver('bookai', () => null)).toThrow(/already registered/);
  });

  it('isSafeInAppPath accepts plain app paths', () => {
    for (const p of ['/books/123', '/books/123?tab=notes#ch-2', '/']) expect(isSafeInAppPath(p), p).toBe(true);
  });
});
