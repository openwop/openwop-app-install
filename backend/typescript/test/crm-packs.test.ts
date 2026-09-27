/**
 * CRM chat-drivability + orchestration packs (ADR 0208 §2):
 *   - feature.crm.agents — the stable Sales Ops persona: well-formed manifest,
 *     allowlist referencing only real feature.crm.nodes typeIds.
 *   - feature.crm.nodes@1.3.0 — the ten new role:"action" write nodes: declared
 *     in the manifest, runnable in index.mjs, and deterministic-id (ADR 0162)
 *     on the creation nodes.
 *   - examples/workflow-chain-packs/crm-ops — loads clean and registers both
 *     chainIds (mirrors workflow-chain-exec-ops.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadWorkflowChainPacks,
  getChain,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const NODES_PACK_DIR = join(REPO_ROOT, 'packs', 'feature.crm.nodes');
const AGENTS_PACK_DIR = join(REPO_ROOT, 'packs', 'feature.crm.agents');
const CHAIN_PACK_ROOT = join(REPO_ROOT, 'examples', 'workflow-chain-packs');

interface NodeManifestEntry {
  typeId: string;
  version: string;
  category: string;
  role: string;
}
interface NodesManifest {
  name: string;
  version: string;
  nodes: NodeManifestEntry[];
  runtime: { entry: string };
}
interface AgentManifestEntry {
  agentId: string;
  persona: string;
  modelClass: string;
  toolAllowlist: string[];
}
interface AgentsManifest {
  name: string;
  agents: AgentManifestEntry[];
}

describe('feature.crm.nodes pack (v1.10.0)', () => {
  const manifest = JSON.parse(readFileSync(join(NODES_PACK_DIR, 'pack.json'), 'utf8')) as NodesManifest;

  const NEW_WRITE_TYPE_IDS = [
    'feature.crm.nodes.create-contact',
    'feature.crm.nodes.update-contact-stage',
    'feature.crm.nodes.update-contact-owner',
    'feature.crm.nodes.convert-contact',
    'feature.crm.nodes.create-company',
    'feature.crm.nodes.create-deal',
    'feature.crm.nodes.move-deal-stage',
    'feature.crm.nodes.create-task',
    'feature.crm.nodes.complete-task',
    'feature.crm.nodes.log-activity',
  ];

  it('declares its version and all ten write nodes as role:"side-effect" (ADR 0627 D1 — the fork guard)', () => {
    expect(manifest.version).toBe('1.10.0'); // ADR 0627 D1/D5 — side-effect writes + schemas, gmail-sync pin + typed outcomes
    const byId = new Map(manifest.nodes.map((n) => [n.typeId, n]));
    for (const typeId of NEW_WRITE_TYPE_IDS) {
      const n = byId.get(typeId);
      expect(n, typeId).toBeTruthy();
      expect(n!.role).toBe('side-effect');
      expect(n!.typeId.startsWith('feature.crm.nodes')).toBe(true); // RFC 0003 §B namespace
    }
  });

  it('index.mjs exports a runnable function for every new write node', async () => {
    const mod = (await import(pathToFileURL(join(NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: unknown }>>;
    };
    for (const typeId of NEW_WRITE_TYPE_IDS) {
      expect(typeof mod.nodes[typeId], typeId).toBe('function');
    }
  });

  it('a creation node defaults its explicit id to `<prefix>:${runId}:${nodeId}` (ADR 0162) when the caller omits one', async () => {
    const mod = (await import(pathToFileURL(join(NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: unknown }>>;
    };
    const calls: Array<{ method: string; args: unknown }> = [];
    const stubCrm = new Proxy({}, {
      get: (_t, method: string) => async (args: unknown) => {
        calls.push({ method, args });
        return { success: true };
      },
    });
    const ctx = { runId: 'run-abc', nodeId: 'node-xyz', config: {}, inputs: { orgId: 'org-1', name: 'Acme', title: 'A deal' }, features: { crm: stubCrm } };
    const out = await mod.nodes['feature.crm.nodes.create-company']!(ctx);
    expect(out.status).toBe('success');
    expect(calls[0]!.method).toBe('createCompany');
    expect((calls[0]!.args as { companyId: string }).companyId).toBe('cmp:run-abc:node-xyz');

    calls.length = 0;
    const dealCtx = { ...ctx, inputs: { orgId: 'org-1', title: 'A deal' } };
    await mod.nodes['feature.crm.nodes.create-deal']!(dealCtx);
    expect((calls[0]!.args as { dealId: string }).dealId).toBe('deal:run-abc:node-xyz');
  });

  it('declares and runs the v1.3.0 list-segment-members read node (ADR 0211 §2)', async () => {
    const byId = new Map(manifest.nodes.map((n) => [n.typeId, n]));
    const node = byId.get('feature.crm.nodes.list-segment-members');
    expect(node).toBeTruthy();
    expect(node!.role).toBe('action');

    const mod = (await import(pathToFileURL(join(NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: unknown }>>;
    };
    expect(typeof mod.nodes['feature.crm.nodes.list-segment-members']).toBe('function');

    const calls: Array<{ method: string; args: unknown }> = [];
    const stubCrm = new Proxy({}, {
      get: (_t, method: string) => async (args: unknown) => {
        calls.push({ method, args });
        return { members: [{ contactId: 'crm:1' }] };
      },
    });
    const ctx = { runId: 'run-abc', nodeId: 'node-xyz', config: {}, inputs: { segmentId: 'seg:1' }, features: { crm: stubCrm } };
    const out = await mod.nodes['feature.crm.nodes.list-segment-members']!(ctx);
    expect(out.status).toBe('success');
    expect(out.outputs).toEqual({ members: [{ contactId: 'crm:1' }] });
    expect(calls[0]!.method).toBe('listSegmentMembers');
    expect(calls[0]!.args).toEqual({ segmentId: 'seg:1' });
  });

  it('declares and runs the v1.8.0 booking nodes (ADR 0402 §a) with a deterministic link id', async () => {
    const byId = new Map(manifest.nodes.map((n) => [n.typeId, n]));
    for (const typeId of ['feature.crm.nodes.booking-create-link', 'feature.crm.nodes.booking-list']) {
      const n = byId.get(typeId);
      expect(n, typeId).toBeTruthy();
      // The write is side-effect (ADR 0627 D1); the read stays a recorded action.
      expect(n!.role).toBe(typeId.endsWith('booking-create-link') ? 'side-effect' : 'action');
    }
    const mod = (await import(pathToFileURL(join(NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: unknown }>>;
    };
    const calls: Array<{ method: string; args: unknown }> = [];
    const stubCrm = new Proxy({}, {
      get: (_t, method: string) => async (args: unknown) => {
        calls.push({ method, args });
        return method === 'listBookings' ? { bookings: [] } : { success: true, bookingLink: {} };
      },
    });
    const ctx = {
      runId: 'run-abc', nodeId: 'node-xyz', config: {},
      inputs: { orgId: 'org-1', title: 'Intro call', timezone: 'America/New_York', weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }], durations: [30] },
      features: { crm: stubCrm },
    };
    const out = await mod.nodes['feature.crm.nodes.booking-create-link']!(ctx);
    expect(out.status).toBe('success');
    expect(calls[0]!.method).toBe('createBookingLink');
    expect((calls[0]!.args as { bookingLinkId: string }).bookingLinkId).toBe('booking-link:run-abc:node-xyz');

    calls.length = 0;
    const listOut = await mod.nodes['feature.crm.nodes.booking-list']!({ ...ctx, inputs: { orgId: 'org-1' } });
    expect(listOut.status).toBe('success');
    expect(calls[0]!.method).toBe('listBookings');
  });

  it('declares and runs the v1.8.0 e-sign nodes (ADR 0402 §b) with a deterministic request id', async () => {
    const byId = new Map(manifest.nodes.map((n) => [n.typeId, n]));
    for (const typeId of ['feature.crm.nodes.sign-request', 'feature.crm.nodes.sign-status']) {
      const n = byId.get(typeId);
      expect(n, typeId).toBeTruthy();
      // sign-request mints tokens + emails signers: side-effect (ADR 0627 D1); the status read stays an action.
      expect(n!.role).toBe(typeId.endsWith('sign-request') ? 'side-effect' : 'action');
    }
    const mod = (await import(pathToFileURL(join(NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: unknown }>>;
    };
    const calls: Array<{ method: string; args: unknown }> = [];
    const stubCrm = new Proxy({}, {
      get: (_t, method: string) => async (args: unknown) => {
        calls.push({ method, args });
        return method === 'getSignatureStatus' ? { signRequest: {} } : { success: true, signRequest: {} };
      },
    });
    const ctx = {
      runId: 'run-abc', nodeId: 'node-xyz', config: {},
      inputs: { orgId: 'org-1', target: { kind: 'document', id: 'doc:1' }, signers: [{ email: 'a@x.test' }] },
      features: { crm: stubCrm },
    };
    const out = await mod.nodes['feature.crm.nodes.sign-request']!(ctx);
    expect(out.status).toBe('success');
    expect(calls[0]!.method).toBe('requestSignature');
    expect((calls[0]!.args as { signRequestId: string }).signRequestId).toBe('sign-request:run-abc:node-xyz');
  });

  it('declares and runs the v1.4.0 gmail-sync node (ADR 0252 P2)', async () => {
    const byId = new Map(manifest.nodes.map((n) => [n.typeId, n]));
    const node = byId.get('feature.crm.nodes.gmail-sync');
    expect(node).toBeTruthy();
    expect(node!.role).toBe('side-effect'); // ADR 0627 (review SHOULD-4): writes activities + the sync row's own status

    const mod = (await import(pathToFileURL(join(NODES_PACK_DIR, manifest.runtime.entry)).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: unknown; error?: unknown }>>;
    };
    expect(typeof mod.nodes['feature.crm.nodes.gmail-sync']).toBe('function');

    // No ctx.connectors at all → the explicit host_capability_missing guard.
    const noConnectorsCtx = { runId: 'run-1', nodeId: 'node-1', config: { gmailSyncId: 'gmailsync:1' }, inputs: {}, features: { crm: {} } };
    const noConnectors = await mod.nodes['feature.crm.nodes.gmail-sync']!(noConnectorsCtx);
    expect(noConnectors.status).toBe('failure');
    expect((noConnectors.error as { code: string }).code).toBe('host_capability_missing');

    // A sync that resolves to nothing (deleted mid-run / unknown id) → a clean failure, not a throw.
    // `listCompanies` is present only to satisfy `ensureCrm`'s shared capability-presence check.
    const stubCrmMissing = { listCompanies: async () => ({ companies: [] }), getGmailSyncForRun: async () => ({ sync: null }) };
    const missingCtx = {
      runId: 'run-1', nodeId: 'node-1', config: { gmailSyncId: 'gmailsync:missing' }, inputs: {},
      features: { crm: stubCrmMissing },
      connectors: { invoke: async () => ({ ok: true, data: { messages: [] } }) },
    };
    const missing = await mod.nodes['feature.crm.nodes.gmail-sync']!(missingCtx);
    expect(missing.status).toBe('failure');
    expect((missing.error as { code: string }).code).toBe('not_found');

    // The happy path — one message from a matched contact, one from an
    // unmatched address: only the matched contact gets an activity, the
    // deterministic-shape call carries orgId/messageId/direction, and the
    // cursor advances to the message's date.
    const calls: Array<{ method: string; args: unknown }> = [];
    const stubCrm = {
      listCompanies: async () => ({ companies: [] }),
      getGmailSyncForRun: async () => ({ sync: { orgId: 'org-1', connectionId: 'conn-1', cursor: null, status: 'active', pausedReason: null } }),
      findContactByEmail: async (a: { email: string }) => (a.email === 'known@customer.test' ? { contactId: 'crm:known' } : null),
      // ADR 0627 D5(b) — the typed outcome the node keys its cursor on.
      logGmailActivity: async (a: unknown) => { calls.push({ method: 'logGmailActivity', args: a }); return { success: true, outcome: 'logged' }; },
      advanceGmailSyncCursor: async (a: unknown) => { calls.push({ method: 'advanceGmailSyncCursor', args: a }); return { success: true }; },
    };
    const internalDateMs = Date.now();
    const invokeCalls: string[] = [];
    const ctx = {
      runId: 'run-1', nodeId: 'node-1', config: { gmailSyncId: 'gmailsync:1' }, inputs: {},
      features: { crm: stubCrm },
      connectors: {
        invoke: async (_connectorId: string, req: { url: string }) => {
          invokeCalls.push(req.url);
          if (req.url.includes('/messages?')) return { ok: true, data: { messages: [{ id: 'msg-1', threadId: 'thread-1' }] } };
          return {
            ok: true,
            data: {
              id: 'msg-1',
              threadId: 'thread-1',
              internalDate: String(internalDateMs),
              payload: { headers: [
                { name: 'From', value: 'known@customer.test' },
                { name: 'To', value: 'me@myinbox.test, stranger@nowhere.test' },
              ] },
            },
          };
        },
      },
    };
    const out = await mod.nodes['feature.crm.nodes.gmail-sync']!(ctx);
    expect(out.status).toBe('success');
    expect(out.outputs).toEqual({ scanned: 1, matched: 1, truncated: false });
    expect(invokeCalls.some((u) => u.includes('gmail.googleapis.com'))).toBe(true);

    const logged = calls.find((c) => c.method === 'logGmailActivity')!;
    const loggedArgs = logged.args as { orgId: string; contactId: string; messageId: string; threadId: string; direction: string; at: string };
    // threadId + the email's own timestamp (`at`) flow through so the activity
    // is back-dated and thread-linked, not stamped at sync time (MEDIUM-2).
    expect(loggedArgs).toMatchObject({ orgId: 'org-1', contactId: 'crm:known', messageId: 'msg-1', threadId: 'thread-1', direction: 'in' });
    expect(loggedArgs.at).toBe(new Date(internalDateMs).toISOString());

    const advanced = calls.find((c) => c.method === 'advanceGmailSyncCursor')!;
    expect((advanced.args as { syncId: string; cursor: string }).syncId).toBe('gmailsync:1');
    expect((advanced.args as { cursor: string }).cursor).toBe(new Date(internalDateMs - 1000).toISOString()); // uniform − 1s landing (ADR 0627 review NIT-3)
  });
});

describe('feature.crm.agents pack', () => {
  const manifest = JSON.parse(readFileSync(join(AGENTS_PACK_DIR, 'pack.json'), 'utf8')) as AgentsManifest;
  const nodesManifest = JSON.parse(readFileSync(join(NODES_PACK_DIR, 'pack.json'), 'utf8')) as NodesManifest;
  const knownTypeIds = new Set(nodesManifest.nodes.map((n) => n.typeId));

  it('is well-formed: sales-ops + segment-author, namespaced under feature.crm.agents', () => {
    expect(manifest.name).toBe('feature.crm.agents');
    expect(manifest.agents.length).toBe(2); // sales-ops + ADR 0265 CDP-C segment-author
    for (const a of manifest.agents) {
      expect(a.agentId.startsWith('feature.crm.agents.')).toBe(true);
      expect(a.toolAllowlist.length).toBeGreaterThan(0);
    }
    // The segment-author rides the closed-world draft→validate→persist trio.
    const author = manifest.agents.find((a) => a.agentId === 'feature.crm.agents.segment-author')!;
    expect(author.toolAllowlist).toEqual(expect.arrayContaining([
      'openwop:feature.crm.nodes.segment-vocabulary',
      'openwop:feature.crm.nodes.validate-segment',
      'openwop:feature.crm.nodes.persist-segment',
    ]));
  });

  it('toolAllowlist references only typeIds feature.crm.nodes actually declares', () => {
    const agent = manifest.agents[0]!;
    for (const ref of agent.toolAllowlist) {
      expect(ref.startsWith('openwop:'), ref).toBe(true);
      const typeId = ref.slice('openwop:'.length);
      expect(knownTypeIds.has(typeId), typeId).toBe(true);
    }
  });

  it('does NOT allowlist the risky governed writes (create-contact/company/deal, stage moves, convert)', () => {
    const agent = manifest.agents[0]!;
    const disallowed = [
      'feature.crm.nodes.create-contact',
      'feature.crm.nodes.update-contact-stage',
      'feature.crm.nodes.update-contact-owner',
      'feature.crm.nodes.convert-contact',
      'feature.crm.nodes.create-company',
      'feature.crm.nodes.create-deal',
      'feature.crm.nodes.move-deal-stage',
      'feature.crm.nodes.complete-task',
    ];
    for (const typeId of disallowed) {
      expect(agent.toolAllowlist.includes(`openwop:${typeId}`), typeId).toBe(false);
    }
  });
});

describe('examples/workflow-chain-packs/crm-ops', () => {
  it('loads through loadWorkflowChainPacks with zero errors and registers all three chains', () => {
    _resetChainRegistryForTest();
    const { installed, errors } = loadWorkflowChainPacks({ roots: [CHAIN_PACK_ROOT] });
    expect(errors).toEqual([]);
    const mine = installed.find((p) => p.packName === 'core.openwop.workflows.crm-ops');
    expect(mine).toBeTruthy();
    expect(mine!.chainIds.sort()).toEqual(['crm-ops.deal-hygiene', 'crm-ops.gmail-sync', 'crm-ops.route-new-lead']);
    expect(getChain('crm-ops.route-new-lead')).not.toBeNull();
    expect(getChain('crm-ops.deal-hygiene')).not.toBeNull();
    expect(getChain('crm-ops.gmail-sync')).not.toBeNull();
    expect(listChains().some((c) => c.packName === 'core.openwop.workflows.crm-ops')).toBe(true);
  });

  it('every DAG node references a real, known typeId (no invented typeIds)', () => {
    const nodesManifest = JSON.parse(readFileSync(join(NODES_PACK_DIR, 'pack.json'), 'utf8')) as NodesManifest;
    const known = new Set([
      ...nodesManifest.nodes.map((n) => n.typeId),
      'core.trigger.event',
      'core.chat.approvalGate',
      // ADR 0582 Batch 1: deal-hygiene's gate now branches to a noop terminal on
      // reject so a rejected review COMPLETES the run without creating a task.
      'core.flow.noop',
    ]);
    for (const chainId of ['crm-ops.route-new-lead', 'crm-ops.deal-hygiene', 'crm-ops.gmail-sync']) {
      const entry = getChain(chainId)!;
      for (const n of entry.chain.dag.nodes) {
        expect(known.has(n.typeId), `${chainId}:${n.id} → ${n.typeId}`).toBe(true);
      }
    }
  });

  it('crm-ops.gmail-sync expands to a frozen, validated WorkflowDefinition binding gmailSyncId (ADR 0252, RFC 0013 Path A)', () => {
    const chain = getChain('crm-ops.gmail-sync')!.chain;
    const expanded = expandChain(chain, { params: { gmailSyncId: 'gmailsync:abc' } });
    expect(expanded.workflowId).toMatch(/^crm-ops\.gmail-sync:[0-9a-f]{12}$/);
    const syncNode = expanded.nodes.find((n) => n.typeId === 'feature.crm.nodes.gmail-sync')!;
    // Path A: the param value is FROZEN into node config at expansion — no
    // residual {{params.*}} token, no run-overridable variables[] (portable).
    expect((syncNode.config as { gmailSyncId: string }).gmailSyncId).toBe('gmailsync:abc');
    expect(JSON.stringify(expanded.nodes)).not.toContain('{{params');
    expect(expanded.variables).toBeUndefined();
    // Re-parameterization (a per-sync workflow) is via metadata.expandedFrom.
    expect((expanded.metadata as { expandedFrom?: { chainId: string; params: Record<string, unknown> } }).expandedFrom)
      .toMatchObject({ chainId: 'crm-ops.gmail-sync', params: { gmailSyncId: 'gmailsync:abc' } });
  });

  it('both chains expand to a frozen, validated WorkflowDefinition (RFC 0013)', () => {
    const routeDef = expandChain(getChain('crm-ops.route-new-lead')!.chain, { params: { ownerId: 'user:bob', orgId: 'org-1' } });
    expect(routeDef.workflowId).toMatch(/^crm-ops\.route-new-lead:[0-9a-f]{12}$/);
    const assignOwner = routeDef.nodes.find((n) => n.typeId === 'feature.crm.nodes.update-contact-owner')!;
    expect((assignOwner.config as { owner: string }).owner).toBe('user:bob'); // RFC 0013 Path A: frozen at expansion
    // The trigger→assign-owner edge binds the `payload` output port (ADR 0208 §1
    // ids-only event shape) rather than forwarding the whole trigger output.
    const edge = (routeDef.edges ?? []).find((e) => e.targetNodeId === assignOwner.nodeId)!;
    expect(edge.sourceOutput).toBe('payload');
    // Path A: a required param declared on the CHAIN; expand freezes (no throw,
    // no run-overridable variables[], no residual tokens).
    expect(((getChain('crm-ops.route-new-lead')!.chain.parameters as { required?: string[] }).required)).toEqual(
      expect.arrayContaining(['ownerId', 'orgId']),
    );
    const routeDefNoParams = expandChain(getChain('crm-ops.route-new-lead')!.chain, { params: {} });
    expect(routeDefNoParams.variables).toBeUndefined();
    expect(JSON.stringify(routeDefNoParams.nodes)).not.toContain('{{params');

    const hygieneDef = expandChain(getChain('crm-ops.deal-hygiene')!.chain, { params: { orgId: 'org-1' } });
    expect(hygieneDef.workflowId).toMatch(/^crm-ops\.deal-hygiene:[0-9a-f]{12}$/);
    expect(hygieneDef.nodes.some((n) => n.typeId === 'core.chat.approvalGate')).toBe(true);
    const hygieneDefNoParams = expandChain(getChain('crm-ops.deal-hygiene')!.chain, { params: {} });
    expect(hygieneDefNoParams.variables).toBeUndefined();
  });
});
