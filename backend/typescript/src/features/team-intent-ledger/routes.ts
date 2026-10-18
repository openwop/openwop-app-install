/**
 * ADR 0831 P1 — team intent ledger REST (authed, host-extension, project scope).
 *
 *   GET  /host/openwop-app/team-ledger/projects/:id                  ledger + current state, or null
 *   POST /host/openwop-app/team-ledger/projects/:id                  create (caller becomes owner)
 *   GET  /host/openwop-app/team-ledger/projects/:id/deltas           the change log
 *   GET  /host/openwop-app/team-ledger/projects/:id/versions/:v      the state at version v
 *   POST /host/openwop-app/team-ledger/projects/:id/deltas           propose { patch, why, baseVersion }
 *   POST /host/openwop-app/team-ledger/projects/:id/deltas/:deltaId/accept   { rebased? }   (owner)
 *   POST /host/openwop-app/team-ledger/projects/:id/deltas/:deltaId/reject   (owner)
 *   POST /host/openwop-app/team-ledger/projects/:id/write            owner: propose + accept in one call
 *   POST /host/openwop-app/team-ledger/projects/:id/owner            { ownerSubject } (owner)
 *
 * RBAC is the PROJECT's (ADR 0054 D5 via `resolveProjectAccess`): no read access
 * ⇒ a uniform 404 (no existence leak); proposing needs write; accepting,
 * rejecting, direct writes and ownership transfer need the ledger owner. Toggle
 * OFF ⇒ every route 404s.
 *
 * @see docs/adr/0831-team-intent-ledger.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { tenantOf } from '../featureRoute.js';
import { resolveProjectAccess, type Project } from '../projects/projectsService.js';
import { ledgerAccess } from './access.js';
import { cleanOpaqueToken } from '../../host/boundedStrings.js';
import { vendorPath } from '../../middleware/protocolVersion.js';
import { parseDecisionInput, recordDecision } from './decisions.js';
import { dismissSuggestion, listSuggestions } from './suggestions.js';
import { sendBackDrift } from './driftCheck.js';
import { checkPullRequest } from './prDrift.js';
import {
  acceptDelta, cleanWhy, createLedger, currentState, getDelta, getLedger, listDeltas, proposeDelta,
  rejectDelta, requireBaseVersion, setOwner, stateAt, validatePatch,
  getSeenVersion, markSeenVersion,
} from './ledgerStore.js';
import type { TeamLedger } from './types.js';

// Registered at the canonical, version-agnostic `/host/openwop-app/…` root (ADR 0652).
const BASE = '/team-ledger/projects/:id';
const SUMMARY_MAX = 20;
const route = (suffix = ''): string => vendorPath(`${BASE}${suffix}`);
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function requireProjectAccess(req: Request, need: 'read' | 'write'): Promise<Project> {
  const access = await ledgerAccess(tenantOf(req), req.params.id, actingUserOf(req));
  if (!access) throw new OpenwopError('not_found', 'Project not found.', 404, { id: req.params.id });
  if (need === 'write' && access.level !== 'write') {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
  }
  return access.project;
}

async function requireLedger(project: Project): Promise<TeamLedger> {
  const ledger = await getLedger(project.tenantId, project.id);
  if (!ledger) throw new OpenwopError('not_found', 'This project has no team ledger yet.', 404, { projectId: project.id });
  return ledger;
}

function requireOwner(req: Request, ledger: TeamLedger): string {
  const me = actingUserOf(req);
  if (!me || me !== ledger.ownerSubject) {
    throw new OpenwopError('forbidden', 'Only the ledger owner can do this.', 403, { owner: ledger.ownerSubject });
  }
  return me;
}

export function registerTeamLedgerRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ADR 0852 D4/D5 — a read-only summary of several projects' ledgers, for the
  // places that SHOW a ledger without being its project (a bound channel's pane,
  // a strategy initiative). Caller-scoped: a project the caller cannot read is
  // OMITTED, never 403'd, so the list is no existence oracle.
  app.get(vendorPath('/team-ledger/summaries'), async (req, res, next) => {
    try {
      const raw = typeof req.query.projectIds === 'string' ? req.query.projectIds : '';
      const ids = [...new Set(raw.split(',').map((x) => cleanOpaqueToken(x, 128)).filter((x): x is string => !!x))];
      if (ids.length > SUMMARY_MAX) {
        throw new OpenwopError('validation_error', `At most ${SUMMARY_MAX} projects per request.`, 400, { field: 'projectIds', limit: SUMMARY_MAX });
      }
      const summaries = [];
      for (const id of ids) {
        const access = await ledgerAccess(tenantOf(req), id, actingUserOf(req));
        if (!access) continue;
        const ledger = await getLedger(access.project.tenantId, access.project.id);
        if (!ledger) { summaries.push({ projectId: id, name: access.project.name, hasLedger: false }); continue; }
        const state = currentState(ledger, access.project);
        const pending = (await listDeltas(ledger.tenantId, ledger.ledgerId)).filter((d) => d.status === 'proposed').length;
        summaries.push({
          projectId: id, name: access.project.name, hasLedger: true, version: ledger.version,
          ...(state.goal ? { goal: state.goal } : {}),
          openQuestions: state.openQuestions.slice(0, 5), openQuestionCount: state.openQuestions.length,
          pending, decisionCount: state.decisionDocumentIds.length,
        });
      }
      res.json({ summaries });
    } catch (err) { next(err); }
  });

  app.get(route(), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'read');
      const ledger = await getLedger(project.tenantId, project.id);
      const me = actingUserOf(req);
      const seenVersion = ledger && me ? await getSeenVersion(project.tenantId, ledger.ledgerId, me) : null;
      res.json({ ledger, state: ledger ? currentState(ledger, project) : null, seenVersion });
    } catch (err) { next(err); }
  });

  // ADR 0831 D1 — "I have looked at version N" for the caller, server-side.
  app.post(route('/seen'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'read');
      const ledger = await getLedger(project.tenantId, project.id);
      if (!ledger) throw new OpenwopError('not_found', 'This project has no team ledger.', 404, {});
      const me = actingUserOf(req);
      if (!me) throw new OpenwopError('unauthenticated', 'Sign in to mark the ledger seen.', 401, {});
      const seenVersion = await markSeenVersion(ledger, me, (req.body ?? {}).version);
      res.json({ seenVersion });
    } catch (err) { next(err); }
  });

  app.post(route(), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const me = actingUserOf(req);
      if (!me) throw new OpenwopError('unauthenticated', 'Sign in to create a ledger.', 401, {});
      const ledger = await createLedger(project, me);
      res.status(201).json({ ledger, state: currentState(ledger, project) });
    } catch (err) { next(err); }
  });

  app.get(route('/deltas'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'read');
      const ledger = await requireLedger(project);
      res.json({ deltas: await listDeltas(project.tenantId, ledger.ledgerId) });
    } catch (err) { next(err); }
  });

  app.get(route('/versions/:v'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'read');
      const ledger = await requireLedger(project);
      const v = Number(req.params.v);
      const state = Number.isInteger(v) && v >= 1 ? await stateAt(project.tenantId, ledger.ledgerId, v) : null;
      if (!state) throw new OpenwopError('not_found', `No version ${req.params.v}.`, 404, { version: req.params.v });
      res.json({ version: v, state });
    } catch (err) { next(err); }
  });

  app.post(route('/deltas'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const ledger = await requireLedger(project);
      const body = (req.body ?? {}) as { patch?: unknown; why?: unknown; baseVersion?: unknown };
      const patch = await validatePatch(body.patch, project);
      const why = cleanWhy(body.why);
      const base = requireBaseVersion(body.baseVersion, ledger.version); // XCH-TL-1: never filled in
      const delta = await proposeDelta({ ledger, patch, why, author: { kind: 'user', id: actingUserOf(req) ?? 'unknown' }, baseVersion: base });
      res.status(201).json({ delta });
    } catch (err) { next(err); }
  });

  app.post(route('/deltas/:deltaId/accept'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const ledger = await requireLedger(project);
      const me = requireOwner(req, ledger);
      const deltaId = cleanOpaqueToken(req.params.deltaId, 128);
      const d = deltaId ? await getDelta(project.tenantId, deltaId) : null;
      if (!d || d.ledgerId !== ledger.ledgerId) throw new OpenwopError('not_found', 'Delta not found.', 404, {});
      const out = await acceptDelta(project, d.deltaId, me, { rebased: (req.body as { rebased?: unknown } | undefined)?.rebased === true });
      res.json(out);
    } catch (err) { next(err); }
  });

  app.post(route('/deltas/:deltaId/reject'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const ledger = await requireLedger(project);
      const me = requireOwner(req, ledger);
      const deltaId = cleanOpaqueToken(req.params.deltaId, 128);
      const d = deltaId ? await getDelta(project.tenantId, deltaId) : null;
      if (!d || d.ledgerId !== ledger.ledgerId) throw new OpenwopError('not_found', 'Delta not found.', 404, {});
      res.json({ delta: await rejectDelta(project.tenantId, d.deltaId, me) });
    } catch (err) { next(err); }
  });

  // ADR 0853 D2 — record a decision: a decision-record Document + a proposed
  // delta adding it; the owner may accept in the same call.
  app.post(route('/decisions'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const ledger = await requireLedger(project);
      const me = actingUserOf(req);
      if (!me) throw new OpenwopError('unauthenticated', 'Sign in to record a decision.', 401, {});
      res.status(201).json(await recordDecision(project, ledger, me, parseDecisionInput(req.body)));
    } catch (err) { next(err); }
  });

  // ADR 0853 D1 — the project's open decision suggestions; dismiss one.
  app.get(route('/suggestions'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'read');
      res.json({ suggestions: await listSuggestions(project.tenantId, project.id) });
    } catch (err) { next(err); }
  });
  app.post(route('/suggestions/:sid/dismiss'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const me = actingUserOf(req);
      if (!me) throw new OpenwopError('unauthenticated', 'Sign in to dismiss a suggestion.', 401, {});
      const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === 'string' ? (req.body as { reason: string }).reason : undefined;
      res.json({ suggestion: await dismissSuggestion(project.tenantId, project.id, req.params.sid ?? '', me, reason) });
    } catch (err) { next(err); }
  });
  // ADR 0855 D4 / P5 — check a GitHub pull request against the ledger (on demand).
  app.post(route('/drift/pull-request'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const me = actingUserOf(req);
      if (!me) throw new OpenwopError('unauthenticated', 'Sign in to check a pull request.', 401, {});
      res.json(await checkPullRequest(project, me, (req.body as { url?: unknown } | undefined)?.url));
    } catch (err) { next(err); }
  });
  // ADR 0855 D2 — send a drift finding back to the person who started the run.
  app.post(route('/suggestions/:sid/send-back'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const me = actingUserOf(req);
      if (!me) throw new OpenwopError('unauthenticated', 'Sign in to send a finding back.', 401, {});
      const note = typeof (req.body as { note?: unknown } | undefined)?.note === 'string' ? (req.body as { note: string }).note : '';
      res.json({ suggestion: await sendBackDrift(deps.storage, project.tenantId, project.id, req.params.sid ?? '', me, note) });
    } catch (err) { next(err); }
  });

  app.post(route('/write'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const ledger = await requireLedger(project);
      const me = requireOwner(req, ledger);
      const body = (req.body ?? {}) as { patch?: unknown; why?: unknown };
      const patch = await validatePatch(body.patch, project);
      const delta = await proposeDelta({ ledger, patch, why: cleanWhy(body.why), author: { kind: 'user', id: me } });
      res.json(await acceptDelta(project, delta.deltaId, me));
    } catch (err) { next(err); }
  });

  app.post(route('/owner'), async (req, res, next) => {
    try {
      const project = await requireProjectAccess(req, 'write');
      const ledger = await requireLedger(project);
      requireOwner(req, ledger);
      const to = cleanOpaqueToken((req.body as { ownerSubject?: unknown } | undefined)?.ownerSubject, 256);
      // The new owner must be able to WRITE the project, or they could never accept anything.
      if (!to || (await resolveProjectAccess(project.tenantId, project.id, to)) !== 'write') {
        throw new OpenwopError('validation_error', 'The new owner must be able to edit this project.', 400, { field: 'ownerSubject' });
      }
      res.json({ ledger: await setOwner(ledger, to) });
    } catch (err) { next(err); }
  });
}
