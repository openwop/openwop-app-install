/**
 * ADR 0943 P1 — the campaign agent team ships as data, and every role's eval
 * suite loads through the real `evalSuiteRef` path and DISCRIMINATES.
 *
 * Per role:
 *   - the manifest pins the role's allowlist exactly. No role holds a tool from
 *     its "never allowlisted" column (ADR 0943 D1). Every allowlisted tool is
 *     callable (`builtinAgentToolIds`), which `agent-allowlist-resolution`
 *     also enforces repo-wide;
 *   - the suite validates closed-world, has ≥10 tasks, targets its own agent,
 *     is replay-only (`onMiss:"fail"`), and never both requires and forbids a
 *     tool in the SAME task (an offered tool may be wrong for a particular task);
 *   - run through `POST /runs {mode:"eval"}` with the scripted mock (the
 *     ADR 0889 test seam), a script that follows the task's expected trajectory
 *     passes every task, and a script that violates its tool or output expectation
 *     fails every task. A suite that passed both would be a gate that cannot fail.
 *
 * Both scripts are DERIVED from the suite file, so a task added later is covered
 * by this test without editing it. Live, managed-tier runs of these suites are
 * the `scripts/eval-agent-suite.mts` lane (ADR 0889 D10), not this file.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { builtinAgentTool, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { validateEvalSuite, type AgentEvalSuite } from '../src/host/evals/suiteStore.js';
import { effectiveToolAllowlist } from '../src/host/agentToolAllowlistService.js';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '../../../packs');
const MODEL_CLASS_ENUM = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../schemas/agent-manifest.schema.json'), 'utf8')) as { properties: { modelClass: { enum: string[] } } }).properties.modelClass.enum;
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const T = (s: string): string => `openwop:${s}`;
let server: Server;
let base = '';

/** The tools no role may hold (ADR 0943 D1 "Never allowlisted"): every publish,
 *  send, spend or approval tool the platform registers. */
const NEVER_ANY_ROLE = ['cms.submit-page', 'cms.update-section-draft', 'crm.lead.capture', 'feature.crm.nodes.log-activity', 'feature.crm.nodes.create-task', 'feature.crm.nodes.persist-segment', 'workflows.propose', 'funnels.draft', 'documents.revise'].map(T);

interface Role { pack: string; agentId: string; suite: string; allow: string[]; never: string[] }
const CS = 'vendor.openwop-app.campaign-studio.agents';
const ROLES: Role[] = [
  { pack: CS, agentId: `${CS}.creative-director`, suite: 'evals/creative-director.json',
    allow: ['campaign-brief.get-brief', 'campaign-studio.get-design', 'creative-briefs.list', 'media.list', 'brand.list-brands', 'brand.resolve-voice', 'brand.compliance-check'].map(T),
    never: ['campaign-studio.render', 'campaign-channels.generate', 'email.save-draft'].map(T) },
  { pack: CS, agentId: `${CS}.copywriter`, suite: 'evals/copywriter.json',
    allow: ['campaign-brief.get-brief', 'brand.resolve-voice', 'campaign-channels.channels', 'campaign-channels.generate', 'email.get-campaign', 'email.save-draft', 'brand.compliance-check'].map(T),
    never: ['campaign-orchestration.run', 'cms.submit-page'].map(T) },
  { pack: CS, agentId: `${CS}.cro-analyst`, suite: 'evals/cro-analyst.json',
    allow: ['funnels.list', 'funnels.get', 'funnels.step-stats', 'analytics.query', 'cms.list-pages', 'cms.get-page', 'bi.list-metrics', 'bi.run-metric'].map(T),
    never: ['cms.update-section-draft', 'funnels.draft'].map(T) },
  { pack: CS, agentId: `${CS}.lifecycle-marketer`, suite: 'evals/lifecycle-marketer.json',
    allow: ['feature.crm.nodes.segment-vocabulary', 'feature.crm.nodes.validate-segment', 'feature.crm.nodes.list-segment-members', 'email.get-campaign', 'email.save-draft', 'brand.resolve-voice'].map(T),
    never: ['feature.crm.nodes.persist-segment'].map(T) },
  { pack: CS, agentId: `${CS}.lead-qualifier`, suite: 'evals/lead-qualifier.json',
    allow: ['feature.crm.nodes.get-company', 'feature.crm.nodes.list-companies', 'feature.crm.nodes.list-deals', 'feature.crm.nodes.get-deal', 'feature.crm.nodes.list-tasks', 'cdp.identity.resolve'].map(T),
    never: ['feature.crm.nodes.log-activity', 'crm.lead.capture', 'email.save-draft'].map(T) },
  { pack: CS, agentId: `${CS}.compliance-reviewer`, suite: 'evals/compliance-reviewer.json',
    allow: ['brand.compliance-check', 'brand.resolve-voice', 'campaign-brief.get-brief', 'campaign-brief.validate', 'accessibility.check', 'cms.get-page', 'email.get-campaign'].map(T),
    never: ['email.save-draft', 'comments.post', 'kanban.add-todo'].map(T) },
  { pack: CS, agentId: `${CS}.reporting-analyst`, suite: 'evals/reporting-analyst.json',
    allow: ['campaign-intel.attribution', 'campaign-intel.pacing', 'campaign-intel.forecast', 'campaign-orchestration.status', 'analytics.query', 'funnels.step-stats', 'bi.list-metrics', 'bi.run-metric'].map(T),
    never: ['campaign-orchestration.run', 'comments.post'].map(T) },
  { pack: CS, agentId: `${CS}.producer`, suite: 'evals/producer.json',
    allow: ['campaign-orchestration.status', 'projects.list', 'comments.list', 'comments.post', 'kanban.add-todo', 'notifications.notify-me'].map(T),
    never: ['campaign-orchestration.run', 'campaign-channels.generate', 'email.save-draft'].map(T) },
  { pack: 'vendor.openwop-app.campaign-orchestration.agents', agentId: 'vendor.openwop-app.campaign-orchestration.agents.campaign-strategist', suite: 'evals/campaign-strategist.json',
    allow: ['campaign-orchestration.status', 'campaign-orchestration.get-campaign', 'campaign-orchestration.get-autonomy', 'campaign-orchestration.run'].map(T),
    never: ['campaign-channels.generate', 'email.save-draft'].map(T) },
  { pack: 'vendor.openwop-app.campaign-intel.agents', agentId: 'vendor.openwop-app.campaign-intel.agents.intelligence-analyst', suite: 'evals/intelligence-analyst.json',
    // ADR 0952 P4: + caps (read) and propose-reallocation (opens ONE approval; never applies).
    allow: ['campaign-intel.budget-optimize', 'campaign-intel.forecast', 'campaign-intel.plan-budget', 'campaign-intel.pacing', 'campaign-intel.attribution', 'campaign-intel.caps', 'campaign-intel.propose-reallocation'].map(T),
    never: ['campaign-orchestration.run'].map(T) },
];

