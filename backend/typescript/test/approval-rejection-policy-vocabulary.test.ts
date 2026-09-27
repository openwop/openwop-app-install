/**
 * ADR 0600 §6 (`ISU-11` / `ISC-13` / `ISWF-13`) — `rejectionPolicy` is a
 * closed world on the AUTHORING side and a coerced read on the RESOLVE side.
 *
 * The defect PR-A left open: `insights-suite` shipped `rejectionPolicy:"block"`,
 * a token in NEITHER vocabulary. PR-A's review verified it was inert (both
 * readers do `x === 'majority' ? 'majority' : 'any'`, so anything-not-majority
 * became the strictest setting anyway) and PR-A deleted the value. What it did
 * NOT fix is why nobody noticed for months: the value was ACCEPTED. It read as a
 * deliberate safety choice in a chain a human opens in the Builder, it enforced
 * nothing, and editing it to any other invented word would have behaved
 * identically. A decorative control that looks like a safety control is the
 * defect, and the honest cure is a refusal, not a different default.
 *
 * The asymmetry is the whole design, so both halves are asserted:
 *   WRITER (`core.approvalGate`) REFUSES  — a human can still fix it.
 *   READER (resolve-time)        COERCES — it reads an already-persisted
 *   interrupt, and refusing there would strand a live gate with no exit.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import {
  normalizeRejectionPolicy, readRejectionPolicy, AUTHORED_REJECTION_POLICIES,
} from '../src/host/reviewDecisionLedger.js';
import type { NodeContext } from '../src/executor/types.js';

beforeAll(() => ensureNodesRegistered());

async function gate(config: Record<string, unknown>) {
  const mod = getNodeRegistry().get('core.approvalGate')!;
  return mod.execute({ config, inputs: {} } as unknown as NodeContext);
}

describe('core.approvalGate — the WRITER refuses an unrecognized rejectionPolicy', () => {
  it('"block" — the literal value insights-suite shipped — is a typed failure', async () => {
    const out = await gate({ prompt: 'Confirm the variance figures.', rejectionPolicy: 'block' });
    expect(out.status).toBe('failure');
    expect((out as { error?: { code?: string } }).error?.code).toBe('invalid_config');
    expect((out as { error?: { message?: string } }).error?.message).toMatch(/single-veto/);
  });

  it('every token in BOTH live vocabularies is accepted (the polarity)', async () => {
    // A refusal that also refuses the legal values is not a fix. `single-veto`
    // is the WIRE schema's own DEFAULT; `any` is this host's internal spelling
    // of the same behaviour. Refusing either would have been the worse bug.
    for (const value of AUTHORED_REJECTION_POLICIES) {
      const out = await gate({ prompt: 'p', rejectionPolicy: value });
      expect(out.status, `rejectionPolicy:${value} must be accepted`).toBe('suspended');
    }
  });

  it('an ABSENT rejectionPolicy is still fine — the field is optional', async () => {
    expect((await gate({ prompt: 'p' })).status).toBe('suspended');
  });

  it('a non-string value is refused too, not silently ignored', async () => {
    expect((await gate({ prompt: 'p', rejectionPolicy: 3 })).status).toBe('failure');
  });
});

describe('normalizeRejectionPolicy / readRejectionPolicy — one vocabulary, two postures', () => {
  it('the two wire/host spellings of "one reject vetoes" both map to `any`', () => {
    expect(normalizeRejectionPolicy('single-veto')).toBe('any');
    expect(normalizeRejectionPolicy('any')).toBe('any');
    expect(normalizeRejectionPolicy('majority')).toBe('majority');
  });

  it('an unrecognized token is `null` from the writer helper — NOT the default', () => {
    // Returning `'any'` here is exactly the silent coercion being retired; the
    // distinction between "unset" and "unrecognized" has to survive the helper
    // or the caller cannot refuse.
    expect(normalizeRejectionPolicy('block')).toBeNull();
    expect(normalizeRejectionPolicy(undefined)).toBeNull();
  });

  it('the RESOLVE-side reader still coerces, so a persisted gate is never stranded', () => {
    expect(readRejectionPolicy('block')).toBe('any');
    expect(readRejectionPolicy(undefined)).toBe('any');
    expect(readRejectionPolicy('majority')).toBe('majority');
  });
});

/**
 * ADR 0600 §Correction 9 (`LOW-1`) — `core.approvalGate` is NOT the only writer.
 *
 * §6 said the refusal sits on *"the ONE choke both authoring lanes pass
 * through"*. True of the NODE, false of the FIELD: `core.interrupt` forwards
 * `config.data` **verbatim**, and `host/reviewDecisionLedger.tallyVote` +
 * `host/reviewProjection` both read `data.rejectionPolicy` off any approval
 * interrupt without asking which node raised it. So the exact defect §6 closed
 * stayed authorable through the PACK lane — **which is the lane
 * `rejectionPolicy:"block"` actually shipped through.**
 *
 * Blast radius measured before enforcing: ZERO `core.interrupt` nodes carry a
 * `rejectionPolicy` anywhere in the repo (the single fixture,
 * `conformance-interrupt-external-event.json`, is `kind:"external-event"` and
 * carries none).
 */
async function interruptNode(config: Record<string, unknown>) {
  const mod = getNodeRegistry().get('core.interrupt')!;
  return mod.execute({ config, inputs: {} } as unknown as NodeContext);
}

describe('core.interrupt — the SECOND writer, refusing by the same rule', () => {
  it('"block" through the verbatim `config.data` lane is a typed failure too', async () => {
    const out = await interruptNode({ kind: 'approval', data: { prompt: 'Approve?', requiredApprovals: 3, rejectionPolicy: 'block' } });
    expect(out.status).toBe('failure');
    expect((out as { error?: { code?: string } }).error?.code).toBe('invalid_config');
    // The message NAMES the node that refused — two writers, one rule, and a
    // reader must be able to tell which one they are looking at.
    expect((out as { error?: { message?: string } }).error?.message).toMatch(/^core\.interrupt: /);
  });

  it('every legal token still suspends, and so does an interrupt with no policy (the polarity)', async () => {
    for (const token of AUTHORED_REJECTION_POLICIES) {
      const out = await interruptNode({ kind: 'approval', data: { prompt: 'Approve?', rejectionPolicy: token } });
      expect(out.status, `${token} must be accepted`).toBe('suspended');
    }
    expect((await interruptNode({ kind: 'clarification', data: { question: 'Which?' } })).status).toBe('suspended');
    // …and the non-object / absent `data` shapes are untouched.
    expect((await interruptNode({ kind: 'external-event' })).status).toBe('suspended');
  });

  it('the refusal is not gated on `kind` — the projection reads the field regardless', async () => {
    // `host/reviewProjection` pulls `data.rejectionPolicy` without consulting the
    // kind, so gating the guard on `kind === 'approval'` would close the lane for
    // one value of a discriminator and leave it open for the others.
    const out = await interruptNode({ kind: 'clarification', data: { question: 'Which?', rejectionPolicy: 'block' } });
    expect(out.status).toBe('failure');
  });
});
