/**
 * FP-5 (CODEBASE-ASSESSMENT.md): the CMS markdown renderer's open-redirect /
 * unsafe-scheme guard had no test. SectionRenderer's `isSafeHref` / `isInternal`
 * are internal, so this exercises them through the RENDERED output: a public
 * `richText` section whose body carries `[label](url)` markdown links. The
 * content-safety posture (ADR 0009) is: http(s)/mailto → an external <a>; an
 * internal `/path` → a router <Link>; anything else (javascript:, a
 * protocol-relative `//evil`, a `/\` backslash escape) DEGRADES to plain text.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

/** A public `richText` section whose prose is the given markdown string. */
function richTextSection(text: string): Section {
  return { sectionId: 's1', type: 'richText', data: { text } };
}

function renderMarkdown(text: string) {
  return render(
    <MemoryRouter>
      <RenderSection section={richTextSection(text)} mode="public" />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('SectionRenderer markdown safe-href guard (ADR 0009 / FP-5)', () => {
  it('renders an https: link as an external anchor (href + noopener rel)', () => {
    renderMarkdown('Visit [the docs](https://openwop.dev/docs) today.');
    const a = screen.getByRole('link', { name: 'the docs' });
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('https://openwop.dev/docs');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('renders an http: link as an external anchor', () => {
    renderMarkdown('See [legacy](http://example.com/old).');
    const a = screen.getByRole('link', { name: 'legacy' });
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('http://example.com/old');
  });

  it('renders a mailto: link as an anchor', () => {
    renderMarkdown('Email [us](mailto:hi@openwop.dev).');
    const a = screen.getByRole('link', { name: 'us' });
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('mailto:hi@openwop.dev');
  });

  it('renders an internal /path link as a router Link anchor (relative href, no scheme)', () => {
    renderMarkdown('Go to [agents](/agents) now.');
    const a = screen.getByRole('link', { name: 'agents' });
    expect(a.tagName).toBe('A');
    // react-router renders an in-app <Link> as an anchor with the bare path.
    expect(a.getAttribute('href')).toBe('/agents');
  });

  it('degrades a javascript: scheme to plain text — NO anchor', () => {
    renderMarkdown('Danger [click me](javascript:alert(1)) here.');
    // The label survives as text, but it is NOT rendered as a link.
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/click me/)).toBeTruthy();
  });

  it('degrades a protocol-relative //evil URL to plain text (open-redirect shape)', () => {
    renderMarkdown('Bad [go](//evil.example.com) link.');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/go/)).toBeTruthy();
  });

  it('degrades a /\\ backslash-escaped path to plain text (normalizes to external)', () => {
    renderMarkdown('Bad [home](/\\evil.example.com) link.');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/home/)).toBeTruthy();
  });

  it('renders the safe and unsafe links side-by-side correctly', () => {
    const { container } = renderMarkdown(
      'A [safe](https://ok.example) and an [unsafe](javascript:void(0)) link.',
    );
    // Exactly one anchor (the safe one); the unsafe label is inert text.
    const links = within(container).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://ok.example');
    expect(screen.getByText(/unsafe/)).toBeTruthy();
  });
});
