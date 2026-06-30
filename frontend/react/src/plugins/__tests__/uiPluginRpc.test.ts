/**
 * `ui-plugin/1` host-RPC dispatcher (RFC 0117 §3) — the security-central contract:
 * ignore non-protocol messages, reject undeclared methods (allowlist), route allowed
 * methods, and surface a stale `artifact.write` as the normative `artifact_conflict`
 * envelope with `currentVersion`. These assertions match openwop-1's conformance
 * (`frontend-plugin-rpc-allowlist`, `frontend-plugin-artifact-concurrency`).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createUiPluginDispatcher, isUiPluginRequest, uiPluginEvent, isArtifactConflict, UI_PLUGIN_PROTOCOL,
} from '../uiPluginRpc.js';

const req = (id: number, method: string, params?: unknown) => ({ openwop: UI_PLUGIN_PROTOCOL, id, type: 'request', method, params });

describe('isUiPluginRequest', () => {
  it('accepts a well-formed request, rejects everything else', () => {
    expect(isUiPluginRequest(req(1, 'artifact.read'))).toBe(true);
    expect(isUiPluginRequest({ openwop: 'something-else', id: 1, type: 'request', method: 'x' })).toBe(false);
    expect(isUiPluginRequest({ openwop: UI_PLUGIN_PROTOCOL, type: 'event', event: 'host.themeChanged' })).toBe(false);
    expect(isUiPluginRequest({ openwop: UI_PLUGIN_PROTOCOL, type: 'request', method: 'x' })).toBe(false); // no id
    expect(isUiPluginRequest(null)).toBe(false);
  });
});

describe('createUiPluginDispatcher', () => {
  const baseOpts = () => ({
    allowlist: new Set(['artifact.read', 'artifact.write']),
    handlers: {
      'artifact.read': vi.fn(async () => ({ payload: { name: 'App' }, version: 'v1' })),
      'artifact.write': vi.fn(async () => ({ version: 'v2' })),
    },
  });

  it('ignores a non-ui-plugin message (returns null → host posts nothing)', async () => {
    const d = createUiPluginDispatcher(baseOpts());
    expect(await d({ openwop: 'x', id: 1, type: 'request', method: 'artifact.read' })).toBeNull();
    expect(await d({ type: 'event' })).toBeNull();
  });

  it('routes an allowed method to its handler and returns ok + result', async () => {
    const opts = baseOpts();
    const d = createUiPluginDispatcher(opts);
    const res = await d(req(7, 'artifact.read', { artifactId: 'a' }));
    expect(res).toMatchObject({ openwop: UI_PLUGIN_PROTOCOL, id: 7, type: 'response', ok: true, result: { version: 'v1' } });
    expect(opts.handlers['artifact.read']).toHaveBeenCalledWith({ artifactId: 'a' });
  });

  it('rejects a method not in the allowlist (frontend-plugin-rpc-allowlist)', async () => {
    const d = createUiPluginDispatcher(baseOpts());
    const res = await d(req(8, 'host.deleteEverything'));
    expect(res).toMatchObject({ id: 8, ok: false, error: { code: 'method_not_allowed' } });
  });

  it('rejects an allowlisted method that has no host handler', async () => {
    const d = createUiPluginDispatcher({ allowlist: new Set(['host.navigate']), handlers: {} });
    const res = await d(req(9, 'host.navigate'));
    expect(res?.error?.code).toBe('method_not_allowed');
  });

  it('maps a stale write to artifact_conflict + currentVersion (host MUST NOT persist)', async () => {
    const d = createUiPluginDispatcher({
      allowlist: new Set(['artifact.write']),
      handlers: { 'artifact.write': async () => { throw { code: 'artifact_conflict', currentVersion: 'v5' }; } },
    });
    const res = await d(req(10, 'artifact.write', { state: {}, version: 'v3' }));
    expect(res).toMatchObject({ id: 10, ok: false, error: { code: 'artifact_conflict', currentVersion: 'v5' } });
  });

  it('maps any other handler throw to handler_error', async () => {
    const d = createUiPluginDispatcher({
      allowlist: new Set(['artifact.read']),
      handlers: { 'artifact.read': async () => { throw new Error('boom'); } },
    });
    const res = await d(req(11, 'artifact.read'));
    expect(res).toMatchObject({ id: 11, ok: false, error: { code: 'handler_error', message: 'boom' } });
  });
});

describe('helpers', () => {
  it('isArtifactConflict narrows the conflict shape', () => {
    expect(isArtifactConflict({ code: 'artifact_conflict', currentVersion: 'v2' })).toBe(true);
    expect(isArtifactConflict({ code: 'handler_error' })).toBe(false);
    expect(isArtifactConflict(null)).toBe(false);
  });
  it('uiPluginEvent builds a host→plugin event envelope', () => {
    expect(uiPluginEvent('host.themeChanged', { theme: 'dark' })).toEqual({
      openwop: UI_PLUGIN_PROTOCOL, type: 'event', event: 'host.themeChanged', data: { theme: 'dark' },
    });
  });
});
