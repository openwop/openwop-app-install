/**
 * Campaign Studio channel chains publish ONLY after the approval (user decision
 * 2026-11-19, the ADR 0162 correction; ADR 1020 D14 for creative briefs).
 *
 * What it pins, per channel chain, run through the REAL loader, the EXACT boot
 * registrar (`registerLegacyDefsChainBacked(CHANNEL_WORKFLOWS)`), the real executor
 * and scheduler and the real interrupt resolve path (`__resolveAndResumeForTests`,
 * the same `resolveAndResume` the HTTP route calls):
 *   - APPROVE: the run completes and the chain's post-approval node runs once,
 *     handed the brief id (from the run's params) and the generated draft (from
 *     `generate`). landing-page → publish-landing-page, ad-variants →
 *     publish-ad-variants (with no ad account set, so the node takes its draft
 *     document path; ADR 0167), email-sequence → publish-email-sequence,
 *     social-posts → publish-social-posts, creative-briefs → create-creative-briefs
 *     (never publish-creative-briefs too, so the briefs are not created twice).
 *   - REJECT: the gate fails (RFC 0223, `approval_rejected`), the run fails, and
 *     the post-approval node never runs.
 *   - DISABLED: a brief that does not enable the channel raises no approval and
 *     publishes nothing.
 * Only the generate node and the post-approval nodes are stand-ins (recorders), so
 * the wiring under test is the chain's, not the nodes'. The nodes' own behaviour is
 * pinned in campaign-channels-publish.test.ts and campaign-channels-publish-docs.test.ts.
 *
 * Red witness: drop a chain's `approve → publish` edge (the approve leg never
 * publishes), make it `all_complete` / move it onto `generate` (the reject leg
 * publishes), drop the `generate.draft → publish.draft` edge (no draft reaches the
 * node), drop the publish node's `briefId` input, pin the wrong publish node, or add
 * publish-creative-briefs to the creative-briefs chain beside create-creative-briefs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { executeRun } from '../src/executor/executor.js';
import { seedRunVariables } from '../src/host/variablesRuntime.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { getChainBackedWorkflow, _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import { registerLegacyDefsChainBacked } from '../src/features/index.js';
import { CHANNEL_WORKFLOWS } from '../src/features/campaign-channels/channelWorkflows.js';
import { __resolveAndResumeForTests, __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import type { NodeContext, NodeModule } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-chpub-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });

const N = 'feature.campaign-channels.nodes';
/** Each channel chain: its channel, its post-approval node, and a minimal draft. */
const CHAINS = [
  { workflowId: 'campaign-studio.channel.landing-page', channel: 'landing_page', after: `${N}.publish-landing-page`, draft: { title: 'Pick faster', sections: [{ heading: 'Pick faster', body: 'B' }] } },
  { workflowId: 'campaign-studio.channel.ad-variants', channel: 'ad_variants', after: `${N}.publish-ad-variants`, draft: { platformSets: [{ platform: 'Meta', variants: [{ headline: 'H', description: 'D', cta: 'C' }] }] } },
  { workflowId: 'campaign-studio.channel.email-sequence', channel: 'email_sequence', after: `${N}.publish-email-sequence`, draft: { emails: [{ position: 1, subjectLines: ['S'], body: 'B' }] } },
  { workflowId: 'campaign-studio.channel.creative-briefs', channel: 'creative_briefs', after: `${N}.create-creative-briefs`, draft: { briefs: [{ format: 'hero-image', sceneDescription: 'S' }] } },
  { workflowId: 'campaign-studio.channel.social-posts', channel: 'social_posts', after: `${N}.publish-social-posts`, draft: { posts: [{ platform: 'LinkedIn', content: 'P', hashtags: [] }] } },
] as const;
const POST_APPROVAL_TYPES = [...CHAINS.map((c) => c.after), `${N}.publish-creative-briefs`];

/** Every post-approval node call: which node type, in which run, with which inputs. */
const calls: Array<{ typeId: string; runId: string; inputs: Record<string, unknown> }> = [];
/** Per run: whether generate should report the channel as not enabled. */
const disabledRuns = new Set<string>();

const codeOf = (e: unknown): string | undefined => (e !== null && typeof e === 'object' && 'code' in e ? String(e.code) : undefined);
const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});

