/**
 * ADR 0905 D5 — agents and runs may SUBMIT a campaign for send review; they can never
 * approve or send.
 *
 *  - the `submit-for-review` node is classified `side-effect` + `side-effectful`, so it
 *    is in the floor and fast-path SERVED on a replay fork (the ADR 0627 guard is the
 *    classification);
 *  - the feature pins equal both manifest versions;
 *  - the copywriter's allowlist carries no approve or send tool, and its prompt says it
 *    cannot approve or send (test-pinned);
 *  - the chat tool queues ONE review (a resubmit repins it), and fails typed without a
 *    human-initiated turn;
 *  - `ctx.features.email` exposes `submitForReview` and still no send / approve method.
 *
 * Sabotage-witnessed: `role:"action"` on the node reds the floor case; dropping the prompt
 * guardrail reds the prompt case; adding a `send` method to the surface reds the surface
 * case; making the tool create a fresh row per call reds the repin case.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { EMAIL_SAVE_DRAFT_TOOL_ID, EMAIL_SUBMIT_FOR_REVIEW_TOOL_ID } from '../src/features/email/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, listOrgs } from '../src/host/accessControlService.js';
import { getCampaign, setSenderAddress, createTemplate, createCampaign } from '../src/features/email/emailService.js';
import { buildEmailSurface } from '../src/features/email/surface.js';
import { pinnedPackRef } from '../src/features/packPins.js';
import { getApproval } from '../src/host/approvalService.js';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';

const TENANT = 'default';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NODE_ID = 'feature.email.nodes.submit-for-review';
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  for (const id of ['crm', 'email']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0905 D5 — packs', () => {
  const nodes = JSON.parse(read('packs/feature.email.nodes/pack.json')) as { version: string; nodes: { typeId: string; role: string; capabilities?: string[] }[] };
  const agents = JSON.parse(read('packs/vendor.openwop-app.email.agents/pack.json')) as { version: string; agents: { toolAllowlist: string[]; systemPromptRef: string }[] };

  it('the node is a classified side effect: in the floor and replay-served', () => {
    const n = nodes.nodes.find((x) => x.typeId === NODE_ID);
    expect(n?.role).toBe('side-effect');
    expect(n?.capabilities).toContain('side-effectful');
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(NODE_ID)).toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has(NODE_ID)).toBe(true);
  });

  it('the feature pins equal both manifest versions', () => {
    // ADR 0919 — pins live in features/packPins.ts; the feature names the packs.
    const feature = read('backend/typescript/src/features/email/feature.ts');
    expect(feature).toContain(`'feature.email.nodes'`);
    expect(feature).toContain(`'vendor.openwop-app.email.agents'`);
    expect(pinnedPackRef('feature.email.nodes').version).toBe(nodes.version);
    expect(pinnedPackRef('vendor.openwop-app.email.agents').version).toBe(agents.version);
  });

  it('the copywriter can submit but has no approve or send tool, and its prompt says so', () => {
    const allow = agents.agents[0]!.toolAllowlist;
    expect(allow).toContain(EMAIL_SUBMIT_FOR_REVIEW_TOOL_ID);
    expect(allow.filter((id) => /send|approve|claim|decide/i.test(id.replace('submit-for-review', '')))).toEqual([]);
    expect(builtinAgentToolIds()).toContain(EMAIL_SUBMIT_FOR_REVIEW_TOOL_ID);
    const prompt = read(join('packs/vendor.openwop-app.email.agents', agents.agents[0]!.systemPromptRef));
    expect(prompt).toContain('You cannot approve or send a campaign.');
  });
});

describe('ADR 0905 D5 — the chat tool and the run surface', () => {
  it('the tool queues ONE review; a resubmit repins it; no human turn ⇒ typed failure', async () => {
    const orgId = (await listOrgs(TENANT))[0]!.orgId;
    await setSenderAddress(TENANT, orgId, 'news@acme.test', 'u-1');
    const p = createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1', runId: 'run-submit' });
    const draft = JSON.parse((await p.executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: 'Spring', body: 'Hello' } })).content) as { campaignId: string };

    const first = await p.executeTool({ name: EMAIL_SUBMIT_FOR_REVIEW_TOOL_ID, input: { campaignId: draft.campaignId } });
    expect(first.isError, first.content).toBeFalsy();
    const r1 = JSON.parse(first.content) as { status: string; approvalId: string };
    expect(r1.status).toBe('in_review');
    expect((await getApproval(r1.approvalId))).toMatchObject({ kind: 'email-campaign-send', status: 'pending', submitters: ['u-1'] });

    const again = JSON.parse((await p.executeTool({ name: EMAIL_SUBMIT_FOR_REVIEW_TOOL_ID, input: { campaignId: draft.campaignId } })).content) as { approvalId: string };
    expect(again.approvalId).toBe(r1.approvalId);

    const system = await createAgentToolProvider({ tenantId: TENANT }).executeTool({ name: EMAIL_SUBMIT_FOR_REVIEW_TOOL_ID, input: { campaignId: draft.campaignId } });
    expect(system.isError).toBe(true);
  });

  it('ctx.features.email can submit, and still has no send or approve method', async () => {
    const orgId = (await listOrgs(TENANT))[0]!.orgId;
    await setSenderAddress(TENANT, orgId, 'news@acme.test', 'u-1');
    const tpl = await createTemplate({ tenantId: TENANT, orgId, name: 'N', subject: 'S', body: 'B', createdBy: 'u-1' });
    const c = await createCampaign({ tenantId: TENANT, orgId, templateId: tpl.templateId, createdBy: 'u-1' });
    const surface = buildEmailSurface({ tenantId: TENANT, actingUserId: 'u-1', orgScopeSubject: 'not-the-actor', runId: 'run-x' });
    expect(Object.keys(surface).filter((k) => /send|approve|claim|decide/i.test(k))).toEqual([]);
    const out = await surface.submitForReview!({ orgId, campaignId: c.campaignId }) as { status: string; templateVersion: number; approvalId: string };
    expect(out).toMatchObject({ status: 'in_review', templateVersion: 1 });
    expect((await getCampaign(TENANT, orgId, c.campaignId))?.status).toBe('in_review');
    expect(await getApproval(out.approvalId)).toMatchObject({ submitters: ['u-1'] });
    expect((await getApproval(out.approvalId))?.submitterCauses).toBeUndefined();
  });
});
