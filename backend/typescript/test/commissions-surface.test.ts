/**
 * Sales Commissions — ADR 0280 Phase 4 + ADR 0820 G2 (the
 * ctx.features['sales-commissions'] surface + packs). Tracker: TST-CGA-1.
 *
 * Surface: governed writes (compute/approve) enforce the RUN OWNER's
 * host:commissions:manage; a system run (no acting user) is denied; statement
 * reads are subject-scoped. R2 COM2-M3: approve SUBMITS for review, never applies.
 * Packs: node + agent manifests validate; writes are side-effectful + kept out of
 * the advisory agent's allowlist; index.mjs exports the node functions.
 *
 * Red when: `hasManage` grants a non-manager or a system run (surface.ts);
 * `listStatements` stops filtering to the viewer's own subject (entities/statement.ts
 * — the read fixture holds TWO subjects' statements, so a rep who could read the
 * owner's statement shows up); the approve node returns success without a review.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildCommissionSurface } from '../src/features/sales-commissions/surface.js';
import { PACK_PINS } from '../src/features/packPins.js';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'sales-commissions']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return { post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
interface LoginBody { user: { userId: string } }
interface StatementRow { statementId: string; subjectId: string; status: string }
let n = 0;

describe('commissions P4 — governed surface writes + subject-scoped reads', () => {
  it('compute/approve require the run owner host:commissions:manage; system run denied; reads are subject-scoped', async () => {
    const tenantId = `org:commsurf-${Date.now()}-${n++}`;
    const owner = client();
    const ownerId = (await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const rep = client();
    const repId = (await rep.post<LoginBody>('/host/openwop-app/test/login', { email: `r-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const added = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'R', subject: repId, roles: ['editor'] });
    expect(added.status).toBe(201);

    const B = `/host/openwop-app/commissions/orgs/${encodeURIComponent(orgId)}`;
    const planRes = await owner.post<{ planId: string }>(`${B}/plans`, { name: 'P', currency: 'USD', assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-01-01', rules: [{ basis: 'deal-won', type: 'fixed', rate: 100 }] });
    expect(planRes.status, JSON.stringify(planRes.body)).toBe(201);
    const planId = planRes.body.planId;
    // A SECOND subject's plan, so subject-scoping has something to hide from the rep.
    const ownerPlanRes = await owner.post<{ planId: string }>(`${B}/plans`, { name: 'P-owner', currency: 'USD', assignment: { kind: 'rep', ref: ownerId }, effectiveFrom: '2026-01-01', rules: [{ basis: 'deal-won', type: 'fixed', rate: 100 }] });
    expect(ownerPlanRes.status, JSON.stringify(ownerPlanRes.body)).toBe(201);
    await owner.post(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/deals`, { title: 'D', amount: 1000, owner: repId, closeDate: '2026-02-10', status: 'won' });

    const surfaceFor = (actingUserId?: string) => buildCommissionSurface({ tenantId, ...(actingUserId ? { actingUserId } : {}), runId: `run-${n++}` });

    // computeStatement — the rep (editor, no manage) is DENIED; a system run is DENIED; the owner SUCCEEDS.
    await expect(surfaceFor(repId).computeStatement!({ orgId, planId, subjectId: repId, period: '2026-Q1' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(surfaceFor(undefined).computeStatement!({ orgId, planId, subjectId: repId, period: '2026-Q1' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    const computed = await surfaceFor(ownerId).computeStatement!({ orgId, planId, subjectId: repId, period: '2026-Q1' }) as { success: boolean; statement: { statementId: string } };
    expect(computed.success).toBe(true);
    const statementId = computed.statement.statementId;
    // The owner's OWN statement (a different subject) — the row the rep must never see.
    const ownerStmt = await surfaceFor(ownerId).computeStatement!({ orgId, planId: ownerPlanRes.body.planId, subjectId: ownerId, period: '2026-Q1' }) as { statement: { statementId: string } };
    const statementsOf = async (actingUserId?: string): Promise<StatementRow[]> =>
      (await surfaceFor(actingUserId).listStatements!({ orgId })).statements as StatementRow[];

    // approveStatement — same governance, and (R2 COM2-M3) it SUBMITS rather than
    // approves. This assertion used to read `approved.statement.status === 'approved'`,
    // i.e. it pinned the defect: the node applied the transition itself, so a chain could
    // approve every draft statement in an org with no review card and no second person,
    // stamping `approvedBy: run:<id>` on a payout record — while `routes.ts` claimed "no
    // path approves a statement without the gate".
    await expect(surfaceFor(repId).approveStatement!({ orgId, statementId })).rejects.toMatchObject({ code: 'forbidden_scope' });
    const submitted = await surfaceFor(ownerId).approveStatement!({ orgId, statementId }) as { submittedForReview: boolean; review: { status: string } };
    expect(submitted.submittedForReview).toBe(true);
    expect(submitted.review.status).toBe('pending');
    // …and the statement itself has NOT moved.
    expect((await statementsOf(ownerId)).find((s) => s.statementId === statementId)?.status).toBe('draft');

    // Reads: subject-scoped. The rep's run sees ONLY their own statement — the
    // owner's statement exists and is absent; a manager sees both.
    const repView = await statementsOf(repId);
    expect(repView.map((s) => s.statementId)).toEqual([statementId]);
    expect(repView.some((s) => s.statementId === ownerStmt.statement.statementId)).toBe(false);
    expect((await statementsOf(ownerId)).map((s) => s.statementId).sort()).toEqual([statementId, ownerStmt.statement.statementId].sort());
    // A system run (no owner) sees none (fail-closed).
    expect(await statementsOf(undefined)).toHaveLength(0);
    // listPlans is open to any tenant-scoped run.
    expect((await surfaceFor(repId).listPlans!({ orgId })).plans).toHaveLength(2);
  });
});

const REPO_ROOT = join(__dirname, '..', '..', '..');
const NODES_DIR = join(REPO_ROOT, 'packs', 'feature.sales-commissions.nodes');
const AGENTS_DIR = join(REPO_ROOT, 'packs', 'vendor.openwop-app.sales-commissions.agents');
interface NodesManifest { name: string; version: string; nodes: Array<{ typeId: string; role: string; capabilities: string[] }>; runtime: { entry: string } }
interface AgentsManifest { agents: Array<{ agentId: string; toolAllowlist: string[] }> }

describe('feature.sales-commissions.nodes pack', () => {
  const manifest = JSON.parse(readFileSync(join(NODES_DIR, 'pack.json'), 'utf8')) as NodesManifest;
  it('declares 2 read + 2 governed (side-effectful) write nodes', () => {
    expect(manifest.name).toBe('feature.sales-commissions.nodes');
    // The manifest version must equal the feature's pin (ADR 0919 PACK_PINS) — the
    // boot installer resolves the pack at that version, so a mismatch ships a pack
    // the feature does not require. A coordinated bump of both stays green.
    expect(manifest.version).toBe(PACK_PINS['feature.sales-commissions.nodes']);
    expect(manifest.nodes).toHaveLength(4);
    for (const node of manifest.nodes) expect(node.role, node.typeId).toBe('action');
    const writes = manifest.nodes.filter((node) => node.capabilities.includes('side-effectful')).map((node) => node.typeId).sort();
    expect(writes).toEqual(['feature.sales-commissions.nodes.approve-statement', 'feature.sales-commissions.nodes.compute-statement']);
  });
  it('index.mjs exports every node handler', async () => {
    const mod = (await import(pathToFileURL(join(NODES_DIR, manifest.runtime.entry)).href)) as Record<string, unknown>;
    for (const fn of ['listPlans', 'listStatements', 'computeStatement', 'approveStatement']) expect(typeof mod[fn], fn).toBe('function');
  });

  it('R2 review — the approve node returns the REVIEW, and fails loudly if the surface does not', async () => {
    // The surface stopped applying the transition (COM2-M3) and this wrapper still read
    // `out.statement`, which no longer exists — so a chain got `status: 'success'` with
    // `statement: null`, threw away the `approvalId`, and a downstream edge on
    // `statement.status === 'approved'` read `undefined` and took the wrong branch.
    // Success-with-empty, in the fix that closed M3.
    const mod = (await import(pathToFileURL(join(NODES_DIR, manifest.runtime.entry)).href)) as {
      approveStatement: (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown> }>;
    };
    // `ensure()` probes `listPlans`, and args come from `ctx.config`/`ctx.inputs`.
    const ctx = (surfaceOut: unknown) => ({
      features: { 'sales-commissions': { listPlans: async () => ({ plans: [] }), approveStatement: async () => surfaceOut } },
      inputs: { orgId: 'org-1', statementId: 's1' },
    });
    const ok = await mod.approveStatement(ctx({ success: true, submittedForReview: true, review: { approvalId: 'appr:x', status: 'pending' } }));
    expect(ok.status).toBe('success');
    expect(ok.outputs.review).toEqual({ approvalId: 'appr:x', status: 'pending' });
    expect(ok.outputs.submittedForReview).toBe(true);
    // …and a surface that returns something else is a typed FAILURE, never a green run.
    await expect(mod.approveStatement(ctx({ success: true }))).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('vendor.openwop-app.sales-commissions.agents pack', () => {
  const manifest = JSON.parse(readFileSync(join(AGENTS_DIR, 'pack.json'), 'utf8')) as AgentsManifest;
  it('the advisory analyst is allowlisted to READS only — no governed write nodes', () => {
    const allow = manifest.agents[0].toolAllowlist;
    expect(allow).toContain('openwop:sales-commissions.list-plans');
    expect(allow).toContain('openwop:sales-commissions.list-statements');
    expect(allow).not.toContain('openwop:sales-commissions.compute-statement');
    expect(allow).not.toContain('openwop:sales-commissions.approve-statement');
  });
});
