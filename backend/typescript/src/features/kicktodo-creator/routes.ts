/**
 * kicktodo-creator REST (ADR 0415 P1) — under the ONE KickTodo prefix
 * (`/v1/host/openwop-app/kicktodo/creator/*`); the route table joins the
 * collision-test union. Toggle-gated (`kicktodo-creator`, OFF by default;
 * editor/publisher authorization stays fail-closed even when ON for the
 * operator tenant — PRD §9.2).
 */

import type { Request, Response, NextFunction, Express } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { requireKicktodoManage, hasKicktodoManageAuthority } from '../featureRoute.js';
import {
  createCandidate,
  getCandidate,
  listCandidates,
  recordResearch,
  deriveAndBindCandidateDraft,
  DraftAlreadyPublishedError,
  ProhibitedTopicError,
  StubSourceError,
  UnparsableSourceUrlError,
  type FactoryCandidate,
  type ResearchClaim,
  type ResearchSource,
} from './creatorService.js';
import { validatePlan, PlanInvalidError } from './planService.js';
import {
  CHALLENGE_OUTLINE_CANVAS_TYPE,
  CHALLENGE_OUTLINE_BASE_PATH,
  CHALLENGE_OUTLINE_COLLAB_SHAPE,
  CHALLENGE_OUTLINE_COMPONENTS,
  outlineCanvasId,
  planToOutlineDoc,
  outlineDocToPlan,
  validateOutlineDoc,
  type OutlineDoc,
} from './outlineDoc.js';
import { registerApprovalEligibility, registerChallengePublishApprovalHandler } from '../../host/approvalService.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { registerCanvasComponents } from '../../host/canvasComponentCatalog.js';
import { ensureCanvasForTenant, getCanvasForTenant } from '../../host/canvasSurface.js';
import {
  completePublication,
  decideChallengePublishApproval,
  getPublication,
  submitForPublication,
  publicationView,
  PublicationGateError,
  SeparationOfDutiesError,
} from './publishService.js';
import { checkSources, getMonitorReport, killSwitch, KillSwitchError } from './monitorService.js';
import { gateStatus, simulationVerdicts, lessonStatus, creatorNeedsYou } from './creatorReads.js';
import { ensureChallengeAuthor, CHALLENGE_AUTHOR_AGENT_ID } from './challengeAuthorService.js';
import { guardedEgressFetch } from '../../host/webhookEgressGuard.js';
import { isForeignOwned } from '../../routes/workflows.js';

export const KICKTODO_CREATOR_PREFIX = '/v1/host/openwop-app/kicktodo/creator';

/** Portfolio-read fan-out cap: the roster `workflows[]` array is tenant-
 *  editable with no length bound, so the /author read must not turn its size
 *  into an unbounded parallel catalog fan-out. 25 is far above any real
 *  portfolio (the Challenge Author ships with 1). */
const AUTHOR_PORTFOLIO_CAP = 25;

type Handler = (req: Request, res: Response) => Promise<void>;

function subjectOf(req: Request): string {
  const s = callerSubject(req);
  if (!s) throw new OpenwopError('unauthenticated', 'An identified caller is required.', 401);
  return s;
}

