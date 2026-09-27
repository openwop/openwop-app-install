/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the CRM sales-ops + segment-author and CSM
 * health-insights personas' REAL chat tools.
 *
 * The contract under test: every id the `feature.crm.agents` / `feature.csm.agents`
 * packs allowlist is OFFERABLE by the live tool provider (was silently dropped —
 * the personas ran with zero tools), and each tool is gated EXACTLY like its HTTP
 * route: toggle honesty, acting user (reads fail EMPTY, writes fail TYPED), and
 * the org RBAC predicate for the org-scoped CRM tools. Boots the REAL app (the
 * ADR 0308 D2 registration seam is what's under test).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  CRM_LIST_COMPANIES_TOOL_ID,
  CRM_GET_COMPANY_TOOL_ID,
  CRM_LIST_DEALS_TOOL_ID,
  CRM_GET_DEAL_TOOL_ID,
  CRM_LIST_TASKS_TOOL_ID,
  CRM_LOG_ACTIVITY_TOOL_ID,
  CRM_CREATE_TASK_TOOL_ID,
  CRM_LIST_SEGMENT_MEMBERS_TOOL_ID,
  CRM_PERSIST_SEGMENT_TOOL_ID,
} from '../src/features/crm/agentTools.js';
import { CSM_HEALTH_READ_TOOL_ID } from '../src/features/csm/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';

const TENANT = 'default';
const CRM_IDS = [
  CRM_LIST_COMPANIES_TOOL_ID, CRM_GET_COMPANY_TOOL_ID, CRM_LIST_DEALS_TOOL_ID, CRM_GET_DEAL_TOOL_ID,
  CRM_LIST_TASKS_TOOL_ID, CRM_LOG_ACTIVITY_TOOL_ID, CRM_CREATE_TASK_TOOL_ID,
  CRM_LIST_SEGMENT_MEMBERS_TOOL_ID, CRM_PERSIST_SEGMENT_TOOL_ID,
];

let server: http.Server;
let orgId: string;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP path — the owner `u-1` holds workspace:read+write.
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};
function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

describe('CFP-1 — the pack allowlist ids are offerable by the live provider', () => {
  it('every crm.agents + csm.agents id is a builtin agent tool', () => {
    const ids = new Set(builtinAgentToolIds());
    for (const id of [...CRM_IDS, CSM_HEALTH_READ_TOOL_ID]) expect(ids.has(id), id).toBe(true);
  });
});

describe('CFP-1 — CRM sales-ops tools (org-scoped)', () => {
  beforeAll(async () => { await setToggle('crm', 'on'); });

  it('list-companies happy path returns { companies }', async () => {
    const out = await provider({ actingUserId: 'u-1', runId: 'r1' }).executeTool({ name: CRM_LIST_COMPANIES_TOOL_ID, input: { orgId } });
    expect(out.isError).toBeFalsy();
    expect(Array.isArray(parse(out).companies)).toBe(true);
  });

  it('reads FAIL EMPTY without an acting user (no leak, not an error)', async () => {
    const out = await provider().executeTool({ name: CRM_LIST_COMPANIES_TOOL_ID, input: { orgId } });
    expect(out.isError).toBeFalsy();
    expect(parse(out).companies).toEqual([]);
  });

  it('missing orgId is a TYPED org_required error (invalid model input)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CRM_LIST_DEALS_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('org_required');
  });

  it('an org the user cannot access is forbidden_scope (routes predicate parity)', async () => {
    const out = await provider({ actingUserId: 'stranger' }).executeTool({ name: CRM_LIST_COMPANIES_TOOL_ID, input: { orgId } });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('forbidden_scope');
  });

  it('toggle OFF ⇒ typed feature_disabled', async () => {
    await setToggle('crm', 'off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CRM_LIST_COMPANIES_TOOL_ID, input: { orgId } });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('feature_disabled');
    await setToggle('crm', 'on');
  });

  it('create-task WRITE fails TYPED (not empty) without an acting user', async () => {
    const out = await provider().executeTool({ name: CRM_CREATE_TASK_TOOL_ID, input: { orgId, title: 'Follow up' } });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('acting_user_required');
  });

  it('create-task + log-activity happy path writes through the surface', async () => {
    const p = provider({ actingUserId: 'u-1', runId: 'r-write' });
    const task = await p.executeTool({ name: CRM_CREATE_TASK_TOOL_ID, input: { orgId, title: 'Send proposal' } });
    expect(task.isError).toBeFalsy();
    expect(parse(task).success).toBe(true);
    const act = await p.executeTool({ name: CRM_LOG_ACTIVITY_TOOL_ID, input: { orgId, kind: 'note', body: 'Called the buyer' } });
    expect(act.isError).toBeFalsy();
    expect(parse(act).success).toBe(true);
  });
});

