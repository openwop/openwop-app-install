/**
 * Reviewable-learning proposals routes (RFC 0096) — host-sample seam under
 * `/v1/host/openwop-app/proposals`, per `host-sample-test-seams.md §11`.
 *
 * CORRECTED (ADR 0736): this header used to say "a production host 404s these
 * unless an env-gate enables them". It does not. `feature.ts:6-9` is the accurate
 * account and says the opposite — the seam is served UNCONDITIONALLY (always-on
 * substrate); `OPENWOP_PROPOSALS_ENABLED` gates only the CAPABILITY ADVERTISEMENT
 * in `discovery.ts:1872`. MEASURED: zero `process.env` reads in this file or in
 * `feature.ts`. So the surface is UNADVERTISED BUT REACHABLE, which is why the
 * mutation gate below exists. Tenant-scoped to the caller. The `apply`
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

/**
 * ADR 0736 — mutating a proposal needs authority. Before this, revise/reject/
 * archive read only `tenantOf(req)` and the id: any member of the tenant could
 * swap the `artifact` of a proposal someone else raised, and `artifact` is "the
 * byte image last persisted … installed verbatim at apply" (`types.ts:46`). So
 * the applied thing need not be the reviewed thing — the approve-what-you-see
 * property ADR 0473 protects with `expectedDefinitionHash`.
 *
 * D1 baseline: `workspace:write`, via the SAME resolver `assertCanApply` uses.
 * D2: when the row carries an `owner.principal` that is not the caller, refuse.
 * D3 exits, both deliberate — `host:members:manage` may act on any row (an admin
 * must be able to archive a departed member's proposal), and a row with NO
 * `owner.principal` (the demo seeder, `proposalsService.ts:256`) stays mutable by
 * any writer, because there is no owner to defer to and refusing would strand it.
 */
async function assertCanMutate(req: Request, proposal: { owner?: { principal?: string } }): Promise<void> {
  const subject = callerSubject(req);
  const tenant = tenantOf(req);
  const scopes = subject ? (await resolveSubjectScopesUnion(tenant, subject)).scopes : [];
  if (!scopes.includes('workspace:write')) {
    throw new OpenwopError('forbidden_scope', 'Changing a proposal requires the `workspace:write` scope.', 403, {
      requiredScope: 'workspace:write',
    });
  }
  const owner = proposal.owner?.principal;
  if (owner && owner !== subject && !scopes.includes('host:members:manage')) {
    throw new OpenwopError('forbidden', 'Only the proposer may change this proposal.', 403, {
      reason: 'not-proposer',
    });
  }
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
      const existing = await getProposal(tenantOf(req), paramId(req));
      if (!existing) throw new OpenwopError('not_found', 'Proposal not found.', 404);
      await assertCanMutate(req, existing);
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
      const existing = await getProposal(tenantOf(req), paramId(req));
      if (!existing) throw new OpenwopError('not_found', 'Proposal not found.', 404);
      await assertCanMutate(req, existing);
      const p = await rejectProposal(tenantOf(req), paramId(req));
      if (!p) throw new OpenwopError('not_found', 'Proposal not found.', 404);
      res.json(p);
    }),
  );

  // Archive (soft delete).
  app.delete(
    '/v1/host/openwop-app/proposals/:id',
    wrap(async (req, res) => {
      const existing = await getProposal(tenantOf(req), paramId(req));
      if (!existing) throw new OpenwopError('not_found', 'Proposal not found.', 404);
      await assertCanMutate(req, existing);
      const p = await archiveProposal(tenantOf(req), paramId(req));
      if (!p) throw new OpenwopError('not_found', 'Proposal not found.', 404);
      res.json(p);
    }),
  );
}
