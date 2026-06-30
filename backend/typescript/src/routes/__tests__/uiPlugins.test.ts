/**
 * RFC 0117 front-end plugin packs — host witness (`POST /v1/host/openwop-app/ui-plugin/rpc`)
 * + the four SECURITY invariants (SECURITY/invariants.yaml 139→143). The behavioral legs
 * mirror `conformance/src/scenarios/frontend-plugin-packs.test.ts`: the closed allowlist
 * rejects undeclared methods, and a stale `artifact.write` surfaces `artifact_conflict` +
 * `currentVersion` with NO persist. The isolation/egress/no-byok invariants are asserted
 * against the host's capability + sandbox primitives (single source: host/uiPluginRpc.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  UI_PLUGIN_PROTOCOL,
  HOST_UI_PLUGIN_API,
  uiPluginsCapability,
  pluginIframeCsp,
  pluginSandboxTokens,
} from '../../host/uiPluginRpc.js';
import { dispatcherForTenant } from '../uiPlugins.js';
import { __putCanvasForTest, getCanvasForTenant } from '../../host/canvasSurface.js';
import { initHostExtPersistence } from '../../host/hostExtPersistence.js';
import { openStorage } from '../../storage/index.js';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

const TENANT = 'tenant-uip';
const req = (id: number, method: string, params?: unknown) => ({ openwop: UI_PLUGIN_PROTOCOL, id, type: 'request', method, params });

let counter = 0;
async function seedCanvas(state: Record<string, unknown>, version = 1): Promise<string> {
  const canvasId = `canvas-uip-${++counter}`;
  await __putCanvasForTest({ canvasId, tenantId: TENANT, canvasTypeId: 'canvas.app-builder', state, version });
  return canvasId;
}

describe('frontend-plugin-rpc-allowlist (RFC 0117 §3)', () => {
  it('rejects a method outside the closed host allowlist', async () => {
    const res = await dispatcherForTenant(TENANT)(req(1, 'host.deleteEverything'));
    expect(res).toMatchObject({ openwop: UI_PLUGIN_PROTOCOL, id: 1, ok: false, error: { code: 'method_not_allowed' } });
  });
  it('ignores a non-ui-plugin/1 message (null → host posts nothing)', async () => {
    expect(await dispatcherForTenant(TENANT)({ openwop: 'x', id: 1, type: 'request', method: 'artifact.read' })).toBeNull();
  });
});

describe('frontend-plugin-no-byok (RFC 0117 §3)', () => {
  it('exposes NO credential/secret method in the host API', () => {
    for (const m of HOST_UI_PLUGIN_API) {
      expect(/secret|byok|credential|token|key/i.test(m)).toBe(false);
    }
    expect([...HOST_UI_PLUGIN_API]).toEqual(['artifact.read', 'artifact.write', 'host.toast', 'host.navigate']);
  });
  it('rejects a plugin attempt to read BYOK material', async () => {
    const res = await dispatcherForTenant(TENANT)(req(2, 'secrets.read', { credentialRef: 'anthropic' }));
    expect(res).toMatchObject({ id: 2, ok: false, error: { code: 'method_not_allowed' } });
  });
});

describe('frontend-plugin-isolation (RFC 0117 §6)', () => {
  it('advertises the cross-origin-iframe isolation const (in-process is MUST NOT)', () => {
    expect(uiPluginsCapability().isolation).toBe('cross-origin-iframe');
  });
  it('sandboxes the plugin without allow-same-origin (unique opaque origin)', () => {
    expect(pluginSandboxTokens()).toContain('allow-scripts');
    expect(pluginSandboxTokens()).not.toContain('allow-same-origin');
  });
});

describe('frontend-plugin-egress (RFC 0117 §6)', () => {
  it('applies a deny-egress CSP — no network channel but the RPC', () => {
    const csp = pluginIframeCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/connect-src/);
    expect(csp).not.toMatch(/form-action/);
  });
});

describe('frontend-plugin-artifact-concurrency (RFC 0117 §3)', () => {
  it('reads a canvas as { payload, version } via the opaque token', async () => {
    const id = await seedCanvas({ title: 'Hello' }, 1);
    const res = await dispatcherForTenant(TENANT)(req(3, 'artifact.read', { artifactId: id }));
    expect(res).toMatchObject({ ok: true, result: { payload: { title: 'Hello' }, version: '1' } });
  });

  it('rejects a stale/unknown write token with artifact_conflict + currentVersion and does NOT persist', async () => {
    const id = await seedCanvas({ title: 'Before' }, 1);
    // 'stale-token' is a token the host never minted → conflict (the schema §Concurrency rule).
    const res = await dispatcherForTenant(TENANT)(req(4, 'artifact.write', { artifactId: id, payload: { title: 'After' }, version: 'stale-token' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'artifact_conflict', currentVersion: '1' } });
    // No persist: the canvas is untouched (still version 1, original state).
    const after = await getCanvasForTenant(TENANT, id);
    expect(after).toMatchObject({ version: 1, state: { title: 'Before' } });
  });

  it('accepts a fresh write (matching token) via params.payload and bumps the version', async () => {
    const id = await seedCanvas({ title: 'v1' }, 1);
    const res = await dispatcherForTenant(TENANT)(req(5, 'artifact.write', { artifactId: id, payload: { title: 'v2' }, version: '1' }));
    expect(res).toMatchObject({ ok: true, result: { version: '2' } });
    expect(await getCanvasForTenant(TENANT, id)).toMatchObject({ version: 2, state: { title: 'v2' } });
  });

  it('returns artifact_not_found for an absent artifact (not handler_error)', async () => {
    const res = await dispatcherForTenant(TENANT)(req(6, 'artifact.read', { artifactId: 'does-not-exist' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
  });

  it('does not leak a cross-tenant canvas (artifact_not_found, never artifact_conflict)', async () => {
    const id = await seedCanvas({ secret: 'x' }, 1);
    const res = await dispatcherForTenant('other-tenant')(req(7, 'artifact.read', { artifactId: id }));
    expect(res).toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
  });
});
