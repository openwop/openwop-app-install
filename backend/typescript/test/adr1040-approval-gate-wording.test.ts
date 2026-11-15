/**
 * ADR 1040 D7 F1 (Book AI P47) — a feature's wording on `core.approvalGate`.
 *
 *  - `actionLabels`, `promptKey` and `declineExpected` reach the interrupt
 *    RECORD's data, exactly as configured;
 *  - malformed wording is refused at the writer (`invalid_config`), including a
 *    label for a verb the gate does not list (a label renames, never adds);
 *  - the `interrupt.requested` approval projection (the wire) carries NONE of
 *    them: ApprovalData is closed (`suspend-request.schema.json`).
 *
 * Red when: the node stops merging the wording (bootstrap/nodes.ts), the
 * validator accepts free text or an unlisted verb (host/approvalGateWording.ts),
 * or the approval projector starts copying unknown keys
 * (executor/interruptRequestedPayload.ts).
 */
import { describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { buildInterruptRequestedPayload, GATE_PREVIEW_ARTIFACT_TYPE } from '../src/executor/interruptRequestedPayload.js';
import type { NodeContext } from '../src/executor/types.js';
import { interruptToReview } from '../src/host/reviewProjection.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function ctx(config: Record<string, unknown>): NodeContext {
  return {
    runId: 'r', nodeId: 'gate', tenantId: 't', inputs: {}, config, configurable: {},
    attempt: 1, secrets: {},
    emit: async () => ({ eventId: 'e', sequence: 0 }),
  };
}

async function run(config: Record<string, unknown>, typeId = 'core.approvalGate') {
  ensureNodesRegistered();
  const node = getNodeRegistry().get(typeId);
  expect(node).not.toBeNull();
  return node!.execute(ctx(config));
}

const WORDING = {
  actions: ['approve', 'reject'],
  actionLabels: { approve: 'bookai:useEdits', reject: 'bookai:keepMine' },
  promptKey: 'bookai:gatePrompt',
  declineExpected: true,
};

describe('core.approvalGate wording', () => {
  it('reaches the interrupt record data as configured', async () => {
    const out = await run({ prompt: 'Apply the edits?', ...WORDING });
    expect(out.status).toBe('suspended');
    const data = (out as { interrupt: { data: Record<string, unknown> } }).interrupt.data;
    expect(data).toMatchObject({ prompt: 'Apply the edits?', actions: ['approve', 'reject'], actionLabels: WORDING.actionLabels, promptKey: 'bookai:gatePrompt', declineExpected: true });
  });

  it('is absent when not configured (no change for existing gates)', async () => {
    const out = await run({ prompt: 'Go?' });
    const data = (out as { interrupt: { data: Record<string, unknown> } }).interrupt.data;
    expect(data).not.toHaveProperty('actionLabels');
    expect(data).not.toHaveProperty('promptKey');
    expect(data).not.toHaveProperty('declineExpected');
  });

  it('refuses malformed wording where an author can fix it', async () => {
    for (const bad of [
      { actionLabels: { approve: 'Use these edits' } },          // free text, not a key
      { actionLabels: { escalate: 'bookai:escalate' } },         // a verb the gate does not list
      { actionLabels: ['bookai:x'] },
      { promptKey: '<b>hi</b>' },
      { declineExpected: 'yes' },
    ]) {
      const out = await run({ actions: ['approve', 'reject'], ...bad });
      expect(out, JSON.stringify(bad)).toMatchObject({ status: 'failure', error: { code: 'invalid_config' } });
    }
  });

  it('the pack lane (core.interrupt forwards config.data) is refused by the same validator', async () => {
    const ok = await run({ kind: 'approval', data: { prompt: 'Go?', ...WORDING } }, 'core.interrupt');
    expect(ok.status).toBe('suspended');
    const bad = await run({ kind: 'approval', data: { prompt: 'Go?', actions: ['approve', 'reject'], actionLabels: { reject: 'Use edits' } } }, 'core.interrupt');
    expect(bad).toMatchObject({ status: 'failure', error: { code: 'invalid_config' } });
  });

  it('the review record carries the same wording, closed to these three fields', async () => {
    const out = await run({ prompt: 'Apply the edits?', ...WORDING });
    const data = (out as { interrupt: { data: Record<string, unknown> } }).interrupt.data;
    const it0: InterruptRecord = { interruptId: 'i-1', runId: 'r-1', nodeId: 'gate', kind: 'approval', token: 't', data: { ...data, secretish: 'x' }, createdAt: '2026-11-03T00:00:00Z' };
    const runRec = { runId: 'r-1', tenantId: 't', workflowId: 'wf', status: 'suspended', metadata: {} } as unknown as RunRecord;
    const review = interruptToReview(it0, runRec);
    expect(review.gateWording).toEqual({ actionLabels: WORDING.actionLabels, promptKey: 'bookai:gatePrompt', declineExpected: true });
    // A malformed record (an older writer) projects nothing rather than something unchecked.
    const bad = interruptToReview({ ...it0, data: { ...data, actionLabels: { approve: '<b>x</b>' } } }, runRec);
    expect(bad.gateWording).toBeUndefined();
  });

  it('the server and the card accept exactly the same key shape', () => {
    const be = readFileSync(join(process.cwd(), 'src', 'host', 'approvalGateWording.ts'), 'utf8');
    const fe = readFileSync(join(process.cwd(), '..', '..', 'frontend', 'react', 'src', 'chat', 'reviews', 'gateWording.ts'), 'utf8');
    const re = /const I18N_KEY = (\/.+\/);/;
    expect(re.exec(be)?.[1]).toBeDefined();
    expect(re.exec(fe)?.[1]).toBe(re.exec(be)?.[1]);
  });

  it('never reaches the closed approval projection on the wire', async () => {
    const out = await run({ title: 'Apply the edits?', ...WORDING });
    const data = (out as { interrupt: { data: Record<string, unknown> } }).interrupt.data;
    const payload = buildInterruptRequestedPayload({
      runId: 'r', nodeId: 'gate', kind: 'approval', data,
      preview: { artifactId: 'art-1', artifactType: GATE_PREVIEW_ARTIFACT_TYPE },
    });
    expect(payload.kind).toBe('approval');
    const wire = JSON.stringify(payload);
    for (const k of ['actionLabels', 'promptKey', 'declineExpected', 'bookai:']) expect(wire).not.toContain(k);
  });
});
