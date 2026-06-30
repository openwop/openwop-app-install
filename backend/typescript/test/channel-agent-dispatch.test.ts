/**
 * ADR 0154 Phase 4 — channel agent-turn targeting + workflow registration.
 */
import { describe, it, expect } from 'vitest';
import { selectChannelTurnTargets } from '../src/features/channels/channelAgentDispatch.js';
import { CHANNEL_TURN_WORKFLOW_ID, seedChannelTurnWorkflow } from '../src/features/channels/channelTurnWorkflow.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';

describe('selectChannelTurnTargets', () => {
  it('returns [] with no agent members', () => {
    expect(selectChannelTurnTargets([], 'hello @anyone')).toEqual([]);
  });
  it('auto-targets the sole agent member when there is no @mention', () => {
    expect(selectChannelTurnTargets(['helper'], 'what is the status?')).toEqual(['helper']);
  });
  it('targets an explicitly @mentioned agent member', () => {
    expect(selectChannelTurnTargets(['helper', 'analyst'], 'hey @analyst look')).toEqual(['analyst']);
  });
  it('targets nobody for an unmatched @mention among multiple agents', () => {
    expect(selectChannelTurnTargets(['helper', 'analyst'], 'hey @nobody')).toEqual([]);
  });
  it('matches a @mention case-insensitively', () => {
    expect(selectChannelTurnTargets(['Helper'], 'ping @helper')).toEqual(['Helper']);
  });
  it('can target multiple mentioned agents', () => {
    expect(selectChannelTurnTargets(['a', 'b', 'c'], '@a and @c please').sort()).toEqual(['a', 'c']);
  });
});

describe('channel turn workflow registration', () => {
  it('seeds openwop-app.channel.turn idempotently', () => {
    seedChannelTurnWorkflow();
    seedChannelTurnWorkflow();
    expect(getRegisteredWorkflow(CHANNEL_TURN_WORKFLOW_ID)).toBeTruthy();
  });
});
