/**
 * RFC 0117 front-end plugin packs — the host's ui-plugin/1 dispatcher (served per plugin at
 * RFC 0238 `POST /host/ui-plugins/{pack}/{plugin}/rpc`; ADR 0840 D7 deleted the vendor route)
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
import { registerAppBuilderComponents } from '../../features/app-builder/componentCatalog.js';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // The write path validates against the app-builder catalog (ADR 0835 D7),
  // which the host registers at boot.
  registerAppBuilderComponents();
});

const TENANT = 'tenant-uip';
const req = (id: number, method: string, params?: unknown) => ({ openwop: UI_PLUGIN_PROTOCOL, id, type: 'request', method, params });

// ADR 0835 D7 — `artifact.write` is the editor's write: it needs workspace:write.
// These concurrency legs drive it as the trusted operator principal (the same
// `*` bearer the conformance suite uses over HTTP), so the RFC 0117 §3 semantics
// are witnessed with an AUTHORIZED caller; an unauthorized one is its own leg.
const OPERATOR = { wildcardOperator: true } as const;
const writer = (tenantId: string) => dispatcherForTenant(tenantId, {}, undefined, OPERATOR);
/** A minimal valid app document — writes now pass `validateAppDoc` like a PATCH. */
const app = (name: string) => ({ name, screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] });

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
    expect([...HOST_UI_PLUGIN_API]).toEqual(['artifact.read', 'artifact.write', 'host.toast', 'host.navigate', 'host.announce']);
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
    const id = await seedCanvas(app('Before'), 1);
    // 'stale-token' is a token the host never minted → conflict (the schema §Concurrency rule).
    const res = await writer(TENANT)(req(4, 'artifact.write', { artifactId: id, payload: app('After'), version: 'stale-token' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'artifact_conflict', currentVersion: '1' } });
    // No persist: the canvas is untouched (still version 1, original state).
    const after = await getCanvasForTenant(TENANT, id);
    expect(after).toMatchObject({ version: 1, state: { name: 'Before' } });
  });

  it('accepts a fresh write (matching token) via params.payload and bumps the version', async () => {
    const id = await seedCanvas(app('v1'), 1);
    const res = await writer(TENANT)(req(5, 'artifact.write', { artifactId: id, payload: app('v2'), version: '1' }));
    expect(res).toMatchObject({ ok: true, result: { version: '2' } });
    expect(await getCanvasForTenant(TENANT, id)).toMatchObject({ version: 2, state: { name: 'v2' } });
  });

  it('ADR 0835 D7 — a caller with no write authority is refused (unauthorized) and nothing persists', async () => {
    const id = await seedCanvas(app('v1'), 1);
    const res = await dispatcherForTenant(TENANT)(req(8, 'artifact.write', { artifactId: id, payload: app('v2'), version: '1' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(await getCanvasForTenant(TENANT, id)).toMatchObject({ version: 1, state: { name: 'v1' } });
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