async function gate(req: Request): Promise<void> {
  // ADR 0434 (KTFULL-B2) — the Factory has NO participant surface: every route
  // here creates, researches, publishes, monitors or kills challenge content.
  // The gate is therefore privileged in ONE place, so a future route cannot be
  // added without it.
  await requireKicktodoManage(req, 'kicktodo-creator', 'KickTodo Creator');
  // ADR 0458 §2.1 — provision the named Challenge Author on the first
  // manage-authority touch (idempotent get-or-create; mirrors KickBot's
  // ensure-on-GET). Best-effort: authoring never blocks on agent provisioning.
  ensureChallengeAuthor(tenantOf(req)).catch(() => { /* best-effort */ });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export const KICKTODO_CREATOR_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string; handler: Handler }> = [
  {
    method: 'post',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!str(b.topic).trim()) throw new OpenwopError('validation_error', 'Field `topic` is required.', 400);
      try {
        const c = await createCandidate({
          tenantId: tenantOf(req),
          createdBy: subjectOf(req),
          topic: str(b.topic),
          audience: str(b.audience),
          transformation: str(b.transformation),
          durationDaysTarget: typeof b.durationDaysTarget === 'number' ? b.durationDaysTarget : 14,
          dailyMinutesTarget: typeof b.dailyMinutesTarget === 'number' ? b.dailyMinutesTarget : 15,
        });
        res.json(c);
      } catch (err) {
        if (err instanceof ProhibitedTopicError) {
          throw new OpenwopError('validation_error', err.message, 422, { signals: err.signals });
        }
        throw err;
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      res.json({ candidates: await listCandidates(tenantOf(req)) });
    },
  },
  {
    // SCREEN_POLISH Studio residue (ADR 0437 §4.2) — the PRECISE "Needs you"
    // queue: returned-with-feedback / enforced-gates-open / broken-sources,
    // each composed from the owner the workspace reads already trust.
    method: 'get',
    path: `${KICKTODO_CREATOR_PREFIX}/needs-you`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      res.json({ rows: await creatorNeedsYou(tenantOf(req)) });
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const c = await getCandidate(tenantOf(req), req.params.id);
      if (!c) throw new OpenwopError('not_found', 'Candidate not found.', 404);
      res.json(c);
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/research`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const b = (req.body ?? {}) as { questions?: unknown; sources?: unknown; claims?: unknown };
      const questions = Array.isArray(b.questions) ? b.questions.filter((q): q is string => typeof q === 'string') : [];
      const sources = (Array.isArray(b.sources) ? b.sources : []) as ResearchSource[];
      const claims = (Array.isArray(b.claims) ? b.claims : []) as ResearchClaim[];
      // ARCH-M3 — `hash` and `domain` are DERIVED server-side (KTFULL-B7) and
      // the caller's values are discarded, so requiring `hash` refused a
      // correct client that had stopped sending a field with no meaning.
      // `title` IS now required: it feeds the citation hash, and an absent one
      // silently hashed the literal string "undefined".
      if (sources.some((s) => typeof s.url !== 'string' || typeof s.title !== 'string' || typeof s.engine !== 'string')) {
        throw new OpenwopError('validation_error', 'Each source needs `url`, `title`, `engine`.', 400);
      }
      try {
        const c = await recordResearch(tenantOf(req), req.params.id, { questions, sources, claims });
        if (!c) throw new OpenwopError('not_found', 'Candidate not found.', 404);
        res.json(c);
      } catch (err) {
        if (err instanceof StubSourceError) throw new OpenwopError('conflict', err.message, 409, { engines: err.engines });
        // ARCH-2 — a source URL the host cannot parse is caller input, not a
        // server fault. Unmapped it became a 500, which told the caller
        // nothing about which of their sources was rejected.
        if (err instanceof UnparsableSourceUrlError) {
          throw new OpenwopError('validation_error', err.message, 422, { url: err.url });
        }
        throw err;
      }
    },
  },
  {
    // ADR 0415 D3 — submit for publication: hard gates -> ONE approval on the
    // shared queue. Idempotent.
    method: 'post',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/submit-publication`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.challengeId !== 'string' || typeof b.challengeVersion !== 'number') {
        throw new OpenwopError('validation_error', 'Fields `challengeId` and `challengeVersion` are required.', 400);
      }
      try {
        res.json(publicationView(await submitForPublication(tenantOf(req), req.params.id, b.challengeId, b.challengeVersion, subjectOf(req))));
      } catch (err) {
        if (err instanceof PublicationGateError) throw new OpenwopError('conflict', err.message, 409, { gate: err.gate });
        throw err;
      }
    },
  },
  {
    // ADR 0415 D3 — complete publication: a DIFFERENT identity approves
    // (separation of duties) and the challenge publishes atomically.
    method: 'post',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/complete-publication`,
    handler: async (req, res) => {
      await gate(req);
      try {
        res.json(publicationView(await completePublication(tenantOf(req), req.params.id, subjectOf(req))));
      } catch (err) {
        if (err instanceof SeparationOfDutiesError) throw new OpenwopError('forbidden', err.message, 403);
        if (err instanceof PublicationGateError) throw new OpenwopError('conflict', err.message, 409, { gate: err.gate });
        throw err;
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/publication`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const p = await getPublication(tenantOf(req), req.params.id);
      if (!p) throw new OpenwopError('not_found', 'Nothing submitted for publication.', 404);
      res.json(publicationView(p));
    },
  },
  {
    // ADR 0460 §3 read 1 — the honest 5-gate matrix (display-only; re-derived
    // from the SAME predicates assertGates enforces, so it can never paint a
    // status the write path doesn't back).
    method: 'get',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/gates`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const rows = await gateStatus(tenantOf(req), req.params.id);
      if (!rows) throw new OpenwopError('not_found', 'Candidate not found.', 404);
      res.json({ gates: rows });
    },
  },
  {
    // ADR 0460 §3 read 2 — the durable three-persona simulation record, verbatim.
    method: 'get',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/simulation`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const sim = await simulationVerdicts(tenantOf(req), req.params.id);
      if (!sim) throw new OpenwopError('not_found', 'Candidate not simulated.', 404);
      res.json(sim);
    },
  },
  {
    // ADR 0460 §3 read 3 — per-day durable build signals (planned + hasMedia;
    // deliberately NO `enriched` — the rich lesson body is ephemeral node output).
    method: 'get',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/lessons`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const lessons = await lessonStatus(tenantOf(req), req.params.id);
      if (!lessons) throw new OpenwopError('not_found', 'Candidate not found.', 404);
      res.json({ lessons });
    },
  },
  {
    // ADR 0415 P4 — source-health monitoring (server-side fetch through the
    // global fetch; production egress rides the guarded seam).
    method: 'post',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/monitor`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      // D-1 (grade-gate fix): dossier URLs are caller-recorded data — the
      // health probe MUST ride the SSRF-guarded egress seam (ADR 0405), never
      // a raw fetch (private-address/rebind/redirect protection included).
      const report = await checkSources(tenantOf(req), req.params.id, async (url) => {
        const r = await guardedEgressFetch(url, { method: 'HEAD' });
        return { status: r.status, redirected: r.redirected };
      });
      if (!report) throw new OpenwopError('not_found', 'Candidate or dossier not found.', 404);
      res.json(report);
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/monitor`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const report = await getMonitorReport(tenantOf(req), req.params.id);
      if (!report) throw new OpenwopError('not_found', 'No monitor report yet.', 404);
      res.json(report);
    },
  },
  {
    // ADR 0415 P4 — the operator kill switch: retire the published version
    // (new enrollments refused; active ones keep their pinned version) +
    // withdraw the candidate with the audited reason.
    method: 'post',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/kill`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason : '';
      if (!reason) throw new OpenwopError('validation_error', 'Field `reason` is required for the kill switch (audited).', 400);
      try {
        res.json(await killSwitch(tenantOf(req), req.params.id, reason, subjectOf(req)));
      } catch (err) {
        if (err instanceof KillSwitchError) throw new OpenwopError('not_found', err.message, 404);
        throw err;
      }
    },
  },
  // ── ADR 0458 §2.3 — the challenge-outline canvas (structured editing) ──
  {
    // Idempotent get-or-create of the candidate's ONE outline canvas at a
    // deterministic id. Seeds from the validated plan revision (the SSoT) when
    // one exists, else a skeleton from the candidate's intake targets. A second
    // call returns the SAME canvas and does NOT reseed (`ensureCanvasForTenant`
    // only writes when absent) — creation lives ONLY here (the type declares no
    // blankState). Authoring family: `gate` = requireKicktodoManage.
    method: 'post',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/outline`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const tenant = tenantOf(req);
      const candidate = await getCandidate(tenant, req.params.id);
      if (!candidate) throw new OpenwopError('not_found', 'Candidate not found.', 404);
      const canvasId = outlineCanvasId(tenant, candidate.id);
      const reused = !!(await getCanvasForTenant(tenant, canvasId));
      const seededFrom: 'plan' | 'skeleton' = candidate.plan ? 'plan' : 'skeleton';
      const initialState: OutlineDoc = candidate.plan ? planToOutlineDoc(candidate.plan.plan) : skeletonOutlineDoc(candidate);
      await ensureCanvasForTenant(tenant, canvasId, { canvasTypeId: CHALLENGE_OUTLINE_CANVAS_TYPE, initialState });
      // `reused` is honest about whether we seeded now; `seededFrom` is what a
      // fresh seed would/did use (informational — the FE only needs `canvasId`).
      res.json({ canvasId, seededFrom, reused });
    },
  },
  {
    // Apply the edited working draft back to the plan revision (SSoT) + re-derive
    // the challenge draft — the draft→validate→persist workflow-author law. The
    // canvas is read version-checked; `outlineDocToPlan` → `validatePlan` (422
    // with defects, NO revision bump, draft untouched — the ONE bounded repair
    // loop lives with the model/human, who gets the defects back verbatim). On
    // pass, the SHARED derive path stamps the revision + re-derives the draft
    // (published-immutability preserved — an already-published draft id is a
    // typed 409). Authoring family: `gate` = requireKicktodoManage.
    method: 'post',
    path: `${KICKTODO_CREATOR_PREFIX}/candidates/:id/outline/apply`,
    handler: async (req, res) => {
      await gate(req);
      const author = subjectOf(req);
      const tenant = tenantOf(req);
      const candidate = await getCandidate(tenant, req.params.id);
      if (!candidate) throw new OpenwopError('not_found', 'Candidate not found.', 404);
      const canvasId = outlineCanvasId(tenant, candidate.id);
      const canvas = await getCanvasForTenant(tenant, canvasId);
      if (!canvas || canvas.canvasTypeId !== CHALLENGE_OUTLINE_CANVAS_TYPE) {
        throw new OpenwopError('not_found', 'No outline canvas for this candidate — open it first.', 404);
      }
      const b = (req.body ?? {}) as { expectedCanvasVersion?: unknown };
      if (typeof b.expectedCanvasVersion === 'number' && b.expectedCanvasVersion !== canvas.version) {
        throw new OpenwopError('canvas_version_conflict', `outline canvas version conflict: expected ${b.expectedCanvasVersion}, have ${canvas.version}`, 409, { currentVersion: canvas.version });
      }
      const plan = outlineDocToPlan(canvas.state);
      const defects = validatePlan(plan);
      if (defects.length) throw new OpenwopError('validation_error', 'The outline does not yet satisfy the plan rules.', 422, { defects });
      try {
        const { challenge, candidate: bound } = await deriveAndBindCandidateDraft(tenant, author, candidate.id, plan);
        res.json({ revision: bound?.plan?.revision ?? null, challengeId: challenge.id, challengeVersion: challenge.version });
      } catch (err) {
        if (err instanceof DraftAlreadyPublishedError) throw new OpenwopError('conflict', err.message, 409, { challengeId: err.challengeId, challengeVersion: err.challengeVersion });
        if (err instanceof PlanInvalidError) throw new OpenwopError('validation_error', 'The outline does not yet satisfy the plan rules.', 422, { defects: err.defects });
        throw err;
      }
    },
  },
];

/** A minimal, structurally-valid working draft from the candidate's intake
 *  targets when no validated plan exists yet — title/audience/duration seeded,
 *  the days tree empty. It saves fine (structure-only validation) but `apply`
 *  fails `validatePlan` until the creator fills it in. */
function skeletonOutlineDoc(candidate: FactoryCandidate): OutlineDoc {
  return {
    meta: {
      title: candidate.topic,
      promise: candidate.transformation,
      audience: candidate.audience,
      durationDays: candidate.durationDaysTarget,
      dailyMinutesBudget: candidate.dailyMinutesTarget,
    },
    outcomes: [],
    achievements: [],
    frames: [{ id: 'outline', name: candidate.topic, days: [] }],
  };
}

export function registerKicktodoCreatorRoutes(deps: RouteDeps): void {
  // KTFULL-B2 (approvals-side half) — the OWNER states who may decide a
  // `challenge-publish` approval on the GENERIC decision lane (approvals routes,
  // review cards, decide-by-email): the decider must hold the SAME
  // `host:kicktodo:manage` authority every Factory route gates on, and must not
  // be the submitter (separation of duties — mirrors completePublication's
  // check, which stays authoritative for the publication act itself).
  // ADR 0458 §2.2 (correction, 2026-09-15) — the decision HANDLER: approve from
  // the inbox / decide-by-email / approvals routes runs the ONE publication act
  // (`completePublication`), reject resolves. Registered regardless of toggle
  // state (the act itself re-checks manage authority via eligibility above and
  // separation of duties inside completePublication).
  registerChallengePublishApprovalHandler(decideChallengePublishApproval);
  registerApprovalEligibility('challenge-publish', async (tenantId, decidedBy, approval) => {
    if (!decidedBy || !(await hasKicktodoManageAuthority(tenantId, decidedBy))) {
      throw new OpenwopError('forbidden_scope', 'Deciding a challenge publication requires KickTodo manage authority.', 403, { requiredScope: 'host:kicktodo:manage' });
    }
    const submitter = approval.challengePublish?.submittedBy;
    if (submitter && decidedBy === submitter) {
      throw new OpenwopError('forbidden', 'A challenge publication must be decided by someone other than the submitter (separation of duties).', 403, {});
    }
  });
  const app: Express = deps.app;
  const wrap = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      next(err);
    }
  };
  for (const r of KICKTODO_CREATOR_ROUTES) {
    app[r.method](r.path, wrap(r.handler));
  }
  // ADR 0461 P1 — the Challenge Author profile read backing the Studio's
  // embedded-chat welcome screen. Lives OUTSIDE the static table because it
  // needs `deps` (the workflow catalog) in closure. It AWAITS the idempotent
  // provisioning saga (unlike gate()'s best-effort fire-and-forget) so a fresh
  // creator tenant gets its roster row — and therefore an honest portfolio —
  // on first Studio load, not on first factory run. `available` is verified
  // against the live catalog (builtins resolve there); the welcome must never
  // list a workflow this host cannot actually run.
  app.get(`${KICKTODO_CREATOR_PREFIX}/author`, wrap(async (req, res) => {
    await requireKicktodoManage(req, 'kicktodo-creator', 'KickTodo Creator');
    const author = await ensureChallengeAuthor(tenantOf(req));
    // Grade-pass hardening (2026-07-21 session batch): the roster row's
    // `workflows[]` is tenant-editable and unbounded — cap the per-GET catalog
    // fan-out; and a foreign-owned id must not become an existence/nodeCount
    // oracle — the SAME M7 predicate the by-id read 404s with (ADR 0440 P4)
    // reports it unavailable here, indistinguishable from a missing workflow.
    const portfolio = author.workflows.slice(0, AUTHOR_PORTFOLIO_CAP);
    const workflows = await Promise.all(portfolio.map(async (workflowId) => {
      if (await isForeignOwned(tenantOf(req), req.principal, workflowId)) {
        return { workflowId, available: false, nodeCount: 0 };
      }
      const wf = await deps.hostSuite.workflowCatalog.getWorkflow(workflowId).catch(() => null);
      return {
        workflowId,
        available: Boolean(wf),
        nodeCount: wf ? wf.definition.nodes.length : 0,
      };
    }));
    res.json({
      agentId: CHALLENGE_AUTHOR_AGENT_ID,
      rosterId: author.rosterId,
      label: author.label ?? author.persona,
      // ADR 0461 OQ1 (resolved) — the trust cue: the agent's autonomy level is
      // the tenant's own roster/profile truth, safe at creator altitude. The
      // welcome maps KNOWN levels to localized copy and omits unknown values.
      ...(author.autonomyLevel !== undefined ? { autonomyLevel: author.autonomyLevel } : {}),
      workflows,
    });
  }));
  // ADR 0458 §2.3 — the challenge-outline canvas type: chassis CRUD/collab
  // routes under its OWN host-ext root (org-scoped workspace read/write on the
  // `kicktodo-creator` toggle). NO blankState — creation is ONLY through the
  // authoring-family ensure route above (a candidate-bound canvas, never a bare
  // gallery blank). collab-enabled (ADR 0359); the outline validate hook is
  // structure-only (plan-law stays `validatePlan` at apply).
  // The closed component catalog the FE `/catalog` route serves (palette +
  // property panel + toolbar quick cluster) — drift-pinned against the FE
  // definition's prop/option localization keys.
  registerCanvasComponents(CHALLENGE_OUTLINE_CANVAS_TYPE, CHALLENGE_OUTLINE_COMPONENTS);
  registerCanvasEditorRoutes(deps, {
    basePath: CHALLENGE_OUTLINE_BASE_PATH,
    feature: { toggleId: 'kicktodo-creator', label: 'KickTodo Creator' },
    canvasTypeId: CHALLENGE_OUTLINE_CANVAS_TYPE,
    collab: true,
    collabShape: CHALLENGE_OUTLINE_COLLAB_SHAPE,
    validate: validateOutlineDoc,
    // ADR 0458 grade-pass B1 — every Factory surface is `host:kicktodo:manage`
    // privileged; without this the chassis' CRUD/versions/collab routes would be
    // reachable by any `workspace:write` member, unlike the ensure/apply routes
    // above. The SAME `requireKicktodoManage` the sibling routes use, so the two
    // authorization surfaces cannot drift.
    authorize: (req) => requireKicktodoManage(req, 'kicktodo-creator', 'KickTodo Creator'),
    // I3 — canvas version snapshots carry `capturedBy` (`user.userId`) in the
    // HOST-wide `canvas:version` store. This was flagged here as a platform gap
    // outside subject-erasure for ALL canvas types; it is now CLOSED at the host
    // layer (where it belongs — not something a feature reaches in): ADR 0464 P2's
    // `eraseSubjectCanvas` (`host/canvasSurface.ts`, wired via
    // `hostSubjectErasers.registerCanvasErasure()`) anonymizes `capturedBy` on the
    // subject's version snapshots + a canvas's user-kind `ownerSubject`, tenant-wide,
    // for every canvas type (test: `adr0464-host-subject-erasure.test.ts`).
    // Candidate-death deletion (I2) still removes a withdrawn candidate's snapshots
    // via the sanctioned `deleteCanvasForTenant` cascade.
  });
}
