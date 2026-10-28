/**
 * RFC 0249 — the seven normative v2 proposal operations (ADR 0972 D1). They call
 * the same `proposalsService` as the host-extension routes in `routes.ts`, which
 * stay as they are.
 *
 * Gate order on every operation, as on the prompts routes (ADR 0755):
 *   1. the key-lane scope (`proposals:read|write|apply`): an `owk_` key that
 *      declared scopes and not this one gets 403 `insufficient_scope`;
 *   2. the advertisement: with `agents.proposals` absent, 404 `not_found`
 *      (`errors.md` §Unadvertised operations); `submitProposal` also needs
 *      `clientDrafts`;
 *   3. membership authority, read from the credential's provenance (ADR 0972 D2).
 *
 * A proposal owned by another tenant is loaded by `(tenant, id)` and so answers
 * exactly like an unknown id (ADR 0972 D3).
 */

import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { resolveSubjectScopesUnion } from '../../host/accessControlService.js';
import { credentialScopesIn, requireKeyLaneScope } from '../../host/protocolAuthorization.js';
import { unadvertisedError } from '../../host/unadvertised.js';
import { JcsRefusal } from '../../host/jcs.js';
import {
  listProposals,
  getProposal,
  submitProposal,
  reviseProposal,
  rejectProposal,
  archiveProposal,
  applyProposal,
  artifactDigestOf,
} from './proposalsService.js';
import { assertCanRead, assertCanMutate, enumQuery } from './routes.js';
import { proposalsFacet } from './capability.js';
import { rfc0249WireAvailable } from '../../host/rfc0249Wire.js';
import { PROPOSAL_KINDS, PROPOSAL_STATES, type Proposal, type ProposalKind, type ProposalState } from './types.js';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

type Need = 'read' | 'write' | 'apply';
const ROLE_SCOPE = { read: 'workspace:read', write: 'workspace:write', apply: 'packs:publish' } as const;

/** ADR 0972 D8 — the closed v2 `Proposal`: the stored row plus `artifactDigest`,
 *  without the host's `revision` counter. */
function v2View(p: Proposal): Record<string, unknown> {
  const { revision: _revision, ...wire } = p;
  return { ...wire, artifactDigest: artifactDigestOf(p.artifact) };
}

/** The service's ADR 0938 409s carry `conflict` + `details.reason`; at v2 the reason IS the code. */
function toV2Error(err: unknown): unknown {
  if (!(err instanceof OpenwopError) || err.code !== 'conflict') return err;
  const { reason, ...details } = (err.details ?? {}) as Record<string, unknown>;
  if (reason !== 'proposal_state_conflict' && reason !== 'proposal_stale') return err;
  return new OpenwopError(reason, err.message, err.httpStatus, details);
}

function isKeyCredential(req: Request): boolean {
  const kind = req.principal?.auth?.kind;
  return kind === 'env-key' || kind === 'api-key';
}

function forbidden(scope: string): OpenwopError {
  return new OpenwopError('forbidden_scope', `This needs the \`${scope}\` scope in this workspace.`, 403, { requiredScope: scope });
}

/** Step 3: membership authority. A key acts as its provenance says (an env key is
 *  the tenant owner, an `owk_` key its issuer narrowed to what it declared); a
 *  browser session keeps the ADR 0938 predicates. */
async function authorize(req: Request, need: Need, proposal?: Proposal): Promise<void> {
  const role = ROLE_SCOPE[need];
  if (isKeyCredential(req)) {
    const scopes = await credentialScopesIn(req.principal!, tenantOf(req), callerSubject(req));
    if (!scopes.includes(role)) throw forbidden(role);
    const owner = proposal?.owner.principal;
    if (need === 'write' && owner && owner !== callerSubject(req) && !scopes.includes('host:members:manage')) {
      throw new OpenwopError('forbidden', 'Only the proposer may change this proposal.', 403, { reason: 'not-proposer' });
    }
    return;
  }
  if (need === 'read') return assertCanRead(req);
  if (need === 'write') {
    await assertCanRead(req);
    return assertCanMutate(req, proposal ?? {});
  }
  await assertCanRead(req);
  const subject = callerSubject(req);
  const scopes = subject ? (await resolveSubjectScopesUnion(tenantOf(req), subject)).scopes : [];
  if (!scopes.includes(role)) throw forbidden(role);
}

