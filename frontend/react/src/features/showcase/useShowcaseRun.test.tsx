import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShowcaseRun } from './useShowcaseRun.js';
import { CHAIN_ID } from './model.js';
const mocks = vi.hoisted(() => ({ get:vi.fn(), poll:vi.fn(), definition:vi.fn(), interrupts:vi.fn(), subscribe:vi.fn(), close:vi.fn() }));
vi.mock('../../client/runsClient.js',()=>({getRun:mocks.get,pollEvents:mocks.poll}));
vi.mock('../../client/workflowsClient.js',()=>({getWorkflowDefinitionRaw:mocks.definition}));
vi.mock('../../client/interruptsClient.js',()=>({listOpenInterrupts:mocks.interrupts}));
vi.mock('../../client/streamsClient.js',()=>({subscribeToRun:mocks.subscribe}));
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({runId:'r',workflowId:'w',status:'running'});
  mocks.poll.mockResolvedValue({events:[]});
  mocks.definition.mockResolvedValue({metadata:{chainId:CHAIN_ID}});
  mocks.interrupts.mockResolvedValue([]);
  mocks.subscribe.mockReturnValue({close:mocks.close});
});
afterEach(()=>vi.useRealTimers());
describe('showcase recovery',()=>{
  it('reconnects after an initial failed read when the user retries',async()=>{
    mocks.get.mockRejectedValueOnce(new Error('Offline'));
    const {result,unmount}=renderHook(()=>useShowcaseRun('r'));
    await waitFor(()=>expect(result.current.error).toBe('Offline'));
    expect(mocks.subscribe).not.toHaveBeenCalled();
    act(()=>result.current.refresh());
    await waitFor(()=>expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    expect(result.current.snapshot?.status).toBe('running');
    expect(result.current.error).toBeNull();
    unmount(); expect(mocks.close).toHaveBeenCalled();
  });
  it('never subscribes to or projects another kind of workflow',async()=>{
    mocks.definition.mockResolvedValue({metadata:{chainId:'other'}});
    const {result}=renderHook(()=>useShowcaseRun('r'));
    await waitFor(()=>expect(result.current.error).toContain('not a launch showcase'));
    expect(result.current.snapshot).toBeNull();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
  it('restores terminal runs without opening a live connection',async()=>{
    mocks.get.mockResolvedValue({runId:'r',workflowId:'w',status:'completed'});
    const {result}=renderHook(()=>useShowcaseRun('r'));
    await waitFor(()=>expect(result.current.snapshot?.status).toBe('completed'));
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
  it('drops late responses after navigating away from a run',async()=>{
    let resolve!: (value:unknown)=>void;
    mocks.get.mockReturnValue(new Promise(r=>{resolve=r;}));
    const {result,rerender}=renderHook(({id}:{id:string|null})=>useShowcaseRun(id),{initialProps:{id:'r' as string|null}});
    rerender({id:null});
    await act(async()=>{resolve({runId:'r',workflowId:'w',status:'running'});});
    expect(result.current.snapshot).toBeNull();
    expect(result.current.events).toEqual([]);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});
