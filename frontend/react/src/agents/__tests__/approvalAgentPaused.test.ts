/**
 * ADR 0775 P3a — claiming a paused agent's proposal is `409 conflict` with
 * `details.reason: 'agent_paused'`. The inbox maps every unrecognized 409 to
 * "Someone already decided this one", which would be false here: the approval
 * is still pending and runs once the agent is resumed.
 *
 * Sabotage-witnessed (wave 51): delete the `agent_paused` branch in
 * `approvalErrorInfo` → case 1 red; drop the `conflict` fallback → case 2 red.
 */
import { describe, expect, it } from 'vitest';
import { ApprovalApiError, approvalErrorInfo } from '../approvalsClient.js';

describe('approvalErrorInfo — agent_paused', () => {
  it('maps agent_paused to "paused, still pending", not "already decided"', () => {
    const paused = new ApprovalApiError('This agent is paused.', 'conflict', 409, { reason: 'agent_paused' });
    expect(approvalErrorInfo(paused)).toEqual({ key: 'approvalAgentPaused' });
  });

  // Twin: features/strategy/__tests__/strategyR5Adr0845.test.tsx:162 asserts the same
  // fallback; it stays here as THIS file's control (same error code, no reason).
  it('a 409 with no reason is still "already decided" (control)', () => {
    expect(approvalErrorInfo(new ApprovalApiError('x', 'conflict', 409))).toEqual({ key: 'approvalAlreadyDecided' });
  });
});
