/**
 * PluginFrame loader boundary (ADR 0300, RFC 0117/0119). Asserts the load-bearing
 * client-side guarantees without a real iframe:
 *  - the sandbox tokens carry allow-scripts but NOT allow-same-origin (opaque origin),
 *  - the deny-egress CSP is injected as the document's first head child,
 *  - the plugin-scoped allowlist forwards a DECLARED method but rejects an undeclared
 *    one with method_not_allowed BEFORE the host seam is ever contacted.
 */
import { describe, it, expect, vi } from 'vitest';
import { PLUGIN_SANDBOX, PLUGIN_CSP, withPluginCsp, makePluginMessageHandler } from '../PluginFrame.js';
import type { ServedPlugin } from '../pluginClient.js';

const VIEWER: ServedPlugin = {
  packName: 'community.openwop.artifact-viewer',
  packVersion: '1.0.0',
  pluginId: 'artifact-viewer',
  surface: 'artifact-viewer',
  hostApi: ['artifact.read'],
  entryPath: '/host/openwop-app/ui-plugin/packs/community.openwop.artifact-viewer/plugins/artifact-viewer/entry',
};

const req = (id: number, method: string, params?: unknown) =>
  ({ openwop: 'ui-plugin/1', id, type: 'request' as const, method, params });

describe('PluginFrame isolation primitives', () => {
  it('sandbox is allow-scripts WITHOUT allow-same-origin (opaque origin)', () => {
    expect(PLUGIN_SANDBOX).toContain('allow-scripts');
    expect(PLUGIN_SANDBOX).not.toContain('allow-same-origin');
  });

  it('CSP denies egress (default-src none, no connect-src)', () => {
    expect(PLUGIN_CSP).toContain("default-src 'none'");
    expect(PLUGIN_CSP).not.toContain('connect-src');
  });

  it('withPluginCsp injects the CSP as the first head child', () => {
    const out = withPluginCsp('<!doctype html><html><head><title>x</title></head><body>hi</body></html>');
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    // the meta precedes the pre-existing <title> (must govern before any resource load)
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
  });

  it('wraps a head-less document so the CSP still applies', () => {
    const out = withPluginCsp('<body>hi</body>');
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    expect(out).toContain('<head>');
  });
});

describe('PluginFrame host.announce (RFC 0130)', () => {
  const PREVIEW: ServedPlugin = {
    packName: 'community.openwop.checklist-preview',
    packVersion: '1.0.0',
    pluginId: 'checklist-preview',
    surface: 'canvas-preview',
    canvasTypes: ['canvas.checklist'],
    hostApi: ['artifact.read', 'host.announce'],
    entryPath: '/host/openwop-app/ui-plugin/packs/community.openwop.checklist-preview/plugins/checklist-preview/entry',
  };

  it('handles host.announce FRAME-LOCALLY (never contacts the host seam), length-capped', async () => {
    const posts: unknown[] = [];
    const forward = vi.fn();
    const announced: Array<[string, string]> = [];
    const handle = makePluginMessageHandler(PREVIEW, (m) => posts.push(m), forward, (msg, pol) => announced.push([msg, pol]));

    await handle(req(3, 'host.announce', { message: 'x'.repeat(500), politeness: 'assertive' }));

    expect(forward).not.toHaveBeenCalled(); // live-region relay is a page concern
    expect(announced).toHaveLength(1);
    expect(announced[0]![0]).toHaveLength(400); // hosts MUST length-cap (RFC 0130)
    expect(announced[0]![1]).toBe('assertive');
    expect(posts[0]).toMatchObject({ id: 3, ok: true, result: {} });
  });

  it('still sits behind the declared-hostApi gate', async () => {
    const posts: unknown[] = [];
    const announced: string[] = [];
    const handle = makePluginMessageHandler(VIEWER, (m) => posts.push(m), vi.fn(), (msg) => announced.push(msg));

    await handle(req(4, 'host.announce', { message: 'hi' }));

    expect(announced).toHaveLength(0); // VIEWER never declared host.announce
    expect(posts[0]).toMatchObject({ id: 4, ok: false, error: { code: 'method_not_allowed' } });
  });

  it('rejects a non-string message without announcing', async () => {
    const posts: unknown[] = [];
    const announced: string[] = [];
    const handle = makePluginMessageHandler(PREVIEW, (m) => posts.push(m), vi.fn(), (msg) => announced.push(msg));

    await handle(req(5, 'host.announce', { message: 42 }));

    expect(announced).toHaveLength(0);
    expect(posts[0]).toMatchObject({ id: 5, ok: false, error: { code: 'handler_error' } });
  });
});

describe('PluginFrame allowlist bridge', () => {
  it('forwards a DECLARED method to the host seam and posts the response', async () => {
    const posts: unknown[] = [];
    const forward = vi.fn().mockResolvedValue({ openwop: 'ui-plugin/1', id: 7, type: 'response', ok: true, result: { version: '1' } });
    const handle = makePluginMessageHandler(VIEWER, (m) => posts.push(m), forward);

    await handle(req(7, 'artifact.read', { artifactId: 'a' }));

    expect(forward).toHaveBeenCalledOnce();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ id: 7, ok: true });
  });

  it('rejects an UNDECLARED method with method_not_allowed and never contacts the host', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const forward = vi.fn();
    const handle = makePluginMessageHandler(VIEWER, (m) => posts.push(m as Record<string, unknown>), forward);

    await handle(req(8, 'artifact.write', { artifactId: 'a', payload: {}, version: '1' }));

    expect(forward).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ id: 8, ok: false, error: { code: 'method_not_allowed' } });
  });

  it('ignores anything that is not a ui-plugin/1 request', async () => {
    const posts: unknown[] = [];
    const forward = vi.fn();
    const handle = makePluginMessageHandler(VIEWER, (m) => posts.push(m), forward);

    await handle({ openwop: 'something-else', id: 1, type: 'request', method: 'artifact.read' });
    await handle({ openwop: 'ui-plugin/1', type: 'event', event: 'plugin.ready' });

    expect(forward).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
});
