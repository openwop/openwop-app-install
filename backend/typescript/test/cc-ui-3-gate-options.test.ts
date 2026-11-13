/**
 * CC-UI-3 — an approval gate shows the deliverable, not a stray scalar.
 *
 * Observed on 373d4863a: the kernel-regenerate gate showed only "PriorKernelAt:
 * 2026-11-12T01:48:39Z" and every channel gate only "ItemsKey: emails" — the drafted
 * kernel / emails were visible nowhere before approval. `core.approvalGate` turned EVERY
 * string-valued input into an `options` entry; the upstream generate nodes emit exactly
 * one string scalar beside their object deliverable, so a one-entry "picker" was built,
 * and the shared `GateEvidence` skips the artifact fetch whenever inline options exist.
 * The producer's own contract (and `ApprovalCard`'s `hasOptions`) is ≥2 alternatives.
 *
 * Pins: one string beside structured data → no `options` (the artifact renders);
 * controls: a lone string draft stays inline, and the multi-critic fan-in (≥2 string
 * ports) keeps its picker.
 * Red before: the first two cases carry a single option.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';

beforeAll(() => ensureNodesRegistered());

async function gateData(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mod = getNodeRegistry().get('core.approvalGate')!;
  const out = await mod.execute({ config: { prompt: 'Review' }, inputs } as unknown as NodeContext) as { interrupt?: { data?: Record<string, unknown> } };
  return out.interrupt!.data!;
}

describe('CC-UI-3 — approval gate options', () => {
  it('kernel regenerate: kernel object + one priorKernelAt string → no options', async () => {
    const data = await gateData({ kernel: { headline: 'H', primaryCta: 'C' }, briefVersion: 5, priorKernelAt: '2026-11-12T01:48:39.685Z' });
    expect(data.options).toBeUndefined();
  });

  it('channel: draft object + one itemsKey string → no options', async () => {
    const data = await gateData({ draft: { emails: [{ subject: 's' }] }, qualityReport: {}, itemsKey: 'emails' });
    expect(data.options).toBeUndefined();
  });

  it('a lone string draft (no structured sibling) is still shown inline', async () => {
    const data = await gateData({ draft: 'To: team@acme.com\nSubject: Hi\n\nBody.' });
    expect(data.options).toEqual([{ key: 'draft', label: 'Draft', content: 'To: team@acme.com\nSubject: Hi\n\nBody.' }]);
  });

  it('multi-critic fan-in (two string ports) keeps its picker', async () => {
    const data = await gateData({ critic_clarity: 'Draft A', critic_tone: 'Draft B' });
    expect(data.options).toEqual([
      { key: 'critic_clarity', label: 'Critic Clarity', content: 'Draft A' },
      { key: 'critic_tone', label: 'Critic Tone', content: 'Draft B' },
    ]);
  });
});