function suiteOf(role: Role): AgentEvalSuite {
  return validateEvalSuite(JSON.parse(readFileSync(join(PACKS, role.pack, role.suite), 'utf8')));
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const pack of new Set(ROLES.map((r) => r.pack))) loadAgentsFromManifest(join(PACKS, pack));
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted by the caller */ }
  return { status: res.status, json, text };
}

/** The smallest args a tool's own input schema accepts, so a scripted call
 *  reaches the fixture interceptor (arguments are validated before it). */
function stubArgs(schema: unknown, depth = 0): unknown {
  const s = (schema && typeof schema === 'object' ? schema : {}) as { type?: string | string[]; enum?: unknown[]; required?: string[]; properties?: Record<string, unknown>; minLength?: number; format?: string; minimum?: number; minItems?: number; items?: unknown };
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'string': return s.format === 'date-time' ? '2026-10-20T00:00:00Z' : s.format === 'date' ? '2026-10-20' : 'x'.repeat(Math.max(4, s.minLength ?? 0));
    case 'number': case 'integer': return Math.max(1, s.minimum ?? 1);
    case 'boolean': return true;
    case 'array': return s.minItems ? Array.from({ length: s.minItems }, () => stubArgs(s.items, depth + 1)) : [];
    default: {
      if (depth > 6) return {};
      const out: Record<string, unknown> = {};
      for (const k of s.required ?? []) out[k] = stubArgs(s.properties?.[k], depth + 1);
      return out;
    }
  }
}
const argsFor = (tool: string): Record<string, unknown> => stubArgs(builtinAgentTool(tool)?.def.inputSchema) as Record<string, unknown>;

type Round = { toolCalls: Array<{ name: string; input: Record<string, unknown> }> } | { content: string };
interface Summary { passed: boolean; passedCount: number; taskCount: number; tasks: Array<{ taskId: string; passed: boolean }> }

