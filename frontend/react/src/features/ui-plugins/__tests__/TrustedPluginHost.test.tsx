/**
 * TrustedPluginHost (ADR 0367 P2) — the T1 main-frame mount contract:
 *  - a plugin NOT labeled trusted by the host never mounts (error state,
 *    no import attempted — the FE cannot race ahead of the host's verdict);
 *  - trustedEntryUrl builds only from a host-supplied trusted label + path.
 * (The happy dynamic-import path is exercised live — jsdom can't import()
 * a network module; the fail-closed side is what must be pinned here.)
 *
 * "No import attempted" is witnessed by TIMING: the error state is set synchronously
 * inside the mount effect only when there is no URL to import; an attempted import
 * (which fails in jsdom) would reach the error state only after a microtask, so the
 * synchronous `getByText` right after `render` would throw.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrustedPluginHost } from '../TrustedPluginHost.js';
import { trustedEntryUrl, type ServedPlugin } from '../pluginClient.js';
import { config } from '../../../client/config.js';

const TRUSTED_PATH = '/host/openwop-app/ui-plugin/trusted/vendor.acme.demo/plugins/viewer/entry.mjs';

const base: ServedPlugin = {
  packName: 'vendor.acme.demo',
  packVersion: '1.0.0',
  pluginId: 'viewer',
  surface: 'artifact-viewer',
  hostApi: ['artifact.read'],
  entryPath: '/host/openwop-app/ui-plugin/packs/vendor.acme.demo/plugins/viewer/entry',
  framePath: '/host/ui-plugins/vendor.acme.demo/viewer/frame',
  rpcPath: '/host/ui-plugins/vendor.acme.demo/viewer/rpc',
};

describe('TrustedPluginHost (ADR 0367 P2)', () => {
  it('a community-tier plugin renders the error state, never a mount', () => {
    // Even WITH a trusted path present, the host's 'community' label must refuse:
    // the label is the gate, not the presence of a path.
    render(<TrustedPluginHost plugin={{ ...base, tier: 'community', trustedEntryPath: TRUSTED_PATH }} loadingLabel="loading" errorLabel="cannot load" />);
    expect(screen.getByText('cannot load')).toBeTruthy();
  });

  it('a plugin with no tier at all fails closed the same way', () => {
    render(<TrustedPluginHost plugin={base} loadingLabel="loading" errorLabel="cannot load" />);
    expect(screen.getByText('cannot load')).toBeTruthy();
  });

  it('trustedEntryUrl is null unless the host supplied BOTH the label and the path', () => {
    expect(trustedEntryUrl(base)).toBeNull();
    expect(trustedEntryUrl({ ...base, tier: 'trusted' })).toBeNull();
    expect(trustedEntryUrl({ ...base, trustedEntryPath: '/x' })).toBeNull();
    expect(trustedEntryUrl({ ...base, tier: 'trusted', trustedEntryPath: TRUSTED_PATH })).toBe(`${config.baseUrl}${TRUSTED_PATH}`);
  });
});