/** Steps 1 and 2. Before the RFC 0249 wire is available, every operation is
 *  unadvertised FIRST, so no route refuses a caller for a scope `scopes_supported`
 *  does not list yet (ADR 0972 D9). */
function gate(req: Request, need: Need, facetMember?: 'clientDrafts'): void {
  if (!rfc0249WireAvailable()) throw unadvertisedError(req, { family: 'agents', facet: 'proposals', message: 'capabilities.agents.proposals is not advertised' });
  // Literal per scope: `test/adr0745-scopes.test.ts` derives scopes_supported from call sites.
  if (need === 'read') requireKeyLaneScope(req, 'proposals:read');
  else if (need === 'write') requireKeyLaneScope(req, 'proposals:write');
  else requireKeyLaneScope(req, 'proposals:apply');
  const facet = proposalsFacet();
  if (!facet) throw unadvertisedError(req, { family: 'agents', facet: 'proposals', message: 'capabilities.agents.proposals is not advertised' });
  if (facetMember && facet[facetMember] !== true) {
    throw unadvertisedError(req, { family: 'agents', facet: `proposals.${facetMember}`, message: `capabilities.agents.proposals.${facetMember} is not advertised` });
  }
}

function checkId(raw: unknown): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) {
    throw new OpenwopError('validation_error', 'Invalid proposal id.', 400, { field: 'proposalId' });
  }
  return raw;
}

async function load(req: Request, id: string): Promise<Proposal> {
  const p = await getProposal(tenantOf(req), id);
  if (!p) throw new OpenwopError('not_found', 'Proposal not found.', 404);
  return p;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new OpenwopError('validation_error', `\`${field}\` must be a string.`, 400, { field });
  return v;
}

/** A non-empty JSON object JCS can canonicalize, so the digest a reviewer binds to exists. */
function artifactField(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new OpenwopError('validation_error', '`artifact` must be a non-empty object.', 400, { field: 'artifact' });
  }
  const artifact = value as Record<string, unknown>;
  try {
    artifactDigestOf(artifact);
  } catch (err) {
    if (err instanceof JcsRefusal) throw new OpenwopError('validation_error', '`artifact` is not valid JSON data.', 400, { field: 'artifact' });
    throw err;
  }
  return artifact;
}

function bodyOf(req: Request): Record<string, unknown> {
  const b: unknown = req.body ?? {};
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    throw new OpenwopError('validation_error', 'The request body must be a JSON object.', 400);
  }
  return b as Record<string, unknown>;
}