beforeAll(() => {
  ensureNodesRegistered();
  _resetChainRegistryForTest();
  _resetChainBackedWorkflowsForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
  registerLegacyDefsChainBacked(CHANNEL_WORKFLOWS);

  const reg = getNodeRegistry();
  const generate: NodeModule = {
    typeId: `${N}.generate`,
    version: '1.0.0',
    async execute(ctx: NodeContext) {
      const inputs = asRecord(ctx.inputs);
      const channel = String(inputs.channel);
      if (disabledRuns.has(ctx.runId)) return { status: 'success', outputs: { skipped: true, reason: 'channel_disabled' } };
      const spec = CHAINS.find((c) => c.channel === channel);
      if (!spec) return { status: 'failure', error: { code: 'unknown_channel', message: channel } };
      return { status: 'success', outputs: { skipped: false, draft: { channel, briefId: inputs.briefId, ...spec.draft } } };
    },
  };
  reg.register(generate);
  for (const typeId of POST_APPROVAL_TYPES) {
    reg.register({
      typeId,
      version: '1.0.0',
      async execute(ctx: NodeContext) {
        calls.push({ typeId, runId: ctx.runId, inputs: asRecord(ctx.inputs) });
        return { status: 'success', outputs: { recorded: true } };
      },
    });
  }
});

beforeEach(() => { calls.length = 0; });

async function start(workflowId: string, opts: { disabled?: boolean } = {}): Promise<{ runId: string; status: string }> {
  const def = getChainBackedWorkflow(workflowId);
  expect(def, `${workflowId} must resolve chain-backed`).toBeTruthy();
  const now = new Date().toISOString();
  const inputs = { briefId: `brief-${workflowId}` };
  const run: RunRecord = { runId: `run-chpub-${Math.random().toString(36).slice(2)}`, workflowId, tenantId: 'tenant-chpub', status: 'pending', inputs, metadata: { actingUserId: 'user:chpub' }, configurable: {}, createdAt: now, updatedAt: now };
  if (opts.disabled) disabledRuns.add(run.runId);
  await storage.insertRun(run);
  seedRunVariables(run.runId, def!.variables, inputs);
  const out = await executeRun(storage, run, def!);
  return { runId: run.runId, status: out.status };
}

async function resolve(runId: string, value: unknown): Promise<{ status: string; error?: unknown }> {
  const open = await storage.listOpenInterrupts(runId);
  expect(open, 'exactly one approval is open').toHaveLength(1);
  await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, value);
  await __awaitRunResumeChainForTests(runId);
  const run = (await storage.getRun(runId))!;
  return { status: run.status, error: run.error };
}

describe.each([...CHAINS])('$workflowId', (chain) => {
  it('nothing is published while the draft waits; APPROVE runs the post-approval node once, with the brief id and the draft', async () => {
    const { runId, status } = await start(chain.workflowId);
    expect(status).toBe('waiting-approval');
    expect(calls.filter((c) => c.runId === runId)).toEqual([]);
    const after = await resolve(runId, { action: 'accept' });
    expect(after.status, JSON.stringify(after.error ?? null)).toBe('completed');
    const mine = calls.filter((c) => c.runId === runId);
    expect(mine.map((c) => c.typeId)).toEqual([chain.after]);
    const inputs = mine[0]!.inputs;
    expect(inputs.briefId).toBe(`brief-${chain.workflowId}`);
    expect(asRecord(inputs.draft)).toMatchObject({ channel: chain.channel, ...chain.draft });
    if (chain.channel === 'ad_variants') {
      // No ad account was set, so the node is not asked to dispatch (ADR 0167): it
      // takes its draft-document path. With one set it creates the campaign PAUSED.
      expect(inputs.adAccountId ?? '').toBe('');
    }
  });

  it('REJECT fails the gate and the run, and the post-approval node never runs', async () => {
    const { runId, status } = await start(chain.workflowId);
    expect(status).toBe('waiting-approval');
    const after = await resolve(runId, { action: 'reject', comment: 'Off-brand.' });
    expect(after.status).toBe('failed');
    expect(codeOf(after.error)).toBe('approval_rejected');
    expect(calls.filter((c) => c.runId === runId)).toEqual([]);
  });

  it('a channel the brief does not enable raises no approval and publishes nothing', async () => {
    const { runId, status } = await start(chain.workflowId, { disabled: true });
    expect(status).toBe('completed');
    expect(await storage.listOpenInterrupts(runId)).toEqual([]);
    expect(calls.filter((c) => c.runId === runId)).toEqual([]);
  });
});
