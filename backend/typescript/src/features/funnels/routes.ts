/**
 * Funnels routes (ADR 0294 / Funnel A, Phase 1). Authed operator surface under
 * `/v1/host/openwop-app/funnels/orgs/:orgId` (toggle `funnels` + `authorizeOrgScope`;
 * read = workspace:read, write = workspace:write; tenant+org IDOR-guarded in the
 * service). The PUBLIC serving surface is Phase 2 — nothing here is anonymous.
 */
import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg } from '../../host/accessControlService.js';
import { isAllowed } from '../consent/consentService.js';
import { collectEvent } from '../cdp/collectService.js';
// Cross-feature, integrator → primitive (the ADR 0330 direction funnels already
// takes in `formsAttributionSink.ts`): funnels reads forms, forms imports no
// destination feature. FORM-FUNNEL-1 — a held submission may not complete a step.
import { isSubmissionHeld } from '../forms/formsService.js';
import { createLogger } from '../../observability/logger.js';
import {
  listFunnels, getFunnel, createFunnel, updateFunnel, deleteFunnel,
  publishFunnel, unpublishFunnel, archiveFunnel,
  getPublishedFunnelBySlug, publicFunnelStep, setStepExperiment, stopStepExperiment,
  type Funnel, type PublicFunnelStep,
} from './funnelsService.js';
import { stepExperimentResults } from './funnelStats.js';
import { getFunnelStats, rebuildFunnelStats, FUNNEL_STATS_EVENT_WINDOW } from './funnelStats.js';
import { resolveNextStepIx, STEP_OUTCOMES, type RoutingContext, type StepOutcome } from './funnelRouting.js';

const log = createLogger('funnels');
const FEATURE = { toggleId: 'funnels', label: 'Funnels' };
const BASE = '/v1/host/openwop-app/funnels/orgs/:orgId';
// Nested under the publishing public prefix — already on PUBLIC_PATH_PREFIXES
// (auth.ts), so anonymous reads pass auth; the per-tenant toggle is the gate.
const PUB = '/v1/host/openwop-app/public/:orgId/funnels';

const MAX_VK = 128;

/** Bounded visitor key (the analytics beacon sessionKey — the ADR 0236 `?vk=`). */
function visitorKey(req: Request): string {
  const vk = typeof req.query.vk === 'string' ? req.query.vk : '';
  return vk.length > 0 && vk.length <= MAX_VK ? vk : '';
}

/** Bounded utm_* extraction from the query string (first 5 keys). */
function utmParams(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (!k.startsWith('utm_') || typeof v !== 'string') continue;
    out[k.slice(4).slice(0, 64)] = v.slice(0, 200);
    if (Object.keys(out).length >= 5) break;
  }
  return out;
}

/** org→tenant + published funnel + toggle, uniform 404 (no existence leak). */
async function resolvePublicFunnel(orgId: string, slug: string): Promise<{ tenantId: string; funnel: Funnel }> {
  const org = await getOrg(orgId);
  if (!org) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
  const assignment = await resolveOne(FEATURE.toggleId, { tenantId: org.tenantId });
  if (!assignment || !assignment.enabled) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
  const funnel = await getPublishedFunnelBySlug(org.tenantId, orgId, slug);
  if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
  return { tenantId: org.tenantId, funnel };
}

/** The visitor key AFTER the ONE consent gate — used for events AND (Phase 4)
 *  experiment assignment, so the two can never disagree. */
async function consentedVisitor(tenantId: string, req: Request): Promise<string> {
  const vk = visitorKey(req);
  if (!vk) return '';
  try { return (await isAllowed(tenantId, vk, 'analytics')) ? vk : ''; } catch { return ''; }
}

/** Best-effort step event onto the CDP spine (ADR 0269) — callers pass a vk
 *  that already passed the consent gate. An ingest failure must never break
 *  public serving. */
