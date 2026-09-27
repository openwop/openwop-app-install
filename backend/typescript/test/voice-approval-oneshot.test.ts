/**
 * A7 (ADR 0467 follow-on) — the in-voice approval card's ONE-SHOT approve.
 *
 * The browser-relay voice transport shows an approval card when a SENSITIVE
 * tool hits the firewall's require-approval verdict; Approve re-invokes the
 * tool call with `userApproved`, which the bridge maps to the firewall's
 * `approvedTools` one-shot for exactly that canonical tool. Three invariants:
 *
 *  1. semantics — `approvedTools` downgrades ONLY a require-approval verdict;
 *     a hard deny (tenant rule / platform floor) is NEVER bypassed;
 *  2. bridge wiring — `userApproved` becomes `approvedTools: new Set([name])`
 *     on the CANONICAL name (never blanket `bypassApproval`);
 *  3. route authority — the flag is honored only for a session with a BOUND
 *     human (`resolved.userId`); a user-less session cannot self-approve.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildFirewallHook,
  SENSITIVE_APPROVAL_TOOLS,
} from '../src/features/capability-firewall/firewallHook.js';

const CODE_EXEC_ID = 'openwop:feature.code-exec.nodes.run';
const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe('A7 — one-shot approvedTools semantics (the voice card\'s Approve)', () => {
  const voiceHook = (approved?: string) =>
    buildFirewallHook({
      rules: [],
      requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
      bypassApproval: false,
      ...(approved ? { approvedTools: new Set([approved]) } : {}),
    });

  it('without the one-shot, a SENSITIVE tool stays require-approval (the card trigger)', () => {
    expect(voiceHook().evaluate([], CODE_EXEC_ID).decision).toBe('require-approval');
  });

  it('the one-shot downgrades require-approval → allow for exactly that tool', () => {
    expect(voiceHook(CODE_EXEC_ID).evaluate([], CODE_EXEC_ID).decision).toBe('allow');
  });

  it('the one-shot is per-tool — a DIFFERENT sensitive tool still requires approval', () => {
    expect(voiceHook(CODE_EXEC_ID).evaluate([], 'openwop:core.files.write').decision).toBe('require-approval');
  });

  it('a hard deny (enforce-mode floor) is NEVER bypassed by the one-shot', () => {
    // The one-shot downgrades ONLY require-approval; an enforce-mode deny for an
    // unmatched action must survive an approvedTools entry for the same tool.
    const hook = buildFirewallHook({
      rules: [],
      requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
      bypassApproval: false,
      approvedTools: new Set([CODE_EXEC_ID]),
      mode: 'enforce',
      defaultDenyVerdict: 'deny',
    });
    expect(hook.evaluate([], CODE_EXEC_ID).decision).toBe('deny');
  });
});

describe('A7 — wiring pins (source-level, the voice-tool-parity idiom)', () => {
  it('the bridge maps userApproved to a per-tool approvedTools one-shot on the canonical name', () => {
    const src = srcOf('features/voice/realtime/toolBridge.ts');
    expect(src).toContain('approvedTools: new Set([name])');
    // Never blanket bypass: the voice lane keeps bypassApproval:false always.
    expect(src).toContain('bypassApproval: false');
    expect(src).not.toContain('bypassApproval: true');
  });

  it('the route honors userApproved ONLY for a session with a bound human', () => {
    const src = srcOf('features/voice/realtime/routes.ts');
    expect(src).toContain('body.userApproved === true && Boolean(resolved.userId)');
  });

  it('the browser client re-invokes with the one-shot flag from the approval card', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../frontend/react/src/chat/voice/realtimeClient.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('onApprovalRequired');
    expect(src).toContain('userApproved: true');
  });
});

describe('A7 sideband half — held approvals resolve from the chat (authority + one-shot)', () => {
  it('authority + lifecycle: not_found / forbidden / deny consumes the hold', async () => {
    const { resolveHeldSidebandCall, __heldApprovalsForTests } = await import('../src/features/voice/realtime/openaiSideband.js');
    const held = __heldApprovalsForTests();
    held.set('call-1:fc-1', {
      tenantId: 't1', userId: 'user:opener', conversationId: 'conv-1',
      name: 'openwop:core.files.write', args: {}, heldAt: 0,
    } as never);

    // Wrong tenant → not_found (no existence leak across tenants).
    expect((await resolveHeldSidebandCall({ tenantId: 't2', userId: 'user:opener', callId: 'call-1', fcId: 'fc-1', approve: true })).status).toBe('not_found');
    // Right tenant, wrong human → forbidden (only the session opener decides).
    expect((await resolveHeldSidebandCall({ tenantId: 't1', userId: 'user:other', callId: 'call-1', fcId: 'fc-1', approve: true })).status).toBe('forbidden');
    expect(held.has('call-1:fc-1')).toBe(true); // a failed attempt does NOT consume
    // The opener denies → consumed, nothing executed.
    expect((await resolveHeldSidebandCall({ tenantId: 't1', userId: 'user:opener', callId: 'call-1', fcId: 'fc-1', approve: false })).status).toBe('denied');
    expect(held.has('call-1:fc-1')).toBe(false); // one-shot: the entry is gone
    // A second resolve of the same call finds nothing.
    expect((await resolveHeldSidebandCall({ tenantId: 't1', userId: 'user:opener', callId: 'call-1', fcId: 'fc-1', approve: true })).status).toBe('not_found');
  });

  it('wiring pins: the sideband holds on require-approval and the route guards + resolves', () => {
    const sideband = srcOf('features/voice/realtime/openaiSideband.ts');
    // The hold happens only for a bound-human session with a conversation to notify.
    expect(sideband).toContain("outcome.status === 'requires_approval' && s.userId && s.conversationId");
    // Teardown clears the call's held entries (no leak past the call's life).
    expect(sideband).toContain('clearHeldForCall(s.callId)');
    // Approve executes with the SAME one-shot authority as the browser-relay card.
    expect(sideband).toContain('userApproved: true');
    const routes = srcOf('features/voice/realtime/routes.ts');
    expect(routes).toContain('held-approvals/resolve');
    expect(routes).toContain('resolveHeldSidebandCall');
  });
});
