/**
 * A7 (ADR 0467 follow-on) — the in-voice approval card's ONE-SHOT approve.
 *
 * The browser-relay voice transport shows an approval card when a SENSITIVE
 * tool hits the firewall's require-approval verdict; Approve re-invokes the
 * tool call with `userApproved`. Since ADR 0834 FW2-D1 the bridge hands the lane
 * factory a per-call `grant` (not the by-name `approvedTools` sets): the card's
 * one-shot answers a `baseline` ask for this call's own canonical tool, never a
 * `policy` ask. Three invariants:
 *
 *  1. semantics — the firewall consults the grant ONLY for a require-approval
 *     verdict, asking about the tool it is evaluating; a hard deny (tenant rule /
 *     platform floor / enforce default) is NEVER bypassed, by the grant or by
 *     either by-name set other lanes still feed;
 *  2. bridge wiring — `userApproved` becomes that one-shot grant (never blanket
 *     `bypass`): the card is client-asserted, so it answers only the user's own
 *     safe-mode ask, never a workspace/platform/enforce ask (ADR 0834 D2);
 *  3. route authority — the flag is honored only for a session with a BOUND
 *     human (`resolved.userId`); a user-less session cannot self-approve.
 *
 * WHAT IS BEHAVIOURAL AND WHAT IS NOT. Invariant 1 and the sideband's
 * authority/lifecycle are driven through the real functions. The grant below is a
 * fixture shaped like the bridge's (its predicate is NOT exported); the predicate
 * itself is driven live through `executeRealtimeToolCall` in
 * `adr0834-firewall-exit-witness.test.ts` ("control: userApproved answers the
 * safe-mode baseline ask", "userApproved does NOT answer a platform-floor ask"), so
 * its substring pin here was retired (TST-OAG-2, 2026-11-22); the second block keeps
 * the no-blanket-bypass scan. Invariant 3 is a source tripwire on `routes.ts`, and
 * is now also driven over HTTP in `adr0893-voice-session-authority.test.ts` ("A7 — a
 * user-less session cannot self-approve over /tool-call").
 *
 * Re-graded at grade-tests w117: the semantics block used to drive the by-name
 * `approvedBaselineTools` set, which the voice lane stopped feeding at FW2-D1, so
 * the grant branch the card rides could break with this file green. The bypass
 * check now reads the whole `buildLaneFirewall({...})` call: the old `[^}]*` scan
 * stopped at the `}` of `${input.sessionId}`, so a `bypass` added after it passed.
 *
 * Witnessed (w8f): va-deny-bypassed, va-sideband-cross-tenant,
 * va-sideband-any-human, va-sideband-not-consumed, va-route-unbound-human (source
 * tripwire).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildFirewallHook,
  SENSITIVE_APPROVAL_TOOLS,
  type FirewallApprovalGrant,
} from '../src/features/capability-firewall/firewallHook.js';
import type { ApprovalOrigin } from '../src/features/capability-firewall/types.js';
// STATIC import (wave-9 lesson): the in-case `await import()` of this module's
// graph cost 4.3 s of the case's own budget (8f W4 baseline).
import { resolveHeldSidebandCall, __heldApprovalsForTests } from '../src/features/voice/realtime/openaiSideband.js';

/** The sideband's held-approval row, read off the test seam's own type (the
 *  interface itself is module-private), so the fixture is checked by tsc. */
type HeldApproval = Parameters<ReturnType<typeof __heldApprovalsForTests>['set']>[1];

const CODE_EXEC_ID = 'openwop:feature.code-exec.nodes.run';
const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

/** A grant shaped like the one `toolBridge.ts` builds for one voice call: the card's
 *  one-shot (`userApproved`) answers a non-`policy` ask for the call's own tool. It
 *  records every ask, so a case can assert what the firewall asked. */
