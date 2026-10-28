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
 *
 * ADR 0938 — reads need `workspace:read` (one predicate, shared with the agent
 * tool), a list never writes (the demo seeder is deleted), filters are validated,
 * every write follows the transition table by CAS, and `apply` names the
 * `{revision, artifactDigest}` its caller saw. Since this host has no installer
 * for any kind, apply always ends `409 proposal_not_installable`, and
 * `agents.proposals` is no longer advertised (`discovery.ts`, D3).
 */

import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, personalTenantOf, tenantOf } from '../../host/requestSubject.js';
import { resolveSubjectScopesUnion } from '../../host/accessControlService.js';
import {
  listProposals,
  getProposal,
  reviseProposal,
  rejectProposal,
  archiveProposal,
  applyProposal,
  viewOf,
  artifactDigestOf,
  type ProposalView,
} from './proposalsService.js';
import { assertCanReadProposals } from './access.js';
import { PROPOSAL_KINDS, PROPOSAL_STATES, type Proposal, type ProposalKind, type ProposalState } from './types.js';
import { JcsRefusal } from '../../host/jcs.js';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function paramId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new OpenwopError('validation_error', 'Invalid proposal id.', 400, { id });
  }
  return id;
}

/** ADR 0938 D6 — the read gate, the SAME predicate the agent tool calls. */
export async function assertCanRead(req: Request): Promise<void> {
  await assertCanReadProposals(tenantOf(req), callerSubject(req), {
    personalTenant: personalTenantOf(req),
    wildcardOperator: req.principal?.tenants?.includes('*') === true,
  });
}

async function loadProposal(req: Request): Promise<Proposal> {
  const p = await getProposal(tenantOf(req), paramId(req));
  if (!p) throw new OpenwopError('not_found', 'Proposal not found.', 404);
  return p;
}

/** ADR 0938 D6 — a filter outside its enum is a 400, never an empty 200. */
export function enumQuery<T extends string>(req: Request, field: string, allowed: readonly T[]): T | undefined {
  const raw = req.query[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw new OpenwopError('validation_error', `\`${field}\` must be one of: ${allowed.join(', ')}.`, 400, { field });
  }
  return raw as T;
}

/** ADR 0938 D5 — an optional `revision` on revise/reject/archive, checked when present. */
function optionalRevision(body: unknown): number | undefined {
  const r = (body as { revision?: unknown } | undefined)?.revision;
  if (r === undefined) return undefined;
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 0) {
    throw new OpenwopError('validation_error', '`revision` must be a non-negative integer.', 400, { field: 'revision' });
  }
  return r;
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
 * `owner.principal` stays mutable by any writer, because there is no owner to
 * defer to and refusing would strand it.
 */
export async function assertCanMutate(req: Request, proposal: { owner?: { principal?: string } }): Promise<void> {
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

  app.get(
    '/host/openwop-app/proposals',
    wrap(async (req, res) => {
      await assertCanRead(req);
      const state = enumQuery<ProposalState>(req, 'state', PROPOSAL_STATES);
      const kind = enumQuery<ProposalKind>(req, 'kind', PROPOSAL_KINDS);
      const proposals: ProposalView[] = (await listProposals(tenantOf(req), { state, kind })).map(viewOf);
      res.json({ proposals });
    }),
  );

  app.get(
    '/host/openwop-app/proposals/:id',
    wrap(async (req, res) => {
      await assertCanRead(req);
      res.json(viewOf(await loadProposal(req)));
    }),
  );

  // Revise — MUST NOT activate.
  app.patch(
    '/host/openwop-app/proposals/:id',
    wrap(async (req, res) => {
      await assertCanRead(req); // PROP2CD-3 — a non-reader learns nothing, not even existence
      const body = (req.body ?? {}) as { title?: unknown; rationale?: unknown; artifact?: unknown };
      const patch: { title?: string; rationale?: string; artifact?: Record<string, unknown> } = {};
      for (const field of ['title', 'rationale'] as const) {
        const v = body[field];
        if (v === undefined) continue;
        if (typeof v !== 'string') throw new OpenwopError('validation_error', `\`${field}\` must be a string.`, 400, { field });
        patch[field] = v;
      }
      if (body.artifact !== undefined) {
        if (!body.artifact || typeof body.artifact !== 'object' || Array.isArray(body.artifact) || Object.keys(body.artifact).length === 0) {
          throw new OpenwopError('validation_error', '`artifact` must be a non-empty object.', 400, { field: 'artifact' });
        }
        patch.artifact = body.artifact as Record<string, unknown>;
        try {
          artifactDigestOf(patch.artifact); // the digest a reviewer will bind to must exist
        } catch (err) {
          if (err instanceof JcsRefusal) throw new OpenwopError('validation_error', '`artifact` is not valid JSON data.', 400, { field: 'artifact' });
          throw err;
        }
      }
      const revision = optionalRevision(req.body);
      const existing = await loadProposal(req);
      await assertCanMutate(req, existing);
      res.json(viewOf(await reviseProposal(existing, patch, revision)));
    }),
  );

  // Apply — scope-gated (403), bound to what the caller saw, installer-only (ADR 0938).
  app.post(
    '/host/openwop-app/proposals/:id/apply',
    wrap(async (req, res) => {
      await assertCanRead(req);
      await assertCanApply(req);
      const existing = await loadProposal(req);
      const body = (req.body ?? {}) as { revision?: unknown; artifactDigest?: unknown };
      if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || typeof body.artifactDigest !== 'string') {
        throw new OpenwopError('validation_error', 'Applying needs the `revision` and `artifactDigest` you reviewed (from GET).', 400, {
          fields: ['revision', 'artifactDigest'],
        });
      }
      const result = await applyProposal(existing, { revision: body.revision, artifactDigest: body.artifactDigest });
      res.json({ installedArtifactRef: result.installedArtifactRef, proposal: viewOf(result.proposal) });
    }),
  );

  app.post(
    '/host/openwop-app/proposals/:id/reject',
    wrap(async (req, res) => {
      await assertCanRead(req);
      const revision = optionalRevision(req.body);
      const existing = await loadProposal(req);
      await assertCanMutate(req, existing);
      res.json(viewOf(await rejectProposal(existing, revision)));
    }),
  );

  // Archive (soft delete).
  app.delete(
    '/host/openwop-app/proposals/:id',
    wrap(async (req, res) => {
      await assertCanRead(req);
      const revision = optionalRevision(req.body);
      const existing = await loadProposal(req);
      await assertCanMutate(req, existing);
      res.json(viewOf(await archiveProposal(existing, revision)));
    }),
  );
}
