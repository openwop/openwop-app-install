/**
 * ADR 0759 — `useShowcaseRun` hydrates a run, VALIDATES it is a launch showcase,
 * and only then subscribes; terminal runs never open a live connection; a response
 * that lands after navigating away is dropped; Retry recovers from a failed read.
 *
 * Sabotage map (round-1 witnessed): drop the `isShowcaseDefinition` check → "never
 * subscribes to … another kind"; drop `finished` from the subscribe guard →
 * "restores terminal runs"; drop the post-await `!active` return → "drops late
 * responses"; drop `subscription?.close()` in cleanup → "reconnects after …".
 * "error clears on retry" is a DOUBLE GUARD by design: the effect resets `error`
 * on the nonce change AND `hydrate` clears it on success (round-1 probe
 * w52g3-run-retryclear was vacuous for that reason). The two writers sit in
 * separate statements, so no single sabotage removes both; the probe sits instead on
 * the piece both depend on, `refresh` bumping the nonce (w52g3-run-refresh-r2).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollEventsResponse, RunSnapshot, RunStatus } from '@openwop/openwop';
import type { getRun, pollEvents } from '../../client/runsClient.js';
import type { getWorkflowDefinitionRaw } from '../../client/workflowsClient.js';
import type { listOpenInterrupts } from '../../client/interruptsClient.js';
import type { subscribeToRun } from '../../client/streamsClient.js';
import { useShowcaseRun } from './useShowcaseRun.js';
import { CHAIN_ID } from './model.js';

const mocks = vi.hoisted(() => ({
  get: vi.fn<typeof getRun>(),
  poll: vi.fn<typeof pollEvents>(),
  definition: vi.fn<typeof getWorkflowDefinitionRaw>(),
  interrupts: vi.fn<typeof listOpenInterrupts>(),
  subscribe: vi.fn<typeof subscribeToRun>(),
  close: vi.fn<() => void>(),
}));
vi.mock('../../client/runsClient.js',()=>({getRun:mocks.get,pollEvents:mocks.poll}));
vi.mock('../../client/workflowsClient.js',()=>({getWorkflowDefinitionRaw:mocks.definition}));
vi.mock('../../client/interruptsClient.js',()=>({listOpenInterrupts:mocks.interrupts}));
vi.mock('../../client/streamsClient.js',()=>({subscribeToRun:mocks.subscribe}));

const snap = (status: RunStatus): RunSnapshot => ({
  runId: 'r', workflowId: 'w', status, eventLogSchemaVersion: 3,
  owner: { tenant: 't', subject: { issuer: 'urn:openwop:test', subjectId: 'u1', tenant: 't', lane: 'session', kind: 'user' } },
});
const emptyLog: PollEventsResponse = { runId: 'r', events: [], lastSequence: -1, status: 'running', isTerminal: false };
/** Let the hydrate → .then(subscribe) chain settle (it is a few awaits deep). */
const drain = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

beforeEach(()=>{
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.get.mockResolvedValue(snap('running'));
  mocks.poll.mockResolvedValue(emptyLog);
  mocks.definition.mockResolvedValue({metadata:{chainId:CHAIN_ID}});
  mocks.interrupts.mockResolvedValue([]);
  mocks.subscribe.mockReturnValue({close:mocks.close});
});

describe('showcase recovery',()=>{
  it('reconnects after an initial failed read when the user retries',async()=>{
    mocks.get.mockRejectedValueOnce(new Error('Offline'));
    const {result,unmount}=renderHook(()=>useShowcaseRun('r'));
    await waitFor(()=>expect(result.current.error).toBe('Offline'));
    await drain();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    act(()=>result.current.refresh());
    await waitFor(()=>expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    expect(mocks.subscribe.mock.calls[0]?.[0]).toBe('r');
    expect(result.current.snapshot?.status).toBe('running');
    expect(result.current.error).toBeNull();
    unmount(); expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('never subscribes to or projects another kind of workflow',async()=>{
    mocks.definition.mockResolvedValue({metadata:{chainId:'other'}});
    const {result}=renderHook(()=>useShowcaseRun('r'));
    await waitFor(()=>expect(result.current.error).toBe('This run is not a launch showcase. Open it in Runs to inspect its workflow.'));
    await drain();
    expect(result.current.snapshot).toBeNull();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
  it('restores terminal runs without opening a live connection',async()=>{
    mocks.get.mockResolvedValue(snap('completed'));
    const {result}=renderHook(()=>useShowcaseRun('r'));
    await waitFor(()=>expect(result.current.snapshot?.status).toBe('completed'));
    await drain();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
  it('drops late responses after navigating away from a run',async()=>{
    let resolve!: (value:RunSnapshot)=>void;
    mocks.get.mockReturnValue(new Promise<RunSnapshot>(r=>{resolve=r;}));
    const {result,rerender}=renderHook(({id}:{id:string|null})=>useShowcaseRun(id),{initialProps:{id:'r' as string|null}});
    rerender({id:null});
    await act(async()=>{resolve(snap('running'));});
    // The late response must have travelled the whole hydrate path before absence means anything.
    await waitFor(()=>expect(mocks.definition).toHaveBeenCalledTimes(1));
    await drain();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.events).toEqual([]);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});