type Ask = [tool: string, origin: ApprovalOrigin | undefined];
const cardGrant = (callTool: string, userApproved: boolean, asked: Ask[]): FirewallApprovalGrant => ({
  check: (tool, origin) => {
    asked.push([tool, origin]);
    return userApproved && tool === callTool && origin !== 'policy';
  },
});

describe('A7 — one-shot approvedTools semantics (the voice card\'s Approve)', () => {
  const voiceHook = (callTool: string, userApproved: boolean, asked: Ask[]) =>
    buildFirewallHook({
      rules: [],
      requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
      bypassApproval: false,
      grant: cardGrant(callTool, userApproved, asked),
    });

  it('without the one-shot, a SENSITIVE tool stays require-approval (the card trigger)', () => {
    const asked: Ask[] = [];
    expect(voiceHook(CODE_EXEC_ID, false, asked).evaluate([], CODE_EXEC_ID, {}, 'k1').decision).toBe('require-approval');
    expect(asked).toEqual([[CODE_EXEC_ID, 'baseline']]); // asked, as a safe-mode ask, and refused
  });

  it('the one-shot downgrades require-approval → allow for exactly that tool', () => {
    const asked: Ask[] = [];
    expect(voiceHook(CODE_EXEC_ID, true, asked).evaluate([], CODE_EXEC_ID, {}, 'k1').decision).toBe('allow');
    expect(asked).toEqual([[CODE_EXEC_ID, 'baseline']]);
  });

  it('the one-shot is per-tool — a DIFFERENT sensitive tool still requires approval', () => {
    // ADR 0834 D4 — this used `openwop:core.files.write`, which no agent tool ever
    // registered (removed from the set); http.fetch is a real member.
    const asked: Ask[] = [];
    expect(voiceHook(CODE_EXEC_ID, true, asked).evaluate([], 'openwop:core.openwop.http.fetch', {}, 'k1').decision).toBe('require-approval');
    expect(asked).toEqual([['openwop:core.openwop.http.fetch', 'baseline']]); // the firewall asks about the tool it evaluates
  });

  it('a hard deny (enforce-mode floor) is NEVER bypassed by the one-shot', () => {
    // The one-shot downgrades ONLY require-approval; an enforce-mode deny for an
    // unmatched action must survive an approval entry for the same tool — in the
    // policy set (`approvedTools`), in the baseline set (`approvedBaselineTools`, ADR
    // 0834 D2) AND in the per-call grant the voice card actually rides (FW2-D1), here
    // one that would answer yes to anything it were asked.
    const grant: FirewallApprovalGrant = { check: () => true };
    for (const approval of [{ approvedTools: new Set([CODE_EXEC_ID]) }, { approvedBaselineTools: new Set([CODE_EXEC_ID]) }, { grant }]) {
      const hook = buildFirewallHook({
        rules: [],
        requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
        bypassApproval: false,
        ...approval,
        mode: 'enforce',
        defaultDenyVerdict: 'deny',
      });
      expect(hook.evaluate([], CODE_EXEC_ID, {}, 'k1').decision, Object.keys(approval)[0]).toBe('deny');
    }
  });
});

describe('A7 — wiring pins (source-level, the voice-tool-parity idiom)', () => {
  it('the bridge maps userApproved to a one-shot grant, never a blanket bypass', () => {
    const src = srcOf('features/voice/realtime/toolBridge.ts');
    // The grant's predicate (this tool, this call, never a policy ask) is driven live in
    // adr0834-firewall-exit-witness; its substring pin here was retired (TST-OAG-2).
    // Never blanket bypass: the voice lane passes no `bypass` to the lane factory. Read
    // the WHOLE call (to its closing `});`), since its args contain a template `}`.
    expect(src).not.toMatch(/bypass(Approval)?:\s*true/);
    const laneCall = /buildLaneFirewall\(\{[\s\S]*?\n\s*\}\);/.exec(src)?.[0] ?? '';
    expect(laneCall).toContain('grant'); // positive control: the call was found
    expect(laneCall).not.toMatch(/\bbypass\b/);
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
