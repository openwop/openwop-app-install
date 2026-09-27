/**
 * CEC-2 (RFC 0116 §43) — the DISPATCHER half of the fix. The host sets
 * `req.cachePrefixScope` (see cec2-prompt-cache-scope.test.ts), but that is inert
 * unless each Anthropic dispatcher FORWARDS it into `cacheableAnthropicSystem`
 * (the function that prepends the per-tenant marker). The tools dispatcher always
 * forwarded it; the plain-chat dispatcher (`dispatch.ts` → `dispatchAnthropic`)
 * SILENTLY DROPPED it (called `cacheableAnthropicSystem` with only 2 args) — so
 * the plain `callAI` path's isolation was dead. This witness spies
 * `cacheableAnthropicSystem` and asserts BOTH dispatchers pass the scope as the
 * 3rd arg. (`fetch` is stubbed to reject; the marker is assembled BEFORE the
 * network call, so the spy captures the arg regardless.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spy = vi.hoisted(() => vi.fn());
vi.mock('../src/providers/promptCaching.js', async (orig) => {
  const real = await orig<typeof import('../src/providers/promptCaching.js')>();
  return {
    ...real,
    cacheableAnthropicSystem: (...args: Parameters<typeof real.cacheableAnthropicSystem>) => {
      spy(...args);
      return real.cacheableAnthropicSystem(...args);
    },
  };
});

const { dispatchChat } = await import('../src/providers/dispatch.js');
const { dispatchAnthropicToolsRound } = await import('../src/providers/dispatchAnthropicTools.js');

const SCOPE = { tenant: 'tenant-A', cachePrefixId: 'pref-1' };

beforeEach(() => {
  spy.mockReset();
  vi.stubGlobal('fetch', () => Promise.reject(new Error('stub-abort-after-prefix-assembly')));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('CEC-2 — both Anthropic dispatchers forward cachePrefixScope to the marker', () => {
  it('plain dispatch (dispatchChat → dispatchAnthropic) forwards the scope as the 3rd arg', async () => {
    await dispatchChat({
      provider: 'anthropic', model: 'claude-x', apiKey: 'k',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      cachePrefixScope: SCOPE,
    } as unknown as Parameters<typeof dispatchChat>[0]).catch(() => {});
    expect(spy).toHaveBeenCalled();
    // Some call carried the scope as the 3rd argument (the dropped-forward bug).
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), SCOPE);
  });

  it('tools dispatch (dispatchAnthropicToolsRound) forwards the scope (regression guard)', async () => {
    await dispatchAnthropicToolsRound({
      model: 'claude-x', apiKey: 'k',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }],
      cachePrefixScope: SCOPE,
    } as unknown as Parameters<typeof dispatchAnthropicToolsRound>[0]).catch(() => {});
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), SCOPE);
  });
});
