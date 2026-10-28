/**
 * ADR 0944 P3 — read receipts (D6), and D7 test 5.
 *
 * A client run records what its agent recalled, by id. A `replay` fork of it,
 * taken after a client-B write, a new client-A note and the ERASURE of one
 * recalled A note, is served from that receipt: it sees the surviving A note,
 * not the erased one (erasure wins over replay fidelity), not the new one, and
 * nothing of B, and the model is told part of the memory is gone. A `branch`
 * fork reads live. A receipt holds ids and a hash, never content, and ages out.
 *
 * Sabotage-witnessed (P3): serving the replay from live memory (dropping the
 * `servedFromReceipt` branch in the runner) reds test 5, and dropping the
 * `recallNotice` wiring reds its partial-memory notice. A receipt cannot serve an
 * erased row from a cached copy because it stores no content (asserted).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { createApp } from '../src/index.js';
import agentRunnerNode from '../src/host/agentRunnerNode.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import { addClientNote, removeClientNote } from '../src/features/campaign-ops/clientMemory.js';
import { getReadReceipt, listRunReadReceipts, recordingRecall, servedFromReceipt, RECEIPT_TTL_DAYS } from '../src/host/memoryReadReceipts.js';
import type { AgentKnowledgeRetrieve, AgentMemoryPort } from '../src/host/agentDispatch.js';
import { __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import type { AiCallRequest, AiCallResult, NodeContext } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import { createSubjectMemoryPort } from '../src/host/subjectMemory.js';

const AGENT = 'test.adr0944-p3-copywriter';
const OPS = 'openwop-app.campaignOps';

let server: http.Server;
let TENANT: string;
let person: string;
let orgA: string;
let orgB: string;

async function insertRun(over: Partial<RunRecord> & { metadata: Record<string, unknown> }): Promise<string> {
  const runId = `run-p3-${randomBytes(5).toString('hex')}`;
  await hostExtStorage().insertRun({
    runId, workflowId: 'w', tenantId: TENANT, status: 'running', inputs: null, configurable: {}, createdAt: 'x', updatedAt: 'x', ...over,
  } as RunRecord);
  return runId;
}

async function promptOf(runId: string): Promise<string> {
  let prompt = '';
  const callAI = vi.fn<(req: AiCallRequest) => Promise<AiCallResult>>(async (req) => { prompt = JSON.stringify(req.messages); return { content: 'ok' } as AiCallResult; });
  const out = await agentRunnerNode.execute({
    tenantId: TENANT, runId, nodeId: 'copy', configurable: {}, config: { offerTools: [] }, actingUserId: person,
    inputs: { agentId: AGENT, task: 'Write the hero line', credentialRef: 'managed:openwop-free' },
    emit: async () => {}, callAI, callAIWithTools: vi.fn(async () => { throw new Error('no tools'); }),
  } as unknown as NodeContext);
  expect(out.status, JSON.stringify(out)).toBe('success');
  return prompt;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:p3-owner' })).tenantId;
  person = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p3-person', source: 'oidc' })).userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  for (const org of [orgA, orgB]) await createMember({ tenantId: TENANT, orgId: org, subject: person, displayName: 'P', roles: ['editor'] });
  await upsertAgentProfile(TENANT, AGENT, { roleKey: 'copywriter', autonomy: { specLevel: 'recommend' }, memoryScope: 'per-org' });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => {
  const registry = getAgentRegistry();
  registry._resetForTest();
  registry.register({
    agentId: AGENT, persona: AGENT, modelClass: 'chat', systemPrompt: 'You write copy.',
    packName: 'test', packVersion: '0', toolAllowlist: [], memoryShape: { longTerm: true },
  } as ResolvedAgentManifest);
});

describe('ADR 0944 D6 — read receipts', () => {
  it('test 5: a replay fork is served from the receipt — A only, the erased note absent, the model told', async () => {
    const keep = await addClientNote(TENANT, orgA, 'NOTE-KEEP: lead with the guarantee', person);
    const erase = await addClientNote(TENANT, orgA, 'NOTE-ERASE: mention the founder by name', person);
    const runA = await insertRun({ metadata: { [OPS]: { orgId: orgA }, actingUserId: person } });
    const original = await promptOf(runA);
    expect(original).toContain('NOTE-KEEP');
    expect(original).toContain('NOTE-ERASE');

    const receipt = await getReadReceipt(TENANT, runA, 'copy');
    expect(receipt).toMatchObject({ orgId: orgA, scope: `org:${orgA}` });
    expect(receipt?.entryIds).toEqual(expect.arrayContaining([keep.id, erase.id]));
    // Ids and a hash only: the receipt cannot resurrect what is erased.
    expect(JSON.stringify(receipt)).not.toContain('NOTE-KEEP');

    // Afterwards: client B learns something, A gains a note, and one A note is erased.
    await addClientNote(TENANT, orgB, 'NOTE-BETA: B is green', person);
    await addClientNote(TENANT, orgA, 'NOTE-NEW: written after the run', person);
    expect((await removeClientNote(TENANT, orgA, erase.id)).removed).toBe(true);

    const replay = await insertRun({ parentRunId: runA, forkMode: 'replay', metadata: { [OPS]: { orgId: orgA }, actingUserId: person } });
    const replayed = await promptOf(replay);
    expect(replayed).toContain('NOTE-KEEP');
    expect(replayed).not.toContain('NOTE-ERASE'); // erasure wins
    expect(replayed).not.toContain('NOTE-NEW'); // not what the original saw
    expect(replayed).not.toContain('NOTE-BETA');
    expect(replayed).toContain("part of this client's shared memory");
    // A replay records no receipt of its own.
    expect(await listRunReadReceipts(TENANT, replay)).toEqual([]);

    const branch = await insertRun({ parentRunId: runA, forkMode: 'branch', metadata: { [OPS]: { orgId: orgA }, actingUserId: person } });
    const branched = await promptOf(branch);
    expect(branched).toContain('NOTE-NEW'); // a branch is a new decision: live
    expect(branched).not.toContain('NOTE-ERASE');
    expect(branched).not.toContain('NOTE-BETA');
  });

  it('a run with no client records no receipt', async () => {
    const plain = await insertRun({ metadata: { actingUserId: person } });
    await promptOf(plain);
    expect(await listRunReadReceipts(TENANT, plain)).toEqual([]);
  });

  it('a replay with missing receipt evidence never falls back to current client memory', async () => {
    const source = await insertRun({ metadata: { [OPS]: { orgId: orgA }, actingUserId: person } });
    await addClientNote(TENANT, orgA, 'UNPROVEN-RECALL: added after an unrecorded turn', person);
    const replay = await insertRun({ parentRunId: source, forkMode: 'replay', metadata: { [OPS]: { orgId: orgA }, actingUserId: person } });
    const prompt = await promptOf(replay);
    expect(prompt).not.toContain('UNPROVEN-RECALL');
    expect(prompt).not.toContain('NOTE-KEEP');
    expect(prompt).toContain("this client's shared memory");
  });

  it('an empty source recall is recorded and cannot gain newly written memory on replay', async () => {
    const emptyOrg = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Empty recall client' })).orgId;
    await createMember({ tenantId: TENANT, orgId: emptyOrg, subject: person, displayName: 'P', roles: ['editor'] });
    const source = await insertRun({ metadata: { [OPS]: { orgId: emptyOrg }, actingUserId: person } });
    await promptOf(source);
    expect(await getReadReceipt(TENANT, source, 'copy')).toMatchObject({ entryIds: [], kbChunkIds: [], entryHashes: {}, kbChunkHashes: {} });
    await addClientNote(TENANT, emptyOrg, 'LATE-EMPTY: the source never recalled this', person);
    const replay = await insertRun({ parentRunId: source, forkMode: 'replay', metadata: { [OPS]: { orgId: emptyOrg }, actingUserId: person } });
    expect(await promptOf(replay)).not.toContain('LATE-EMPTY');
  });

  it('a changed memory row is absent from replay even when its id is unchanged', async () => {
    const client = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Mutable receipt client' })).orgId;
    await createMember({ tenantId: TENANT, orgId: client, subject: person, displayName: 'P', roles: ['editor'] });
    const scope = `org:${client}`;
    const port = createSubjectMemoryPort(TENANT);
    await port.write(scope, { id: 'mutable-recall', content: 'BEFORE-RECEIPT: approved evidence' });
    const source = await insertRun({ metadata: { [OPS]: { orgId: client }, actingUserId: person } });
    expect(await promptOf(source)).toContain('BEFORE-RECEIPT');
    await port.write(scope, { id: 'mutable-recall', content: 'AFTER-RECEIPT: different evidence' });
    const replay = await insertRun({ parentRunId: source, forkMode: 'replay', metadata: { [OPS]: { orgId: client }, actingUserId: person } });
    const prompt = await promptOf(replay);
    expect(prompt).not.toContain('AFTER-RECEIPT');
    expect(prompt).not.toContain('BEFORE-RECEIPT');
    expect(prompt).toContain("part of this client's shared memory");
  });

  it('KB replay excludes changed source titles or trust and retains unchanged evidence', async () => {
    const memory: AgentMemoryPort = { read: async () => [], write: async () => {} };
    let evidence: Awaited<ReturnType<AgentKnowledgeRetrieve>> = [
      { id: 'same', kind: 'kb', content: 'UNCHANGED-EVIDENCE', title: 'Original source', contentTrust: 'untrusted' },
      { id: 'retitled', kind: 'kb', content: 'RETITLED-EVIDENCE', title: 'Original title', contentTrust: 'untrusted' },
      { id: 'retrusted', kind: 'kb', content: 'RETRUSTED-EVIDENCE', title: 'Original trust', contentTrust: 'untrusted' },
    ];
    const knowledgeRetrieve: AgentKnowledgeRetrieve = async () => evidence;
    const recorder = recordingRecall({ memory, knowledgeRetrieve });
    await recorder.knowledgeRetrieve!('evidence');
    const runId = `run-kb-commitment-${randomBytes(5).toString('hex')}`;
    await recorder.write({ tenantId: TENANT, orgId: orgA, runId, nodeId: 'copy', ordinal: 1, scope: `org:${orgA}` });
    const receipt = await getReadReceipt(TENANT, runId, 'copy');
    if (!receipt) throw new Error('Receipt was not recorded');
    expect(JSON.stringify(receipt)).not.toContain('EVIDENCE');
    evidence = evidence.map((row) => row.id === 'retitled' ? { ...row, title: 'Different source' }
      : row.id === 'retrusted' ? { ...row, contentTrust: 'trusted' } : row);
    const replay = servedFromReceipt({ tenantId: TENANT, receipt, memory, knowledgeRetrieve });
    expect(await replay.knowledgeRetrieve!('evidence')).toEqual([evidence[0]]);
    expect(replay.partial()).toBe(true);
  });

  it('an expired receipt cannot authorize recall before the background cleanup runs', async () => {
    const client = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Expired receipt client' })).orgId;
    await createMember({ tenantId: TENANT, orgId: client, subject: person, displayName: 'P', roles: ['editor'] });
    await createSubjectMemoryPort(TENANT).write(`org:${client}`, { id: 'expired-evidence', content: 'EXPIRED-RECEIPT-EVIDENCE' });
    const source = await insertRun({ metadata: { [OPS]: { orgId: client }, actingUserId: person } });
    expect(await promptOf(source)).toContain('EXPIRED-RECEIPT-EVIDENCE');
    const receipt = await getReadReceipt(TENANT, source, 'copy');
    if (!receipt) throw new Error('Receipt was not recorded');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(receipt.at) + RECEIPT_TTL_DAYS * 86_400_000 + 1);
    try {
      expect(await getReadReceipt(TENANT, source, 'copy')).toBeNull();
      expect(await listRunReadReceipts(TENANT, source)).toEqual([]);
      const replay = await insertRun({ parentRunId: source, forkMode: 'replay', metadata: { [OPS]: { orgId: client }, actingUserId: person } });
      expect(await promptOf(replay)).not.toContain('EXPIRED-RECEIPT-EVIDENCE');
    } finally {
      clock.mockRestore();
    }
  });

  it('a receipt ages out after the run-history window', async () => {
    const runA = await insertRun({ metadata: { [OPS]: { orgId: orgA }, actingUserId: person } });
    await promptOf(runA);
    expect(await getReadReceipt(TENANT, runA, 'copy')).not.toBeNull();
    await __runKvAgeOutOnce(hostExtStorage(), new Date(Date.now() + (RECEIPT_TTL_DAYS + 1) * 86_400_000));
    expect(await getReadReceipt(TENANT, runA, 'copy')).toBeNull();
    expect(await hostExtStorage().kvList(`hostextidx:agent-memory:read-receipt:${TENANT}:`)).toEqual([]);
  });
});
