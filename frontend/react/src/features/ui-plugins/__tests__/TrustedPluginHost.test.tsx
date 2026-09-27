/**
 * TrustedPluginHost (ADR 0367 P2) — the T1 main-frame mount contract:
 *  - a plugin NOT labeled trusted by the host never mounts (error state,
 *    no import attempted — the FE cannot race ahead of the host's verdict);
 *  - trustedEntryUrl builds only from a host-supplied trusted label + path.
 * (The happy dynamic-import path is exercised live — jsdom can't import()
 * a network module; the fail-closed side is what must be pinned here.)
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrustedPluginHost } from '../TrustedPluginHost.js';
import { trustedEntryUrl, type ServedPlugin } from '../pluginClient.js';

const base: ServedPlugin = {
  packName: 'vendor.acme.demo',
  packVersion: '1.0.0',
  pluginId: 'viewer',
  surface: 'artifact-viewer',
  hostApi: ['artifact.read'],
  entryPath: '/host/openwop-app/ui-plugin/packs/vendor.acme.demo/plugins/viewer/entry',
};

describe('TrustedPluginHost (ADR 0367 P2)', () => {
  it('a community-tier plugin renders the error state, never a mount', () => {
    render(<TrustedPluginHost plugin={{ ...base, tier: 'community' }} loadingLabel="loading" errorLabel="cannot load" />);
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
    expect(trustedEntryUrl({ ...base, tier: 'trusted', trustedEntryPath: '/host/openwop-app/ui-plugin/trusted/vendor.acme.demo/plugins/viewer/entry.mjs' }))
      .toContain('/trusted/vendor.acme.demo/plugins/viewer/entry.mjs');
  });
});
