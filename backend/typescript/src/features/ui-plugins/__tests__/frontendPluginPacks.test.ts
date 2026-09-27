/**
 * Front-end plugin pack loader (ADR 0300, RFC 0117/0119). Asserts the reference
 * pack loads + is projected to the host-honored shape, the RFC 0119 advertise/serve
 * isolation NON-DRIFT (the value the loader reports == the value discovery advertises),
 * and the entry-serving guards (traversal-safe, uniform miss). The behavioral
 * isolation/egress legs are browser-runtime (witnessed via PluginFrame + a steward
 * browser observation), not assertable here.
 */
import { describe, it, expect } from 'vitest';
import { listFrontendPluginPacks, getPluginEntry, hostIsolation } from '../frontendPluginPacks.js';
import { uiPluginsCapability } from '../../../host/uiPluginRpc.js';

const REF_PACK = 'community.openwop.artifact-viewer';
const REF_PLUGIN = 'artifact-viewer';

describe('frontendPluginPacks loader', () => {
  it('loads + projects the reference frontend-plugin pack to the host-honored shape', () => {
    const served = listFrontendPluginPacks();
    const ref = served.find((s) => s.packName === REF_PACK && s.pluginId === REF_PLUGIN);
    expect(ref).toBeDefined();
    expect(ref!.surface).toBe('artifact-viewer');
    // hostApi is intersected to the host's advertised set = the plugin's closed allowlist.
    expect(ref!.hostApi).toEqual(['artifact.read']);
    expect(ref!.entryPath).toContain(`/ui-plugin/packs/${encodeURIComponent(REF_PACK)}/plugins/${REF_PLUGIN}/entry`);
  });

  it('projects the canvas-preview witness WITH its canvasTypes binding key (RFC 0130 — code-review C1)', () => {
    const served = listFrontendPluginPacks();
    const preview = served.find((s) => s.packName === 'community.openwop.checklist-preview' && s.pluginId === 'checklist-preview');
    expect(preview).toBeDefined();
    expect(preview!.surface).toBe('canvas-preview');
    // Without canvasTypes on the served wire shape the FE discovery→mount
    // match can never fire — the whole Phase E surface would be inert.
    expect(preview!.canvasTypes).toEqual(['canvas.checklist']);
    expect(preview!.hostApi).toEqual(['artifact.read', 'host.announce']);
  });

  it('RFC 0119 non-drift: served isolation === the advertised isolation', () => {
    // The loader + FE read hostIsolation(); discovery advertises uiPluginsCapability().isolation.
    // They MUST be the same single source, or advertise/apply drift.
    expect(hostIsolation()).toBe(uiPluginsCapability().isolation);
    expect(hostIsolation()).toBe('cross-origin-iframe');
  });

  it('serves the reference plugin entry bytes (the ui-plugin/1 client bundle)', () => {
    const entry = getPluginEntry(REF_PACK, REF_PLUGIN);
    expect(entry).not.toBeNull();
    expect(entry!.contentType).toContain('text/html');
    const html = entry!.bytes.toString('utf8');
    expect(html).toContain('ui-plugin/1');
    expect(html).toContain('artifact.read');
  });

  it('returns null (uniform miss) for an unknown pack or plugin — no existence leak', () => {
    expect(getPluginEntry(REF_PACK, 'no-such-plugin')).toBeNull();
    expect(getPluginEntry('community.openwop.does-not-exist', REF_PLUGIN)).toBeNull();
  });

  it('refuses a path-traversal pack name (defense-in-depth over the schema pattern)', () => {
    expect(getPluginEntry('../../etc', REF_PLUGIN)).toBeNull();
    expect(getPluginEntry('community.openwop.artifact-viewer/../..', REF_PLUGIN)).toBeNull();
  });
});