async function runSuite(suite: AgentEvalSuite, agentId: string, rounds: Record<string, Round[]>): Promise<Summary> {
  const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: `${suite.suiteId}@${suite.version}`, agentId, configurable: { mockProvider: { id: 'tool-calls', rounds } } });
  expect(c.status, c.text.slice(0, 400)).toBe(201);
  const runId = String(c.json['runId']);
  for (let i = 0; i < 800; i += 1) {
    const r = await send('GET', `/runs/${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(String(r.json['status']))) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  const s = await send('GET', `/runs/${runId}/eval-summary`);
  expect(s.status, s.text.slice(0, 400)).toBe(200);
  return s.json as unknown as Summary;
}

describe.each(ROLES)('ADR 0943 P1 — $agentId', (role) => {
  it('the manifest pins the allowlist and holds no never-allowlisted tool', () => {
    const agent = getAgentRegistry().get(role.agentId);
    if (!agent) throw new Error(`${role.agentId} did not load from its pack`);
    expect([...(agent.toolAllowlist ?? [])].sort()).toEqual([...role.allow].sort());
    for (const t of [...NEVER_ANY_ROLE, ...role.never]) expect(agent.toolAllowlist ?? []).not.toContain(t);
    const callable = new Set(builtinAgentToolIds());
    expect(role.allow.filter((t) => !callable.has(t))).toEqual([]);
    expect(agent.evalSuite, 'the evalSuiteRef resolved through the loader').toBeDefined();
    // The wire enum (RFC 0002), read from the vendored schema: `chat` is a HOST
    // resolver class, not a manifest value.
    expect(MODEL_CLASS_ENUM).toContain(agent.modelClass);
  });

  it('the suite is closed-world valid, ≥10 tasks, replay-only, and each task has coherent expectations', () => {
    const s = suiteOf(role);
    expect(s.targetAgentId).toBe(role.agentId);
    expect(s.tasks.length).toBeGreaterThanOrEqual(10);
    for (const t of s.tasks) {
      expect(t.fixtures?.onMiss, t.taskId).toBe('fail');
      const forbidden = t.expected.trajectory?.forbidden ?? [];
      const required = (t.expected.trajectory?.calls ?? []).map((c) => c.tool);
      expect(forbidden.filter((f) => required.includes(f)), t.taskId).toEqual([]);
      // The forbidden list must bite on a tool the role is actually OFFERED (the
      // ADR 0315 default-on writes), or the check is vacuous for this task.
      const offered = new Set(effectiveToolAllowlist(role.allow, undefined));
      if (forbidden.length) expect(forbidden.filter((f) => offered.has(f)).length, `${t.taskId} forbids no offered tool`).toBeGreaterThan(0);
      else expect(t.expected.kind, `${t.taskId} needs an output criterion when it forbids no tool`).toBe('golden');
      for (const c of t.expected.trajectory?.calls ?? []) expect(role.allow, `${t.taskId} expects a tool the role lacks`).toContain(c.tool);
    }
  });

  it('discriminates: the follower passes every task, the violator fails every task', async () => {
    const s = suiteOf(role);
    const offered = new Set(effectiveToolAllowlist(getAgentRegistry().get(role.agentId)?.toolAllowlist, undefined));
    const follow: Record<string, Round[]> = {};
    const violate: Record<string, Round[]> = {};
    for (const t of s.tasks) {
      const calls = (t.expected.trajectory?.calls ?? []).map((c) => {
        const explicit = c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? c.args as Record<string, unknown> : {};
        return { toolCalls: [{ name: c.tool, input: c.argsMatch === 'exact' ? explicit : { ...argsFor(c.tool), ...explicit } }] };
      });
      let answer = 'Done. Here is what I found, and what waits on a person.';
      if (t.expected.kind === 'golden') {
        const match = t.expected.match;
        if (!match || typeof match.value !== 'string' || !['contains', 'exact'].includes(match.strategy)) throw new Error(`${t.taskId} needs a supported scripted golden answer`);
        answer = match.value;
      }
      follow[t.taskId] = [...calls, { content: answer }];
      // A tool the role is not offered can never be called (the surface drops it
      // before the interceptor), so the violator calls a forbidden tool it IS
      // offered: one of the ADR 0315 default-on writes every agent receives.
      const bad = (t.expected.trajectory?.forbidden ?? []).find((f) => offered.has(f));
      violate[t.taskId] = bad
        ? [...calls, { toolCalls: [{ name: bad, input: argsFor(bad) }] }, { content: 'Done.' }]
        : [...calls, { content: 'INVALID-GOLDEN-ANSWER' }];
    }
    const ok = await runSuite(s, role.agentId, follow);
    expect(ok.tasks.filter((t) => !t.passed).map((t) => t.taskId)).toEqual([]);
    expect(ok).toMatchObject({ passed: true, taskCount: s.tasks.length });
    const bad = await runSuite(s, role.agentId, violate);
    expect(bad.tasks.filter((t) => t.passed).map((t) => t.taskId)).toEqual([]);
    expect(bad.passed).toBe(false);
  }, 60_000);
});