export function registerProposalsV2Routes(deps: RouteDeps): void {
  const { app } = deps;
  const wrap = (h: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await h(req, res);
      } catch (err) {
        next(toV2Error(err));
      }
    };

  // listProposals
  app.get('/proposals', wrap(async (req, res) => {
    gate(req, 'read');
    await authorize(req, 'read');
    const state = enumQuery<ProposalState>(req, 'state', PROPOSAL_STATES);
    const kind = enumQuery<ProposalKind>(req, 'kind', PROPOSAL_KINDS);
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? LIST_LIMIT_DEFAULT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new OpenwopError('validation_error', '`limit` must be a positive integer.', 400, { field: 'limit' });
    }
    const rawCursor = req.query.cursor;
    const offset = rawCursor === undefined ? 0 : Number(rawCursor);
    if (typeof rawCursor !== 'undefined' && (typeof rawCursor !== 'string' || !/^\d+$/.test(rawCursor))) {
      throw new OpenwopError('validation_error', '`cursor` is not a cursor this host issued.', 400, { field: 'cursor' });
    }
    const all = await listProposals(tenantOf(req), { state, kind });
    const take = Math.min(limit, LIST_LIMIT_MAX);
    const items = all.slice(offset, offset + take).map(v2View);
    const next = offset + take < all.length ? String(offset + take) : undefined;
    res.json({ items, ...(next !== undefined ? { nextCursor: next } : {}) });
  }));

  // submitProposal (RFC 0249 §B)
  app.post('/proposals', wrap(async (req, res) => {
    gate(req, 'write', 'clientDrafts');
    await authorize(req, 'write');
    const body = bodyOf(req);
    const kinds = proposalsFacet()?.artifactKinds ?? [];
    if (typeof body.kind !== 'string' || !(kinds as string[]).includes(body.kind)) {
      throw new OpenwopError('validation_error', `\`kind\` must be one of: ${kinds.join(', ')}.`, 400, { field: 'kind' });
    }
    const artifact = artifactField(body.artifact);
    const title = optionalString(body, 'title');
    const rationale = optionalString(body, 'rationale');
    const p = await submitProposal(
      tenantOf(req),
      { kind: body.kind as ProposalKind, artifact, ...(title !== undefined ? { title } : {}), ...(rationale !== undefined ? { rationale } : {}) },
      callerSubject(req),
    );
    res.status(201).json(v2View(p));
  }));

  // applyProposal (RFC 0249 §C). Registered before `/proposals/:id`, and as a
  // pattern because Express reads `:apply` as a second parameter (see `:fork`).
  app.post(/^\/proposals\/([^/]+):apply$/, wrap(async (req, res) => {
    gate(req, 'apply');
    const id = checkId(req.params[0]);
    await authorize(req, 'apply');
    const body = bodyOf(req);
    if (typeof body.artifactDigest !== 'string') {
      throw new OpenwopError('validation_error', 'Applying needs the `artifactDigest` you reviewed (from getProposal).', 400, { field: 'artifactDigest' });
    }
    const existing = await load(req, id);
    const { proposal } = await applyProposal(existing, { artifactDigest: body.artifactDigest });
    res.json(v2View(proposal));
  }));

  // rejectProposal
  app.post(/^\/proposals\/([^/]+):reject$/, wrap(async (req, res) => {
    gate(req, 'write');
    const id = checkId(req.params[0]);
    const body = bodyOf(req);
    optionalString(body, 'reason'); // validated, not stored: the closed Proposal has no seat for it
    const existing = await load(req, id);
    await authorize(req, 'write', existing);
    res.json(v2View(await rejectProposal(existing)));
  }));

  // getProposal
  app.get('/proposals/:proposalId', wrap(async (req, res) => {
    gate(req, 'read');
    const id = checkId(req.params.proposalId);
    await authorize(req, 'read');
    res.json(v2View(await load(req, id)));
  }));

  // reviseProposal — MUST NOT activate.
  app.patch('/proposals/:proposalId', wrap(async (req, res) => {
    gate(req, 'write');
    const id = checkId(req.params.proposalId);
    const body = bodyOf(req);
    const patch: { title?: string; rationale?: string; artifact?: Record<string, unknown> } = {};
    const title = optionalString(body, 'title');
    const rationale = optionalString(body, 'rationale');
    if (title !== undefined) patch.title = title;
    if (rationale !== undefined) patch.rationale = rationale;
    if (body.artifact !== undefined) patch.artifact = artifactField(body.artifact);
    const existing = await load(req, id);
    await authorize(req, 'write', existing);
    res.json(v2View(await reviseProposal(existing, patch)));
  }));

  // archiveProposal — soft.
  app.delete('/proposals/:proposalId', wrap(async (req, res) => {
    gate(req, 'write');
    const id = checkId(req.params.proposalId);
    const existing = await load(req, id);
    await authorize(req, 'write', existing);
    res.json(v2View(await archiveProposal(existing)));
  }));
}
