/**
 * WF-AKM-3 / WF-AKM-6 / MEM-UX-14 (ADR 0587 §4) — a failed read is not an empty one,
 * ON THE LANES A MODEL READS.
 *
 * ADR 0583 built `failedSources` and applied it one level DOWN. What was left:
 *
 *   - `retrieveForAgent` returned `status:'success'` + `hasResults:false` +
 *     `failedSources:[]` for a NON-EXISTENT agent, a capability-off agent and a
 *     genuinely empty corpus ALIKE. Its own docblock states the rule it broke.
 *   - NONE of the three lanes a model reads knowledge on passed `onSourceError`.
 *     Live dispatch did `log.warn` + `chunks = []`; chat/voice compose was a bare
 *     `catch { return '' }` with NO LOG AT ALL; the AI workflow node wrapped that
 *     in a third silent `catch {}`. The two lanes that DID report were a REST
 *     preview and a node output zero chains consume.
 *   - `agentDispatch` swallowed a memory-read failure into `entries = []`, so
 *     THE MODEL'S REPLY ITSELF was the false empty — the widget layer had already
 *     learned this lesson (a `failed` flag, a `storedUnknown` counter, copy reading
 *     "This is a failed read, not an empty memory"); dispatch had not.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { retrieveForAgent } from '../src/features/agent-knowledge/service.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import {
  composeAgentKnowledgeContext,
  composeBorrowedRecallContext,
  diagnoseAgentKnowledgeRetrieve,
} from '../src/host/agentKnowledgeComposition.js';
import { runAgentDispatchLive, type AgentMemoryPort, type LiveDispatchDeps } from '../src/host/agentDispatch.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import type { AiCallResult } from '../src/executor/types.js';

const T = 'akfh-tenant';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-akfh-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('WF-AKM-3 — the three states behind `undefined` are distinguished', () => {
  it('a NON-EXISTENT agent is a typed failure, not an empty corpus', async () => {
    await expect(retrieveForAgent(T, 'no-such-agent', 'anything')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    expect(await diagnoseAgentKnowledgeRetrieve(T, 'no-such-agent')).toBe('agent-missing');
  });

  it('a capability-OFF agent is a NAMED REASON, not an empty corpus', async () => {
    await upsertAgentProfile(T, 'cap-off-agent', { roleKey: 'analyst', autonomy: { specLevel: 'recommend' }, capabilities: [] });
    const res = await retrieveForAgent(T, 'cap-off-agent', 'anything');
    expect(res.hasResults).toBe(false);
    // The distinction the caller (often a MODEL) previously could not make.
    expect(res.unavailable).toBe('capability-off');
    expect(await diagnoseAgentKnowledgeRetrieve(T, 'cap-off-agent')).toBe('capability-off');
  });

  it('ANTI-ROT: an agent WITH the capability and nothing bound is still a plain empty corpus', async () => {
    await upsertAgentProfile(T, 'bound-none-agent', { roleKey: 'analyst', autonomy: { specLevel: 'recommend' }, capabilities: ['knowledge'] });
    const res = await retrieveForAgent(T, 'bound-none-agent', 'anything');
    expect(res.hasResults).toBe(false);
    // `undefined` (a resolved retriever that found nothing) or the explicit
    // 'nothing-bound' reason — never 'agent-missing'/'capability-off'.
    expect(res.unavailable === undefined || res.unavailable === 'nothing-bound').toBe(true);
  });
});

describe('WF-AKM-6 — the compose lanes report a fault instead of returning an empty string', () => {
  it('a THROWING retriever no longer collapses into silence', async () => {
    const block = await composeAgentKnowledgeContext(async () => {
      throw new Error('kb backend down');
    }, 'q');
    expect(block).not.toBe('');
    expect(block).toContain('DEGRADED');
    expect(block).toContain('FAILED');
  });

  it('a PER-SOURCE fault is reported alongside the chunks that did come back', async () => {
    const block = await composeAgentKnowledgeContext(async (_q, onSourceError) => {
      onSourceError?.('kb');
      return [{ content: 'a memory fact', kind: 'memory' as const, contentTrust: 'trusted' as const }];
    }, 'q');
    expect(block).toContain('DEGRADED');
    expect(block).toContain('part of your knowledge base');
    expect(block).toContain('a memory fact'); // the partial result is NOT discarded
  });

  it('ANTI-ROT: a clean retrieval carries NO degradation notice', async () => {
    const block = await composeAgentKnowledgeContext(async () => [
      { content: 'a fact', kind: 'kb' as const, contentTrust: 'trusted' as const },
    ], 'q');
    expect(block).toContain('a fact');
    expect(block).not.toContain('DEGRADED');
  });

  it('ANTI-ROT: an empty-but-successful retrieval still injects NOTHING', async () => {
    expect(await composeAgentKnowledgeContext(async () => [], 'q')).toBe('');
    // RCL-6/RCL-UX-1 widened the borrowed compose to a struct; empty stays empty.
    expect((await composeBorrowedRecallContext(async () => [], 'q')).block).toBe('');
  });

  it('the borrowed lane reports its fault too', async () => {
    const { block, failed } = await composeBorrowedRecallContext(async () => {
      throw new Error('owner corpus down');
    }, 'q');
    expect(failed).toBe(true);
    expect(block).toContain('DEGRADED');
  });
});

describe('MEM-UX-14 — a failed memory read reaches the MODEL, not just the log', () => {
  function register(agentId: string): void {
    getAgentRegistry().register({
      agentId,
      persona: 'Rememberer',
      modelClass: 'general',
      systemPrompt: 'Answer using memory.',
      packName: 'test',
      packVersion: '0',
      toolAllowlist: [],
      confidence: { defaultThreshold: 0.5 },
      memoryShape: { longTerm: true },
    });
  }

  function harness(read: AgentMemoryPort['read']): { deps: LiveDispatchDeps; saw: () => string } {
    let sawContent = '';
    const callAI: LiveDispatchDeps['callAI'] = async (req): Promise<AiCallResult> => {
      sawContent = req.messages.map((m) => m.content).join('\n');
      return { content: 'done' };
    };
    return {
      deps: { callAI, memory: { read, write: async () => {} }, memoryScope: 'tenant-a/mem' } as LiveDispatchDeps,
      saw: () => sawContent,
    };
  }

  it('the turn tells the model the read FAILED rather than answering as if empty', async () => {
    register('degraded.agent');
    const h = harness(async () => {
      throw new Error('memory store down');
    });
    const res = await runAgentDispatchLive({ agentId: 'degraded.agent', task: 'what do you know about me?' }, h.deps);
    expect(res.status).toBe('completed'); // best-effort: the turn still runs
    const saw = h.saw();
    expect(saw).toContain('DEGRADED');
    expect(saw).toContain('your long-term memory');
    // The precise lie being closed: the model must not report an empty record.
    expect(saw).toContain('do NOT tell the user you have nothing on record');
    expect(saw).toContain('what do you know about me?'); // the task still gets through
    getAgentRegistry()._resetForTest();
  });

  it('ANTI-ROT: a SUCCESSFUL empty read stays silent — an empty memory is not a failure', async () => {
    register('clean.agent');
    const h = harness(async () => []);
    await runAgentDispatchLive({ agentId: 'clean.agent', task: 'hello' }, h.deps);
    expect(h.saw()).not.toContain('DEGRADED');
    getAgentRegistry()._resetForTest();
  });
});
