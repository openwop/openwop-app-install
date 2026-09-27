/**
 * GRADING PROBE — "UI Plugins" (FEATURES.md ordinal 226, OpenWOP RFC 0117 / 0119).
 * Evidence only. GREEN + CI-safe. Witnesses the THREE load-bearing trust-boundary
 * invariants of the untrusted-plugin sandbox, by execution:
 *
 * UPP-1 (the closed RPC allowlist — RFC 0117 §3, invariant
 *     `frontend-plugin-rpc-allowlist`): the host dispatcher honors ONLY a method
 *     that is BOTH in the allowlist AND has a handler; a declared-but-not-allowed
 *     method (handler present, not in allowlist) and an unrecognized method are
 *     both `method_not_allowed`; a non-`ui-plugin/1` message is ignored (null).
 *     This is the least-privilege gate — a plugin cannot reach any host capability
 *     outside its intersected allowlist.
 * UPP-2 (the sandbox isolation invariant): the iframe sandbox tokens are exactly
 *     `['allow-scripts']` and NEVER include `allow-same-origin` — the deliberate
 *     absence is what keeps the frame at a unique opaque origin (no host DOM /
 *     cookies / storage). A regression re-adding it would defeat the whole boundary.
 * UPP-3 (deny-egress CSP + closed capability set): the plugin iframe CSP is
 *     `default-src 'none'` (no ambient network → no exfiltration), and the
 *     host-API surface is the exact closed 5-method set (no raw fetch / exec /
 *     token / credential capability).
 */
import { describe, it, expect } from 'vitest';
import {
  createUiPluginDispatcher,
  pluginSandboxTokens,
  pluginIframeCsp,
  HOST_UI_PLUGIN_API,
} from '../src/host/uiPluginRpc.js';

const req = (id: number, method: string, params?: unknown) =>
  ({ openwop: 'ui-plugin/1', type: 'request', id, method, ...(params !== undefined ? { params } : {}) });

describe('RFC 0117/0119 UI-plugin trust boundary (by execution)', () => {
  it('UPP-1: the RPC dispatcher enforces the CLOSED allowlist (allowlist ∩ handler), rejects the rest', async () => {
    const dispatch = createUiPluginDispatcher({
      allowlist: new Set(['artifact.read']),
      // NOTE: a handler exists for 'artifact.write' too — but it is NOT in the allowlist.
      handlers: {
        'artifact.read': async () => ({ content: 'ok' }),
        'artifact.write': async () => ({ written: true }),
      },
    });
    // Allowed + handler → dispatched.
    expect(await dispatch(req(1, 'artifact.read'))).toMatchObject({ ok: true, result: { content: 'ok' } });
    // Handler PRESENT but NOT allowlisted → rejected (the allowlist gates, not handler presence).
    expect(await dispatch(req(2, 'artifact.write'))).toMatchObject({ ok: false, error: { code: 'method_not_allowed' } });
    // Unrecognized method → rejected.
    expect(await dispatch(req(3, 'host.exec'))).toMatchObject({ ok: false, error: { code: 'method_not_allowed' } });
    // Not a ui-plugin/1 request → ignored entirely (null), never dispatched.
    expect(await dispatch({ type: 'request', id: 4, method: 'artifact.read' })).toBeNull();
  });

  it('UPP-2: the iframe sandbox is opaque-origin — allow-scripts WITHOUT allow-same-origin', () => {
    const tokens = pluginSandboxTokens();
    expect([...tokens]).toEqual(['allow-scripts']);
    expect(tokens).not.toContain('allow-same-origin'); // the invariant that makes isolation honest
  });

  it('UPP-3: deny-egress CSP + the host-API surface is the exact closed 5-method set', () => {
    const csp = pluginIframeCsp();
    expect(csp).toContain("default-src 'none'"); // no ambient network → no exfiltration
    expect(csp).not.toMatch(/connect-src[^;]*\*/); // no wildcard egress channel
    // The closed capability surface — no raw fetch / exec / token / credential method.
    expect([...HOST_UI_PLUGIN_API].sort()).toEqual(
      ['artifact.read', 'artifact.write', 'host.announce', 'host.navigate', 'host.toast'].sort(),
    );
  });
});