describe('CFP-1 — CRM segment-author persist trio (tenant-scoped)', () => {
  beforeAll(async () => { await setToggle('crm', 'on'); });

  it('persist-segment refuses an invalid draft WITHOUT writing (closed-world gate)', async () => {
    const out = await provider({ actingUserId: 'u-1', runId: 'r-seg' }).executeTool({
      name: CRM_PERSIST_SEGMENT_TOOL_ID,
      input: { name: 'Bad', filters: [{ field: 'not_a_real_field', op: 'eq', value: 'x' }] },
    });
    expect(out.isError).toBe(true);
    expect(parse(out).success).toBe(false);
    expect(Array.isArray(parse(out).errors)).toBe(true);
  });

  it('persist-segment saves a valid draft, then list-segment-members previews it', async () => {
    const p = provider({ actingUserId: 'u-1', runId: 'r-seg2' });
    const saved = await p.executeTool({ name: CRM_PERSIST_SEGMENT_TOOL_ID, input: { name: 'All contacts', filters: [] } });
    expect(saved.isError).toBeFalsy();
    expect(parse(saved).success).toBe(true);
    const segment = parse(saved).segment as { segmentId: string };
    const preview = await p.executeTool({ name: CRM_LIST_SEGMENT_MEMBERS_TOOL_ID, input: { segmentId: segment.segmentId } });
    expect(preview.isError).toBeFalsy();
    expect(Array.isArray(parse(preview).members)).toBe(true);
  });

  it('persist-segment fails TYPED without an acting user', async () => {
    const out = await provider().executeTool({ name: CRM_PERSIST_SEGMENT_TOOL_ID, input: { name: 'X', filters: [] } });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('acting_user_required');
  });
});

describe('CFP-1 — CSM health-insights read tool (tenant-scoped)', () => {
  beforeAll(async () => { await setToggle('csm', 'on'); });

  it('health-read happy path returns { accounts }', async () => {
    const out = await provider({ actingUserId: 'u-1', runId: 'r-csm' }).executeTool({ name: CSM_HEALTH_READ_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(Array.isArray(parse(out).accounts)).toBe(true);
  });

  it('FAILS EMPTY without an acting user', async () => {
    const out = await provider().executeTool({ name: CSM_HEALTH_READ_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out).accounts).toEqual([]);
  });

  // CSMWF-1 / ADR 0645 D1 — the tool must share its ROUTE's access predicate.
  // `GET /accounts` demands `workspace:read` (`routes.ts:150`); before this the
  // tool demanded only the toggle and an acting user, then did a tenant-wide
  // `listAccounts`. So a member with zero `workspace:read` got a 403 from the
  // route and the FULL account book — ARR, renewal dates, owner attribution —
  // from chat. The sibling `crm/agentTools.ts:147-158` already calls
  // `assertTenantScope`; same helper, same bundle, honored on one side only.
  it('CSMWF-1: a principal WITHOUT workspace:read is refused, not handed the book', async () => {
    const out = await provider({ actingUserId: 'u-no-scope' }).executeTool({ name: CSM_HEALTH_READ_TOOL_ID, input: {} });
    expect(out.isError, JSON.stringify(out)).toBe(true);
    // Refused for the RIGHT reason — not a disguised toggle/feature error.
    expect(parse(out).error).toBe('forbidden_scope');
    // …and no account data rode along with the error.
    expect(JSON.stringify(out)).not.toContain('arr');
  });

  it('toggle OFF ⇒ typed feature_disabled', async () => {
    await setToggle('csm', 'off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CSM_HEALTH_READ_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('feature_disabled');
    await setToggle('csm', 'on');
  });
});
