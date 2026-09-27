/**
 * `UPU-1` / `UPU-2` — a third-party plugin surface must fail visibly and locally.
 *
 * UPU-1: an `entryUrl` that never answers used to leave the `aria-busy` spinner up
 * forever — no error, no timeout, nothing to retry. The sibling `IsolationSelfTest`
 * already carries the principle: "a timeout is NOT a pass — an unanswered probe proves
 * nothing either way." A timed-out load now says so, in its own words, because "did not
 * answer" and "refused" are different facts to whoever is judging the plugin.
 *
 * UPU-2: the page hosting these cards also hosts the isolation self-test — the surface an
 * operator would use to decide whether the sandbox works. A host-side throw in a plugin
 * card must not take that with it.
 */
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { PluginFrame } from '../PluginFrame.js';
import { ErrorBoundary } from '../../../ui/ErrorBoundary.js';

const plugin = {
  pluginId: 'demo.plugin',
  tier: 'community',
  entry: 'entry.mjs',
  hostApi: [],
} as never;

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });

describe('UPU-1 — the entry fetch is bounded', () => {
  it('a fetch that never settles becomes a TIMED-OUT error, not an eternal spinner', async () => {
    // A fetch that resolves only when aborted — the hung-host shape.
    vi.stubGlobal('fetch', (_u: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    render(<PluginFrame plugin={plugin} artifactId="a1" title="t" loadingLabel="loading" errorLabel="failed" />);
    expect(screen.queryByRole('alert'), 'still loading before the bound elapses').toBeNull();
    vi.advanceTimersByTime(16_000);
    await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeNull(); });
    expect(screen.getByRole('alert').textContent, 'a timeout must say so, not masquerade as a network error')
      .toMatch(/timed out/i);
  });

  it('a REFUSED load keeps its own distinct message (not the timeout wording)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 404 })));
    render(<PluginFrame plugin={plugin} artifactId="a1" title="t" loadingLabel="loading" errorLabel="failed" />);
    await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeNull(); });
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('404');
    expect(text, 'refused is not timed out — the distinction is the point').not.toMatch(/timed out/i);
  });
});

describe('UPU-2 — a plugin card fails alone', () => {
  /**
   * WIRING, not mechanism. The leg below proves `ErrorBoundary` catches — which it always
   * did; that is not what was broken. What was missing is the PAGE putting one around the
   * plugin hosts, and a component-level test passes identically before and after that
   * change (it did, on the first cut of this file). So the wiring gets its own assertion.
   */
  it('the page wraps the plugin hosts in a card-scoped boundary keyed on the plugin', () => {
    const page = readFileSync(join(here, '..', 'UiPluginsPage.tsx'), 'utf8');
    const block = page.slice(page.indexOf("viewer.tier === 'trusted'") - 600);
    expect(block, 'without this the whole page — incl. the isolation self-test — is replaced')
      .toContain('<ErrorBoundary');
    expect(block).toContain('resetKey={viewer.pluginId}');
    // and the boundary must be OUTSIDE both hosts, not around one branch only
    expect(block.indexOf('<ErrorBoundary')).toBeLessThan(block.indexOf('<TrustedPluginHost'));
    expect(block.indexOf('<ErrorBoundary')).toBeLessThan(block.indexOf('<PluginFrame'));
  });

  it('a host-side throw is caught by a card-scoped boundary, leaving its siblings mounted', () => {
    const Boom = (): JSX.Element => { throw new Error('host-side render throw'); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <p>isolation self-test</p>
        <ErrorBoundary resetKey="demo.plugin" label="ui-plugin viewer demo.plugin"><Boom /></ErrorBoundary>
      </div>,
    );
    expect(screen.queryByText('isolation self-test'), 'the page survives the card').not.toBeNull();
  });
});
