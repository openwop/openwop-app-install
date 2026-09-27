/**
 * ADR 0724 — safe mode's egress-class gate guards an EMPTY population; imply it anyway,
 * and witness it against the REAL registered tool ids.
 *
 * ADR 0610 D5 (#3515) closed `PMC-1` with an opt-in `gateHostMediatedEgress` flag and a
 * witness that fed `'core.openwop.integration.email-send'` — a NODE type id. MEASURED after
 * a full boot: every registered agent tool id is `openwop:`-prefixed and NONE classifies as
 * `egress:'host-mediated'`, so the class gate cannot fire on any name the runtime presents,
 * in ANY lane. §D0 pins that population so the emptiness is visible, not silent; §D1 makes
 * the four lanes equal by construction (leg 1 is born-red on the pre-ADR hook); §D2 gives
 * the voice bridge's "gated exactly like a typed one" docblock the parity witness it lacked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { resolveToolCapability } from '../src/features/capability-firewall/toolCapabilityResolver.js';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';

/** The ADR 0610 witness name — a node type id the classifier keys on, NOT a registered tool id. */
const SYNTHETIC_EGRESS = 'core.openwop.integration.email-send';
/** The one REAL off-host egress agent tool. Gated by NAME (it is in SENSITIVE_APPROVAL_TOOLS). */
const HTTP_FETCH = 'openwop:core.openwop.http.fetch';
const CODE_EXEC = 'openwop:feature.code-exec.nodes.run';
const READ_TOOL = 'openwop:knowledge.search';

/** The literal option shape of the two lanes that never passed the flag (toolBridge.ts:141, routes/agents.ts:407). */
const asVoiceOrDispatchLane = () => buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: false });
/** The chat loop's shape (conversationToolLoop.ts:485) — passes the flag explicitly. */
const asChatLane = () => buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: false, gateHostMediatedEgress: true });

describe('ADR 0724 §D0 — the class gate\'s REAL population, pinned after a full boot', () => {
  let ids: readonly string[] = [];
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    ids = builtinAgentToolIds();
  });
  afterAll(() => { /* nothing listened */ });

  it('R1: the population is non-trivial (a boot that registers nothing would make every pin below vacuous)', () => {
    expect(ids.length).toBeGreaterThan(150);
  });
  it('R2: every registered agent tool id is `openwop:`-prefixed — the namespace the egress classifier does NOT key on', () => {
    expect(ids.filter((i) => !i.startsWith('openwop:'))).toEqual([]);
  });
  it('R3 (the ratchet): ZERO registered tools classify as host-mediated egress — the day this grows, decide ON PURPOSE whether safe mode asks, and revisit ADR 0724', () => {
    const egress = ids.filter((i) => resolveToolCapability(i)?.egress === 'host-mediated');
    expect(egress, 'a registered tool now classifies as egress: the class gate has a live population').toEqual([]);
  });
  it('R4: the ADR 0610 D5 witness name is NOT a registered tool id (that witness proved the hook contract on a synthetic name, not production)', () => {
    expect(ids).not.toContain(SYNTHETIC_EGRESS);
  });
  it('R5: the one real off-host egress agent tool IS registered, IS in the NAME set, and is (still) UNCLASSIFIED — pins the prefix mismatch the capability-firewall feature owns', () => {
    expect(ids).toContain(HTTP_FETCH);
    expect(SENSITIVE_APPROVAL_TOOLS.has(HTTP_FETCH)).toBe(true);
    // If a resolver normalization ever classifies this name, that reclassifies it from the
    // treat-as-risky fallback (host-mediated) to `safe-fetch` — a RULE relaxation. Revisit here.
    expect(resolveToolCapability(HTTP_FETCH)).toBeNull();
  });
  it('R6: and therefore it ASKS in the voice/dispatch shape today — the name set is the working half', () => {
    expect(asVoiceOrDispatchLane().evaluate([], HTTP_FETCH).decision).toBe('require-approval');
  });
});

describe('ADR 0724 §D1 — safe posture IMPLIES the class gate (hook contract, synthetic egress name)', () => {
  it('control: the synthetic egress name is classified host-mediated and is NOT in the name set (so only the CLASS gate can catch it)', () => {
    expect(resolveToolCapability(SYNTHETIC_EGRESS)?.egress).toBe('host-mediated');
    expect(SENSITIVE_APPROVAL_TOOLS.has(SYNTHETIC_EGRESS)).toBe(false);
  });
  it('leg 1 (BORN RED): a hook built exactly like the voice/dispatch lanes — no flag — gates the egress class', () => {
    expect(asVoiceOrDispatchLane().evaluate([], SYNTHETIC_EGRESS).decision).toBe('require-approval');
  });
  it('leg 2: an explicit `gateHostMediatedEgress:false` is a legible opt-out', () => {
    const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, gateHostMediatedEgress: false });
    expect(hook.evaluate([], SYNTHETIC_EGRESS).decision).toBe('allow');
  });
  it('leg 3: a hook with NO safe posture (rules-only) is unchanged — the class gate is a safe-mode property', () => {
    expect(buildFirewallHook({ rules: [] }).evaluate([], SYNTHETIC_EGRESS).decision).toBe('allow');
  });
  it('leg 4: bypass still downgrades the implied gate, exactly as it downgrades the name gate', () => {
    const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: true });
    expect(hook.evaluate([], SYNTHETIC_EGRESS).decision).toBe('allow');
    expect(hook.evaluate([], HTTP_FETCH).decision).toBe('allow');
  });
  it('leg 5: an unclassified read stays allowed under the implied gate — no mass over-block', () => {
    expect(asVoiceOrDispatchLane().evaluate([], READ_TOOL).decision).toBe('allow');
    expect(asVoiceOrDispatchLane().evaluate([], 'openwop:documents.get').decision).toBe('allow');
  });
});

describe('ADR 0724 §D2 — voice/dispatch ⇔ chat firewall PARITY (the witness toolBridge.ts:5 claims)', () => {
  it('the same names get the same verdict from the voice/dispatch shape and the chat shape', () => {
    const a = asVoiceOrDispatchLane(); const b = asChatLane();
    for (const name of [HTTP_FETCH, CODE_EXEC, READ_TOOL, SYNTHETIC_EGRESS, 'openwop:core.files.write', 'openwop:email.draft']) {
      expect(a.evaluate([], name).decision, name).toBe(b.evaluate([], name).decision);
    }
  });
});
