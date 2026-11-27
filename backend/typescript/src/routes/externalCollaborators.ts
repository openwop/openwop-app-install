/**
 * ADR 0958 P2, moved by ADR 1099 D2 — the COLLABORATOR's side of external
 * collaboration: "Shared with me", one granted resource, and invite acceptance.
 *
 * These routes belong to no one feature: a grant's kind decides which surface it
 * runs under (ADR 1099 D1), so they live in the host route table instead of in
 * campaign-ops, which keeps its agency panel and its intake routes. Behaviour is
 * unchanged for every kind registered before ADR 1099: the default surface is
 * campaign-ops' toggles plus an active client account.
 *
 * A signed-in person in THEIR OWN home tenant; every answer is derived from a
 * grant they are bound to (`checkGrantUse`), never from the session's tenant.
 */
import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { resolveCallerUser } from '../features/users/usersGuards.js';
import { tenantOf } from '../features/featureRoute.js';
import { createLink, purgeLinksForResource, resolveActiveResource } from '../features/sharing/sharingService.js';
import { getOrg, type Scope } from '../host/accessControlService.js';
import {
  anySurfaceAdmits, assertGrantAuthority, auditCollaboratorSectionRead, bindCollaborator, checkGrantUse, createCollaborator, extendGrant, getCollaborator, grantAccess, grantResourceKind,
  grantScopeOf, kindAdmits, projectForGrant, kindCollaborationOn, listCollaborationAudit, listCollaborators, listGrantableResources, listGrants, revokeGrant,
  usableGrantsForUser, type ExternalCollaborator, type GrantUse,
} from '../host/externalCollaborators.js';
import { startCollaboratorExpiryNotices } from '../host/externalCollaboratorExpiry.js';
import { runCollaboratorTurn } from '../host/collaboratorTurn.js';
import { clearTurnMemory, readTurnMemory, registerCollaboratorTurnMemory } from '../host/collaboratorTurnMemory.js';
import { registerCollabProposalGate } from '../host/collabProposals.js';
import { clientScopeOf } from '../host/grantScope.js';
import { grantViewSection, grantViewSectionsFor, readGrantViewSection } from '../host/grantViewSections.js';
import { takeShared } from '../host/sharedRateLimit.js';
import type { Storage } from '../storage/storage.js';

/** What a collaborator sees of a usable grant: the grant kind's surface switch on
 *  the GRANT's tenant (ADR 1099 D1; for campaign-ops kinds, its two toggles), then
 *  the owning feature's projection. `null` = not presentable (read as 404). */
async function present(use: GrantUse): Promise<{ title: string; clientName?: string; body: Record<string, unknown> } | null> {
  if (!(await kindCollaborationOn(use.grant.resource.kind, use.tenantId))) return null;
  // ADR 1099 P0c — projected FOR this collaborator, so a kind can show each only its own rows.
  const projected = await projectForGrant(use);
  if (!projected) return null;
  const org = await getOrg(use.orgId);
  return { title: projected.title, body: projected.body, ...(org && org.tenantId === use.tenantId ? { clientName: org.name } : {}) };
}

/** ADR 1099 P0b — the firm's side, for any grant kind. */
const MEMBER_BASE = '/host/openwop-app/orgs/:orgId/collaborators';
const INVITE_DAYS = 7;
/** The system actor that mints invites from the host routes (the sign_request precedent). */
const INVITE_ACTOR = 'system:host-collab';
const ADMIN_SCOPE: Scope = 'host:members:manage';

/** The firm's view of a collaborator. The email stays: the firm typed it. */
const memberView = (c: ExternalCollaborator): Omit<ExternalCollaborator, 'tenantId' | 'boundUserId'> & { accepted: boolean } => {
  const { tenantId: _t, boundUserId, ...rest } = c;
  return { ...rest, accepted: Boolean(boundUserId) };
};

/** The caller holds `scope` on the path org (or the tenant root), in the ACTIVE
 *  tenant: the same predicate every use re-checks the granter with. Uniform 404. */
async function firm(req: Request, scope: Scope): Promise<{ tenantId: string; orgId: string; userId: string }> {
  const user = await resolveCallerUser(req);
  const tenantId = tenantOf(req);
  const orgId = req.params.orgId;
  await assertGrantAuthority(tenantId, orgId, user.userId, scope);
  return { tenantId, orgId, userId: user.userId };
}

/** Some collaboration surface takes this org (switch and org rule), else 404. */
async function requireAnySurface(tenantId: string, orgId: string): Promise<void> {
  if (!(await anySurfaceAdmits(tenantId, orgId))) throw new OpenwopError('not_found', 'Not found.', 404, {});
}

/** ADR 1099 D10 — section reads (and lists) per grant per minute. */
const SECTION_READS_PER_GRANT_MIN = 120;