async function emitStepEvent(
  tenantId: string, orgId: string, funnel: Funnel, eventType: 'funnel.step_viewed' | 'funnel.step_completed',
  step: { stepId: string; kind: string; ix: number; experiment?: PublicFunnelStep['experiment'] }, vk: string, utm: Record<string, string>, outcome?: StepOutcome,
): Promise<void> {
  if (!vk) return;
  try {
    await collectEvent(tenantId, eventType, {
      orgId, funnelId: funnel.funnelId, funnelSlug: funnel.slug,
      stepId: step.stepId, stepKind: step.kind, stepIx: step.ix,
      visitor: vk,
      ...(step.experiment ? { experiment: step.experiment } : {}),
      ...(Object.keys(utm).length ? { utm } : {}),
      ...(outcome ? { outcome } : {}),
    });
  } catch (err) {
    log.warn('funnel_step_event_failed', { eventType, funnelId: funnel.funnelId, err: err instanceof Error ? err.message : String(err) });
  }
}

export function registerFunnelsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/funnels`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ funnels: await listFunnels(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/funnels/:funnelId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const funnel = await getFunnel(tenantId, orgId, req.params.funnelId);
      if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      res.json({ funnel });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/funnels`, async (req: Request, res: Response, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = req.body ?? {};
      const funnel = await createFunnel({
        tenantId, orgId, createdBy: user.userId,
        name: b.name, slug: b.slug, steps: b.steps,
      });
      res.status(201).json({ funnel });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/funnels/:funnelId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = req.body ?? {};
      const funnel = await updateFunnel(tenantId, orgId, req.params.funnelId, { name: b.name, slug: b.slug, steps: b.steps, completionCta: b.completionCta });
      if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      res.json({ funnel });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/funnels/:funnelId/publish`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const funnel = await publishFunnel(tenantId, orgId, req.params.funnelId);
      if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      res.json({ funnel });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/funnels/:funnelId/unpublish`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const funnel = await unpublishFunnel(tenantId, orgId, req.params.funnelId);
      if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      res.json({ funnel });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/funnels/:funnelId/archive`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const funnel = await archiveFunnel(tenantId, orgId, req.params.funnelId);
      if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      res.json({ funnel });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/funnels/:funnelId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const ok = await deleteFunnel(tenantId, orgId, req.params.funnelId);
      if (!ok) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── Step experiments (Phase 4 — authed manage + results) ──────────────────

  app.post(`${BASE}/funnels/:funnelId/steps/:stepId/experiment`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const funnel = await setStepExperiment(tenantId, orgId, req.params.funnelId, req.params.stepId, (req.body ?? {}).variants);
      if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      res.status(201).json({ funnel });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/funnels/:funnelId/steps/:stepId/experiment`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const funnel = await stopStepExperiment(tenantId, orgId, req.params.funnelId, req.params.stepId);
      if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      res.json({ funnel });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/funnels/:funnelId/steps/:stepId/experiment/results`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const results = await stepExperimentResults(tenantId, orgId, req.params.funnelId, req.params.stepId);
      if (!results) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      res.json(results);
    } catch (err) { next(err); }
  });

  // ── Analytics (Phase 3 — authed reads over the DERIVED day rows) ──────────

  app.get(`${BASE}/funnels/:funnelId/stats`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const funnel = await getFunnel(tenantId, orgId, req.params.funnelId);
      if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      const days = await getFunnelStats(tenantId, orgId, funnel.funnelId);
      // per-step totals in STEP ORDER (steps no longer on the funnel — e.g. a
      // removed step with history — are appended, tolerate-on-read)
      const totals = new Map<string, { views: number; completions: number; revenue: number; orders: number; revenueByCurrency: Record<string, number> }>();
      for (const row of days) {
        for (const [stepId, cell] of Object.entries(row.steps)) {
          const t = totals.get(stepId) ?? { views: 0, completions: 0, revenue: 0, orders: 0, revenueByCurrency: {} };
          t.views += cell.views; t.completions += cell.completions; t.revenue += cell.revenue; t.orders += cell.orders;
          for (const [code, amt] of Object.entries(cell.revenueByCurrency ?? {})) t.revenueByCurrency[code] = (t.revenueByCurrency[code] ?? 0) + amt;
          totals.set(stepId, t);
        }
      }
      const known = new Set(funnel.steps.map((s) => s.stepId));
      const steps = [
        ...funnel.steps.map((s) => ({
          stepId: s.stepId, kind: s.kind, ...(s.name ? { name: s.name } : {}),
          ...(totals.get(s.stepId) ?? { views: 0, completions: 0, revenue: 0, orders: 0, revenueByCurrency: {} }),
        })),
        ...[...totals.entries()].filter(([id]) => !known.has(id))
          .map(([stepId, t]) => ({ stepId, kind: 'removed' as const, ...t })),
      ].map((s) => ({ ...s, conversion: s.views > 0 ? Math.round((s.completions / s.views) * 1000) / 1000 : null }));
      res.json({
        funnelId: funnel.funnelId,
        steps,
        days: days.map((d) => ({ day: d.day, steps: d.steps })),
        // honesty: the rollup reads the most recent N events — older activity
        // ages out of views/completions (revenue joins ALL orders).
        eventWindow: FUNNEL_STATS_EVENT_WINDOW,
        rebuiltAt: days.at(-1)?.rebuiltAt ?? null,
      });
    } catch (err) { next(err); }
  });

  // On-demand rebuild (write-scoped: a full recompute is operator work).
  app.post(`${BASE}/funnels/:funnelId/stats/rebuild`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const funnel = await getFunnel(tenantId, orgId, req.params.funnelId);
      if (!funnel) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      const rows = await rebuildFunnelStats(tenantId, orgId);
      res.json({ ok: true, rows });
    } catch (err) { next(err); }
  });

  // ── PUBLIC (Phase 2 — unauthed; the funnel entry + routed advance) ─────────

  // Entry: the funnel's first available step. The renderer then fetches the
  // step's page via the EXISTING `/public/:orgId/pages/:pageSlug` read (with
  // the same ?vk=), so experiments/localization/SEO apply verbatim.
  app.get(`${PUB}/:slug`, async (req: Request, res: Response, next) => {
    try {
      const orgId = req.params.orgId;
      const { tenantId, funnel } = await resolvePublicFunnel(orgId, req.params.slug);
      const vk = await consentedVisitor(tenantId, req); const utm = utmParams(req);
      const step = await publicFunnelStep(tenantId, orgId, funnel, 0, vk);
      if (!step) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      await emitStepEvent(tenantId, orgId, funnel, 'funnel.step_viewed', step, vk, utm);
      res.json({ funnel: { slug: funnel.slug, name: funnel.name }, stepCount: funnel.steps.length, step });
    } catch (err) { next(err); }
  });

  // Direct step read (deep-link / refresh mid-funnel).
  app.get(`${PUB}/:slug/steps/:stepIx`, async (req: Request, res: Response, next) => {
    try {
      const orgId = req.params.orgId;
      const { tenantId, funnel } = await resolvePublicFunnel(orgId, req.params.slug);
      const ix = Number.parseInt(req.params.stepIx, 10);
      if (!Number.isInteger(ix) || ix < 0) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      const vk = await consentedVisitor(tenantId, req); const utm = utmParams(req);
      const step = await publicFunnelStep(tenantId, orgId, funnel, ix, vk);
      if (!step) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      await emitStepEvent(tenantId, orgId, funnel, 'funnel.step_viewed', step, vk, utm);
      res.json({ funnel: { slug: funnel.slug, name: funnel.name }, stepCount: funnel.steps.length, step });
    } catch (err) { next(err); }
  });

  // Routed advance: complete `from` (with an optional outcome), resolve the
  // next step through the PURE routing evaluation, view it.
  app.get(`${PUB}/:slug/next`, async (req: Request, res: Response, next) => {
    try {
      const orgId = req.params.orgId;
      const { tenantId, funnel } = await resolvePublicFunnel(orgId, req.params.slug);
      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const rawOutcome = typeof req.query.outcome === 'string' ? req.query.outcome : undefined;
      if (rawOutcome !== undefined && !(STEP_OUTCOMES as readonly string[]).includes(rawOutcome)) {
        throw new OpenwopError('validation_error', `outcome must be one of: ${STEP_OUTCOMES.join(', ')}`, 400, { field: 'outcome' });
      }
      const outcome = rawOutcome as StepOutcome | undefined;
      const vk = await consentedVisitor(tenantId, req); const utm = utmParams(req);
      const ctx: RoutingContext = { ...(outcome ? { outcome } : {}), ...(Object.keys(utm).length ? { utm } : {}) };
      const resolved = resolveNextStepIx(funnel.steps, from, ctx);
      if ('error' in resolved) throw new OpenwopError('validation_error', 'Unknown from step.', 400, { field: 'from' });
      const fromIx = funnel.steps.findIndex((s) => s.stepId === from);
      const fromStep = funnel.steps[fromIx];
      // The completion carries the SAME variant stamp the visitor was served
      // (re-derived deterministically — sticky assignment guarantees identity).
      const fromServed = await publicFunnelStep(tenantId, orgId, funnel, fromIx, vk);
      // ADR 0584 §Correction (FORM-FUNNEL-1) — a step completed by a
      // QUARANTINED form submission is NOT a completion.
      //
      // Three places said a held submission fires "no funnel completion". Only
      // the ADR 0332 sink honoured it (it never runs for a held row); THIS
      // emit did not, because the viewer advances on `onSubmitted` and the
      // route had no idea which submission it was advancing off. So bot volume
      // and false-positive holds both landed in the conversion rollup.
      //
      // The viewer now passes the id it was handed, and the completion is
      // withheld for a held row. Everything ELSE about the advance is
      // unchanged — the visitor still moves to the next step, deliberately: a
      // false-positive respondent must not be walled into a step they cannot
      // leave (the FORM-UX-4 gate-with-no-exit shape this same ADR fixed), and
      // the response the visitor sees is identical either way, so this suppresses
      // an ANALYTICS EVENT without opening the spam oracle. An unknown or
      // cross-tenant id reads as not-held, i.e. exactly today's behaviour.
      const submissionId = typeof req.query.submission === 'string' ? req.query.submission.slice(0, 128) : '';
      const held = submissionId ? await isSubmissionHeld(tenantId, submissionId) : false;
      if (held) log.info('funnel_completion_withheld', { funnelId: funnel.funnelId, stepId: fromStep.stepId, reason: 'submission_quarantined' });
      else await emitStepEvent(tenantId, orgId, funnel, 'funnel.step_completed', { stepId: fromStep.stepId, kind: fromStep.kind, ix: fromIx, ...(fromServed?.experiment ? { experiment: fromServed.experiment } : {}) }, vk, utm, outcome);
      if ('complete' in resolved) {
        // VP-R2-3 — the operator-authored next step rides the complete payload
        // (already validated/bounded at write time).
        res.json({ funnel: { slug: funnel.slug, name: funnel.name }, stepCount: funnel.steps.length, complete: true, ...(funnel.completionCta ? { completionCta: funnel.completionCta } : {}) });
        return;
      }
      const step = await publicFunnelStep(tenantId, orgId, funnel, resolved.ix, vk);
      if (!step) throw new OpenwopError('not_found', 'Funnel not found.', 404, {});
      await emitStepEvent(tenantId, orgId, funnel, 'funnel.step_viewed', step, vk, utm);
      res.json({ funnel: { slug: funnel.slug, name: funnel.name }, stepCount: funnel.steps.length, step });
    } catch (err) { next(err); }
  });
}
