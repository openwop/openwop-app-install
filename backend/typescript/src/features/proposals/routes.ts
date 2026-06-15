/**
 * Reviewable-learning proposals routes (RFC 0096) — host-sample seam under
 * `/v1/host/openwop-app/proposals`, per `host-sample-test-seams.md §11`.
 *
 * Conformance-only surface (Production safety §: a production host 404s these
 * unless an env-gate enables them). Tenant-scoped to the caller. The `apply`
 * action is fail-closed on the `packs:publish` scope (installing the
 * materialized artifact is a pack-publish-class mutation) — an unseeded caller
 * resolves to zero scopes and is denied 403, satisfying the
 * `proposal-reviewable-learning` behavioral leg without an env toggle.
 */

import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { resolveSubjectScopesUnion } from '../../host/accessControlService.js';
import {
  listProposals,
  getProposal,
  reviseProposal,
  rejectProposal,
  archiveProposal,
  applyProposal,
  ensureDemoProposal,
  MalformedForKindError,
} from './proposalsService.js';
import type { ProposalKind, ProposalState } from './types.js';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function paramId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new OpenwopError('validation_error', 'Invalid proposal id.', 400, { id });
  }
  return id;
}

/** Fail-closed: applying a proposal requires `packs:publish` (installs an artifact). */
async function assertCanApply(req: Request): Promise<void> {
  const subject = callerSubject(req);
  const tenant = tenantOf(req);
  const scopes = subject ? (await resolveSubjectScopesUnion(tenant, subject)).scopes : [];
  if (!scopes.includes('packs:publish')) {
    throw new OpenwopError('forbidden_scope', 'Applying a proposal requires the `packs:publish` scope.', 403, {
      requiredScope: 'packs:publish',
    });
  }
}

export function registerProposalsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const wrap = (h: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await h(req, res);
      } catch (err) {
        next(err);
      }
    };

  // List — seeds a canonical demo draft so the behavioral leg is non-vacuous.
  app.get(
    '/v1/host/openwop-app/proposals',
    wrap(async (req, res) => {
      const tenant = tenantOf(req);
      await ensureDemoProposal(tenant);
      const state = typeof req.query.state === 'string' ? (req.query.state as ProposalState) : undefined;
      const kind = typeof req.query.kind === 'string' ? (req.query.kind as ProposalKind) : undefined;
      res.json({ proposals: await listProposals(tenant, { state, kind }) });
    }),
  );

  app.get(
    '/v1/host/openwop-app/proposals/:id',
    wrap(async (req, res) => {
      const p = await getProposal(tenantOf(req), paramId(req));
      if (!p) throw new OpenwopError('not_found', 'Proposal not found.', 404);
      res.json(p);
    }),
  );

  // Revise — MUST NOT activate.
  app.patch(
    '/v1/host/openwop-app/proposals/:id',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { title?: unknown; rationale?: unknown; artifact?: unknown };
      const patch: { title?: string; rationale?: string; artifact?: Record<string, unknown> } = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.rationale === 'string') patch.rationale = body.rationale;
      if (body.artifact && typeof body.artifact === 'object') patch.artifact = body.artifact as Record<string, unknown>;
      const p = await reviseProposal(tenantOf(req), paramId(req), patch);
      if (!p) throw new OpenwopError('not_found', 'Proposal not found.', 404);
      res.json(p);
    }),
  );

  // Apply — scope-gated (403), installs the stored byte image (no re-synthesis).
  app.post(
    '/v1/host/openwop-app/proposals/:id/apply',
    wrap(async (req, res) => {
      await assertCanApply(req);
      try {
        const result = await applyProposal(tenantOf(req), paramId(req));
        if (!result) throw new OpenwopError('not_found', 'Proposal not found.', 404);
        res.json({
          installedArtifactRef: result.installedArtifactRef,
          ...(result.pendingApprovalId ? { pendingApprovalId: result.pendingApprovalId } : {}),
        });
      } catch (err) {
        if (err instanceof MalformedForKindError) {
          throw new OpenwopError('validation_error', err.message, 422, { kind: err.kind });
        }
        throw err;
      }
    }),
  );

  app.post(
    '/v1/host/openwop-app/proposals/:id/reject',
    wrap(async (req, res) => {
      const p = await rejectProposal(tenantOf(req), paramId(req));
      if (!p) throw new OpenwopError('not_found', 'Proposal not found.', 404);
      res.json(p);
    }),
  );

  // Archive (soft delete).
  app.delete(
    '/v1/host/openwop-app/proposals/:id',
    wrap(async (req, res) => {
      const p = await archiveProposal(tenantOf(req), paramId(req));
      if (!p) throw new OpenwopError('not_found', 'Proposal not found.', 404);
      res.json(p);
    }),
  );
}
