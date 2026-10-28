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
 *  2. bridge wiring — `userApproved` becomes a one-shot approval on the CANONICAL
 *     name (never blanket `bypassApproval`). ADR 0834 D2: it is the BASELINE-only set
 *     (`approvedBaselineTools`) — the card is client-asserted, so it answers the
 *     user's own safe-mode ask, never a workspace/platform/enforce ask;
 *  3. route authority — the flag is honored only for a session with a BOUND
 *     human (`resolved.userId`); a user-less session cannot self-approve.
 *
 * WHAT IS BEHAVIOURAL AND WHAT IS NOT (honest ceiling, 8f W4). Invariant 1 and
 * the sideband's authority/lifecycle are driven through the real functions.
 * Invariants 2 and 3 are WIRING TRIPWIRES: exact source substrings of
 * `toolBridge.ts` / `routes.ts`. A behavioural test of the bridge needs a live
 * agent allowlist, conversation gate and lane firewall (`executeRealtimeToolCall`),
 * and the route's `resolved.userId` has no unit seam, so a refactor that keeps
 * the semantics will red these and must update the substring deliberately.
 *
 * Witnessed: va-baseline-ignored, va-not-per-tool, va-deny-bypassed,
 * va-sideband-cross-tenant, va-sideband-any-human, va-sideband-not-consumed,
 * va-route-unbound-human (source tripwire).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildFirewallHook,
  SENSITIVE_APPROVAL_TOOLS,
} from '../src/features/capability-firewall/firewallHook.js';
// STATIC import (wave-9 lesson): the in-case `await import()` of this module's
// graph cost 4.3 s of the case's own budget (8f W4 baseline).
import { resolveHeldSidebandCall, __heldApprovalsForTests } from '../src/features/voice/realtime/openaiSideband.js';

/** The sideband's held-approval row, read off the test seam's own type (the
 *  interface itself is module-private), so the fixture is checked by tsc. */
type HeldApproval = Parameters<ReturnType<typeof __heldApprovalsForTests>['set']>[1];

const CODE_EXEC_ID = 'openwop:feature.code-exec.nodes.run';
const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe('A7 — one-shot approvedTools semantics (the voice card\'s Approve)', () => {
  const voiceHook = (approved?: string) =>
    buildFirewallHook({
      rules: [],
      requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
      bypassApproval: false,
      ...(approved ? { approvedBaselineTools: new Set([approved]) } : {}),
    });

  it('without the one-shot, a SENSITIVE tool stays require-approval (the card trigger)', () => {
    expect(voiceHook().evaluate([], CODE_EXEC_ID).decision).toBe('require-approval');
  });

  it('the one-shot downgrades require-approval → allow for exactly that tool', () => {
    expect(voiceHook(CODE_EXEC_ID).evaluate([], CODE_EXEC_ID).decision).toBe('allow');
  });

  it('the one-shot is per-tool — a DIFFERENT sensitive tool still requires approval', () => {
    // ADR 0834 D4 — this used `openwop:core.files.write`, which no agent tool ever
    // registered (removed from the set); http.fetch is a real member.
    expect(voiceHook(CODE_EXEC_ID).evaluate([], 'openwop:core.openwop.http.fetch').decision).toBe('require-approval');
  });

  it('a hard deny (enforce-mode floor) is NEVER bypassed by the one-shot', () => {
    // The one-shot downgrades ONLY require-approval; an enforce-mode deny for an
    // unmatched action must survive an approval entry for the same tool — in the
    // policy set (`approvedTools`) AND in the baseline set the voice card actually
    // feeds (`approvedBaselineTools`, ADR 0834 D2).
    for (const approval of [{ approvedTools: new Set([CODE_EXEC_ID]) }, { approvedBaselineTools: new Set([CODE_EXEC_ID]) }]) {
      const hook = buildFirewallHook({
        rules: [],
        requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
        bypassApproval: false,
        ...approval,
        mode: 'enforce',
        defaultDenyVerdict: 'deny',
      });
      expect(hook.evaluate([], CODE_EXEC_ID).decision, Object.keys(approval)[0]).toBe('deny');
    }
  });
});

describe('A7 — wiring pins (source-level, the voice-tool-parity idiom)', () => {
  it('the bridge maps userApproved to a per-tool approvedTools one-shot on the canonical name', () => {
    const src = srcOf('features/voice/realtime/toolBridge.ts');
    expect(src).toContain('if (input.userApproved) (approvedBaselineTools ??= new Set()).add(name);');
    // Never blanket bypass: the voice lane passes no `bypass` to the lane factory.
    expect(src).not.toMatch(/bypass(Approval)?:\s*true/);
    expect(src).not.toMatch(/buildLaneFirewall\(\{[^}]*\bbypass\b/);
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
    const held = __heldApprovalsForTests();
    held.clear(); // module-level state: start from an empty hold table
    const row: HeldApproval = {
      tenantId: 't1', userId: 'user:opener', conversationId: 'conv-1',
      name: 'openwop:core.openwop.http.fetch', args: {}, heldAt: 0,
    };
    held.set('call-1:fc-1', row);

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
