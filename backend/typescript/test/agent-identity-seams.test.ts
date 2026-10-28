/**
 * CS-XC-1/2 + CS-BE-2 (conversation-stack audit 2026-07-09) — direct unit
 * coverage for the two most load-bearing conversation seams, which every chat
 * turn crosses yet had no direct tests:
 *  - resolveAgentIdentity: rosterId↔agentId normalization, reverse-scan
 *    OPT-IN gating, TTL cache staleness, cross-tenant fail-closed
 *  - composeChatContext: persona resolution + degraded[] honesty + the bare
 *    scaffold + caller identity anchor
 *  (The loadTurns fold-cache characterization this header once claimed lives
 *  in `load-turns-fold.test.ts` — GC-CHAT-1 made the claim true, elsewhere.)
 *
 * Tracker TST-BKY-3. Red when the reverse scan runs without its opt-in, the
 * reverse cache never expires or is bypassed, a roster read crosses tenants,
 * an unknown agent stops naming the `persona` degradation, or the caller
 * anchor is dropped — each sabotage-witnessed (w65).
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { resolveAgentIdentity, __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import { composeChatContext } from '../src/host/chatContext.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { createUser } from '../src/features/users/usersService.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  getAgentRegistry().register({
    agentId: 'probe.seams.ident', persona: 'Ident Probe', modelClass: 'chat',
    systemPrompt: 'SEAM-PERSONA-MARKER: identity probe persona.', toolAllowlist: [], packName: 'test.seams', packVersion: '0.0.1',
  });
});
afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
});

describe('CS-XC-1 — resolveAgentIdentity', () => {
  it('forward form (host:* rosterId) resolves without the reverse-scan opt-in', async () => {
    const entry = await createRosterEntry({ tenantId: 'default', persona: 'Ident Probe Member', agentRef: { agentId: 'probe.seams.ident' } });
    __clearAgentIdentityCache();
    const viaRoster = await resolveAgentIdentity('default', entry.rosterId);
    expect(viaRoster?.agentId).toBe('probe.seams.ident');
  });

  it('reverse form (registry agentId) requires the EXPLICIT allowReverseScan opt-in', async () => {
    // A case-unique agent with exactly ONE roster binding, so the reverse scan's
    // answer is pinnable to it.
    getAgentRegistry().register({
      agentId: 'probe.seams.reverse', persona: 'Reverse Probe', modelClass: 'chat',
      systemPrompt: 'x', toolAllowlist: [], packName: 'test.seams', packVersion: '0.0.1',
    });
    const entry = await createRosterEntry({ tenantId: 'default', persona: 'Reverse Probe Member', agentRef: { agentId: 'probe.seams.reverse' } });
    __clearAgentIdentityCache();
    const gated = await resolveAgentIdentity('default', 'probe.seams.reverse');
    const opened = await resolveAgentIdentity('default', 'probe.seams.reverse', { allowReverseScan: true });
    // Without the opt-in the reverse scan must not run (no roster binding
    // surfaces); with it the roster projection resolves to THIS entry.
    expect(gated?.rosterId ?? null).toBeNull();
    expect(opened?.rosterId).toBe(entry.rosterId);
  });

  it('the reverse cache is TTL-bound: a new roster entry is invisible until expiry (then visible)', async () => {
    __clearAgentIdentityCache();
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    try {
      getAgentRegistry().register({
        agentId: 'probe.seams.ttl', persona: 'TTL Probe', modelClass: 'chat',
        systemPrompt: 'x', toolAllowlist: [], packName: 'test.seams', packVersion: '0.0.1',
      });
      // Prime the tenant's reverse cache (no binding for the ttl agent yet).
      const before = await resolveAgentIdentity('default', 'probe.seams.ttl', { allowReverseScan: true });
      expect(before?.rosterId ?? null).toBeNull();
      await createRosterEntry({ tenantId: 'default', persona: 'TTL Member', agentRef: { agentId: 'probe.seams.ttl' } });
      // Within TTL — the stale cache still answers (the documented trade).
      const stale = await resolveAgentIdentity('default', 'probe.seams.ttl', { allowReverseScan: true });
      expect(stale?.rosterId ?? null).toBeNull();
      // Past TTL (30s) — the rescan sees the binding.
      vi.setSystemTime(Date.now() + 31_000);
      const fresh = await resolveAgentIdentity('default', 'probe.seams.ttl', { allowReverseScan: true });
      expect(fresh?.rosterId).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cross-tenant fail-closed: another tenant cannot resolve this tenant roster binding', async () => {
    const entry = await createRosterEntry({ tenantId: 'default', persona: 'XT Probe Member', agentRef: { agentId: 'probe.seams.ident' } });
    __clearAgentIdentityCache();
    const other = await resolveAgentIdentity('tenant-b', entry.rosterId);
    expect(other?.rosterId ?? null).toBeNull();
    // Owner control: the same id resolves in its own tenant.
    expect((await resolveAgentIdentity('default', entry.rosterId))?.rosterId).toBe(entry.rosterId);
  });
});

describe('CS-XC-2 — composeChatContext', () => {
  it('a resolvable agent composes its persona; tenantOk true', async () => {
    const ctx = await composeChatContext('default', { agentId: 'probe.seams.ident' });
    expect(ctx.systemPrompt).toContain('SEAM-PERSONA-MARKER');
    expect(ctx.tenantOk).toBe(true);
  });

  it('an unknown agent degrades HONESTLY: generic scaffold + degraded[] names the block', async () => {
    const ctx = await composeChatContext('default', { agentId: 'no-such-agent-seams' });
    expect(ctx.systemPrompt).not.toContain('SEAM-PERSONA-MARKER');
    expect(ctx.degraded).toContain('persona');
  });

  it('the caller identity anchor rides the scaffold when the caller resolves', async () => {
    const user = await createUser({ tenantId: 'default', principalId: 'principal-seams-user', displayName: 'Seams Tester' });
    const ctx = await composeChatContext('default', { callerUserId: user.userId });
    expect(ctx.systemPrompt).toContain('Seams Tester');
  });
});