export function registerExternalCollaboratorRoutes(app: Express, storage: Storage): void {
  startCollaboratorExpiryNotices();
  registerCollabProposalGate(); // ADR 1099 D6 — a member decides each collaborator proposal
  registerCollaboratorTurnMemory(); // ADR 1099 P3d — the conversation's erase hook

  // ── The collaborator's side (ADR 0958 P2). A signed-in person in THEIR OWN home
  // tenant; every answer is derived from a grant they are bound to, so nothing here
  // reads the caller's session tenant, and nothing names the agency's ids. ──

  /** "Shared with me": every grant usable right now, across agencies. */
  app.get('/host/openwop-app/collab/shared', async (req, res, next) => {
    try {
      // ADR 0887 S4 — freshness IS the revocation mechanism: never cached.
      res.set('Cache-Control', 'no-store');
      const user = await resolveCallerUser(req);
      const items: Array<Record<string, unknown>> = [];
      for (const use of await usableGrantsForUser(user.userId)) {
        const shown = await present(use);
        if (shown) items.push({ grantId: use.grant.grantId, resourceKind: use.grant.resource.kind, title: shown.title, clientName: shown.clientName, actions: use.grant.actions, expiresAt: use.grant.expiresAt });
      }
      res.json({ items });
    } catch (err) { next(err); }
  });

  /** One granted resource, through the one per-use check. Uniform 404 otherwise. */
  app.get('/host/openwop-app/collab/grants/:grantId', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store'); // ADR 0887 S4
      const user = await resolveCallerUser(req);
      let use: GrantUse;
      try {
        use = await checkGrantUse({ grantId: req.params.grantId, via: { userId: user.userId }, action: 'view' });
      } catch {
        throw new OpenwopError('not_found', 'Not found.', 404, {});
      }
      const shown = await present(use);
      if (!shown) throw new OpenwopError('not_found', 'Not found.', 404, {});
      // ADR 1099 P4 — the portal shows the chat only where the turn route would
      // answer: the kind names an agent AND its switch is on.
      const chat = !!grantResourceKind(use.grant.resource.kind)?.turnAgentId && (await kindCollaborationOn(use.grant.resource.kind, use.tenantId));
      res.json({
        grant: { grantId: use.grant.grantId, resourceKind: use.grant.resource.kind, actions: use.grant.actions, expiresAt: use.grant.expiresAt },
        title: shown.title, clientName: shown.clientName, resource: shown.body, chat,
      });
    } catch (err) { next(err); }
  });

  /** ADR 1099 D5 (P2) — one turn with the agent of the granted resource's kind.
   *  Signed in to the collaborator's own account; no member session in the firm. */
  app.post('/host/openwop-app/collab/grants/:grantId/turn', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store'); // ADR 0887 S4
      const user = await resolveCallerUser(req);
      const turn = await runCollaboratorTurn({ storage, grantId: req.params.grantId, userId: user.userId, message: (req.body ?? {}).message });
      if (turn.failed) throw new OpenwopError('service_unavailable', 'The project assistant could not answer. Try again.', 503, {});
      // The run is the firm's: its id is never handed to the outsider.
      res.json({ reply: turn.reply });
    } catch (err) { next(err); }
  });

  /** ADR 1099 P3d — the collaborator's conversation with the agent, read back (the
   *  portal shows it) or cleared to start over. Their own grant only; uniform 404. */
  const conversationUse = async (req: Request): Promise<GrantUse> => {
    const user = await resolveCallerUser(req);
    let use: GrantUse;
    try {
      use = await checkGrantUse({ grantId: req.params.grantId, via: { userId: user.userId }, action: 'view' });
    } catch {
      throw new OpenwopError('not_found', 'Not found.', 404, {});
    }
    if (!(await kindCollaborationOn(use.grant.resource.kind, use.tenantId))) throw new OpenwopError('not_found', 'Not found.', 404, {});
    return use;
  };
  app.get('/host/openwop-app/collab/grants/:grantId/turns', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store'); // ADR 0887 S4
      const use = await conversationUse(req);
      res.json({ messages: (await readTurnMemory(use.grant.grantId)).map(({ role, text, at }) => ({ role, text, at })) });
    } catch (err) { next(err); }
  });
  app.delete('/host/openwop-app/collab/grants/:grantId/turns', async (req, res, next) => {
    try {
      const use = await conversationUse(req);
      await clearTurnMemory(use.grant.grantId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  /** ADR 1099 D10 (P4) — the sections a feature added to this grant's view.
   *  The budget fails OPEN on purpose: a limiter outage lets reads through, and
   *  each read is still grant-checked, switch-checked and audited. Do not make it
   *  `closed`: that would turn a KV blip into a blank portal.
   *  The list and every read pass the same check as the grant itself (the one
   *  per-use check, then the kind's switch; uniform 404), so a section id never
   *  reaches someone without a usable grant. Both share one read budget per grant
   *  (the page re-reads on focus, which can loop). */
  const sectionBudget = async (use: GrantUse): Promise<void> => {
    const limit = await takeShared({ scope: 'collab.section.read', key: use.grant.grantId, limit: SECTION_READS_PER_GRANT_MIN, windowS: 60, failure: 'open' });
    if (!limit.allowed) throw new OpenwopError('rate_limited', 'Too many requests. Try again in a minute.', 429, { retryAfterS: limit.retryAfterS });
  };
  app.get('/host/openwop-app/collab/grants/:grantId/sections', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store'); // ADR 0887 S4
      const use = await conversationUse(req);
      await sectionBudget(use);
      res.json({ sections: await grantViewSectionsFor(use.grant.resource.kind, use.tenantId) });
    } catch (err) { next(err); }
  });
  app.get('/host/openwop-app/collab/grants/:grantId/sections/:sectionId', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store'); // ADR 0887 S4
      const use = await conversationUse(req);
      const section = await grantViewSection(use.grant.resource.kind, req.params.sectionId, use.tenantId);
      if (!section) throw new OpenwopError('not_found', 'Not found.', 404, {});
      await sectionBudget(use);
      const audit = (outcome: string): Promise<void> => auditCollaboratorSectionRead(use.tenantId, {
        grantId: use.grant.grantId, collaboratorId: use.collaborator.collaboratorId, orgId: use.orgId, section: section.id, outcome,
      });
      let data: Record<string, unknown>;
      try {
        // The scope comes from the grant only; no query or body field reaches read().
        data = await readGrantViewSection(section, clientScopeOf(use));
      } catch (err) {
        await audit(err instanceof OpenwopError && typeof err.details?.reason === 'string' ? err.details.reason : 'failed');
        throw err;
      }
      await audit(data.available === false ? 'least-view' : 'read');
      res.json({ data });
    } catch (err) { next(err); }
  });

  /** ADR 0958 D2 — accept while signed in to your own account. */
  app.post('/host/openwop-app/collab/invites/accept', async (req, res, next) => {
    try {
      const token = typeof (req.body ?? {}).token === 'string' ? (req.body as { token: string }).token : '';
      if (!token) throw new OpenwopError('validation_error', '`token` is required.', 400, { field: 'token' });
      // Signed in first: an anonymous caller is told to sign in, not "not found".
      const user = await resolveCallerUser(req);
      const link = await resolveActiveResource(token, 'collab_invite');
      // ADR 1099 D1 — the invite has no grant kind yet, so it is accepted when ANY
      // collaboration surface takes this tenant and org. For campaign-ops (the
      // default surface) that is both its toggles AND an active client account,
      // exactly the two checks this route made before (ADR 0958 D7: an archived
      // client takes no new collaborator; the link is kept for after an un-archive).
      if (!(await anySurfaceAdmits(link.tenantId, link.orgId))) throw new OpenwopError('not_found', 'Invite not found.', 404, {});
      const c = await getCollaborator(link.tenantId, link.orgId, link.resourceId);
      if (!c || c.status !== 'invited') throw new OpenwopError('not_found', 'Invite not found.', 404, {});
      const email = (user.email ?? '').trim().toLowerCase();
      if (email !== c.email || user.emailProvenance !== 'idp') {
        throw new OpenwopError('forbidden', 'This invite was sent to a different email address. Sign in with the account that receives that address, through your identity provider, so the address is verified.', 403, { reason: 'invite_email_mismatch' });
      }
      const bound = await bindCollaborator(link.tenantId, link.orgId, c.collaboratorId, user.userId);
      // Single use: the link dies once the binding holds. A failure above leaves it
      // usable for a corrected retry.
      await purgeLinksForResource(link.tenantId, 'collab_invite', c.collaboratorId);
      res.json({ collaborator: { collaboratorId: bound.collaboratorId, kind: bound.kind, displayName: bound.displayName, status: bound.status } });
    } catch (err) { next(err); }
  });

  // ── The firm's side (ADR 1099 P0b, the rest of D2). The same host functions the
  // campaign-ops agency panel calls, gated by grant kind instead of by campaign-ops:
  // invite and admin reads need `host:members:manage` and some surface that takes
  // the org; a grant needs its KIND's grant scope, and `grantAccess` checks its
  // kind's surface. The campaign-ops routes stay as they were. ──

  app.get(MEMBER_BASE, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await firm(req, ADMIN_SCOPE);
      await requireAnySurface(tenantId, orgId);
      const [rows, allGrants] = await Promise.all([listCollaborators(tenantId, orgId), listGrants(tenantId, orgId)]);
      res.json({ collaborators: rows.map((c) => ({ ...memberView(c), grants: allGrants.filter((g) => g.collaboratorId === c.collaboratorId) })) });
    } catch (err) { next(err); }
  });

  /** Every collaboration event in this org, newest first (ids only in the chain). */
  app.get(`${MEMBER_BASE}/audit`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await firm(req, ADMIN_SCOPE);
      await requireAnySurface(tenantId, orgId);
      res.json(await listCollaborationAudit(tenantId, orgId));
    } catch (err) { next(err); }
  });

  /** What this caller may grant here: kinds the org's surfaces admit and whose
   *  grant scope the caller holds. */
  app.get(`${MEMBER_BASE}/grantable`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const tenantId = tenantOf(req);
      const orgId = req.params.orgId;
      const org = await getOrg(orgId);
      if (!org || org.tenantId !== tenantId) throw new OpenwopError('not_found', 'Not found.', 404, {});
      const kinds = [];
      for (const k of await listGrantableResources(tenantId, orgId)) {
        if (!(await kindAdmits(k.kind, tenantId, orgId))) continue;
        try { await assertGrantAuthority(tenantId, orgId, user.userId, grantScopeOf(grantResourceKind(k.kind))); } catch { continue; }
        kinds.push(k);
      }
      res.json({ kinds });
    } catch (err) { next(err); }
  });

  /** Invite. Returns the single-use invite token ONCE; only its hash is stored. */
  app.post(MEMBER_BASE, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await firm(req, ADMIN_SCOPE);
      await requireAnySurface(tenantId, orgId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const c = await createCollaborator({ tenantId, orgId, kind: body.kind, email: body.email, displayName: body.displayName, company: body.company, createdBy: userId });
      const link = await createLink(tenantId, orgId, INVITE_ACTOR, { resourceType: 'collab_invite', resourceId: c.collaboratorId, expiresInDays: INVITE_DAYS }, { lane: 'visitor', why: 'the single-use invite an external collaborator accepts' });
      res.status(201).json({ collaborator: memberView(c), invite: { token: link.token, expiresAt: link.expiresAt } });
    } catch (err) { next(err); }
  });

  /** Grant: the KIND decides who may (its grant scope) and where (its surface). */
  app.post(`${MEMBER_BASE}/:collaboratorId/grants`, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const r = (body.resource && typeof body.resource === 'object' ? body.resource : {}) as { kind?: unknown };
      const kind = typeof r.kind === 'string' ? grantResourceKind(r.kind) : undefined;
      const { tenantId, orgId, userId } = await firm(req, grantScopeOf(kind));
      // The kind surface's SWITCH, which `grantAccess` does not check: its other
      // callers sit behind their own (campaign-ops' route checks its toggles; the
      // client portal mints under its own). Unknown kind falls through to
      // `grantAccess`'s 400.
      if (kind && typeof r.kind === 'string' && !(await kindCollaborationOn(r.kind, tenantId))) throw new OpenwopError('not_found', 'Not found.', 404, {});
      const grant = await grantAccess({ tenantId, orgId, collaboratorId: req.params.collaboratorId, resource: body.resource, actions: body.actions, expiresInDays: body.expiresInDays, audience: body.audience, createdBy: userId });
      res.status(201).json({ grant });
    } catch (err) { next(err); }
  });

  /** ADR 0958 Q1 — renew: whoever may grant this grant's kind here may renew it,
   *  for at most 180 more days from today. The grant id stays the same. */
  app.post(`${MEMBER_BASE}/:collaboratorId/grants/:grantId/extend`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const tenantId = tenantOf(req);
      const orgId = req.params.orgId;
      const grant = (await listGrants(tenantId, orgId, req.params.collaboratorId)).find((g) => g.grantId === req.params.grantId);
      if (!grant) throw new OpenwopError('not_found', 'Grant not found.', 404, {});
      await assertGrantAuthority(tenantId, orgId, user.userId, grantScopeOf(grantResourceKind(grant.resource.kind)));
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json({ grant: await extendGrant({ tenantId, orgId, grantId: grant.grantId, expiresInDays: body.expiresInDays, actor: user.userId }) });
    } catch (err) { next(err); }
  });

  /** Revoke: whoever may grant this grant's kind here may revoke it. */
  app.delete(`${MEMBER_BASE}/:collaboratorId/grants/:grantId`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const tenantId = tenantOf(req);
      const orgId = req.params.orgId;
      const grant = (await listGrants(tenantId, orgId, req.params.collaboratorId)).find((g) => g.grantId === req.params.grantId);
      if (!grant) throw new OpenwopError('not_found', 'Grant not found.', 404, {});
      await assertGrantAuthority(tenantId, orgId, user.userId, grantScopeOf(grantResourceKind(grant.resource.kind)));
      res.json({ grant: await revokeGrant(tenantId, orgId, grant.grantId, user.userId) });
    } catch (err) { next(err); }
  });
}
