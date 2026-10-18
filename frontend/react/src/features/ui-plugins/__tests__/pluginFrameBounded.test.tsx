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
 * card must not take that with it. Witnessed by rendering the REAL `UiPluginsPage` with a
 * plugin card that throws: drop the page's card-scoped `ErrorBoundary` and the throw
 * escapes `render()` (no source-text reading, no re-test of `ErrorBoundary` itself).
 */
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ServedPlugin } from '../pluginClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const plugin: ServedPlugin = {
  packName: 'community.openwop.demo',
  packVersion: '1.0.0',
  pluginId: 'demo.plugin',
  surface: 'artifact-viewer',
  tier: 'community',
  hostApi: [],
  entryPath: '/host/openwop-app/ui-plugin/packs/community.openwop.demo/plugins/demo.plugin/entry',
  framePath: '/host/ui-plugins/community.openwop.demo/demo.plugin/frame',
  rpcPath: '/host/ui-plugins/community.openwop.demo/demo.plugin/rpc',
};

/** UPU-2 only: the plugin card throws on render. Off for UPU-1, which mounts the real PluginFrame. */
const card = vi.hoisted(() => ({ boom: false }));
vi.mock('../PluginFrame.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../PluginFrame.js')>();
  const PluginFrame: typeof actual.PluginFrame = (props) => {
    if (card.boom) throw new Error('host-side render throw');
    return actual.PluginFrame(props);
  };
  return { ...actual, PluginFrame };
});
vi.mock('../pluginClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pluginClient.js')>();
  return {
    ...actual,
    listPlugins: async () => ({ isolation: 'cross-origin-iframe', plugins: [plugin] }),
    ensureDemoArtifact: async () => ({ artifactId: 'a1', version: '1' }),
  };
});
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: true }) }));

import { PluginFrame } from '../PluginFrame.js';
import { config } from '../../../client/config.js';
import { UiPluginsPage } from '../UiPluginsPage.js';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(() => { card.boom = false; vi.useFakeTimers({ shouldAdvanceTime: true }); });

describe('UPU-1 — the entry fetch is bounded', () => {
  it('a fetch that never settles becomes a TIMED-OUT error, not an eternal spinner', async () => {
    // A fetch that resolves only when aborted — the hung-host shape.
    const urls: string[] = [];
    vi.stubGlobal('fetch', (u: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      urls.push(u);
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    render(<PluginFrame plugin={plugin} artifactId="a1" title="t" loadingLabel="loading" errorLabel="failed" />);
    // The literal host frame document, NOT `frameUrl(plugin)`: that is the function
    // under test, so comparing against it moved with any sabotage of it (w33 pb-frameurl).
    expect(urls).toEqual([`${config.baseUrl}${plugin.framePath}`]);
    // Just short of the 15 s bound: still loading, no error yet.
    await act(() => vi.advanceTimersByTimeAsync(14_000));
    expect(screen.queryByRole('alert'), 'still loading before the bound elapses').toBeNull();
    expect(screen.getByRole('status').textContent).toBe('loading');
    // Past the bound: the load fails, and says it timed out.
    await act(() => vi.advanceTimersByTimeAsync(2_000));
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
  it('a throwing plugin card leaves the page — incl. the isolation self-test — mounted', async () => {
    card.boom = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<UiPluginsPage />);
    // The card's own boundary fallback names the plugin and carries the throw...
    expect(await screen.findByText('host-side render throw')).toBeTruthy();
    // ...while the self-test the operator judges the sandbox with is still there.
    expect(screen.getByText('selfTestTitle')).toBeTruthy();
    expect(screen.getByText('installedLabel')).toBeTruthy();
  });
});
