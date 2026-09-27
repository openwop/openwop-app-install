/**
 * feature.orgs.nodes — org-invitation nodes over `ctx.features.orgs`
 * (ADR 0622 D2). Pure-JS, Node-20 stdlib only.
 *
 * The bodies do ZERO auth. Every decision — acting user present + active,
 * `host:members:manage` in the TARGET org (default: the run's workspace root),
 * the public base URL for the accept link, deliverability — lives in the host
 * surface (`features/orgs/surface.ts`), which is the SAME org-scoped predicate
 * the `/orgs/:orgId/invites` routes use. A system run (schedule, webhook, or a
 * host-event-started run — the dispatcher stamps no acting user) is refused
 * there with a named exit; the node forwards the typed error, it never softens
 * it into `status:'success'`.
 *
 * REPLAY / FORK: `invite` declares `"role": "side-effect"` + `side-effectful`
 * (the derived floor) AND carries an explicit `SIDE_EFFECTING_TYPE_PATTERNS`
 * entry in `executor/sideEffects.ts` (the #2871 two-leg lesson — a pack `.mjs`
 * cannot set `module.sideEffecting`). A `:fork` is served the source run's
 * recorded `{ inviteId, orgId, delivery }` and never re-mints: a second mint
 * would be a NEW inviteId that kills the link already in the recipient's inbox.
 *
 * WHERE VALUES COME FROM (runtime facts win over authoring-time defaults — the
 * merged-args idiom `WF-CMNT-3`): `ctx.inputs.<key>` (an edge-delivered value)
 * → `ctx.config.<key>` (the chain parameter, e.g. `{{params.newHireEmail}}`
 * frozen at instantiation; RFC 0013 Path A freezes an unset param to
 * `undefined`/`''`, which is why an empty value falls through to a typed error).
 * The approval gate's `approved`/`decision` arrive on the default port and are
 * ignored. NOTHING is read from `triggerData`: the `host.orgs.invitation.*`
 * payloads carry no email by design, so there is no event-lane target to honour.
 */

function ensureOrgs(ctx) {
  const orgs = ctx.features && ctx.features.orgs;
  if (!orgs || typeof orgs.invite !== 'function' || typeof orgs.listInvitations !== 'function' || typeof orgs.revokeInvitation !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.orgs — the Org invitations feature must be composed and enabled for this tenant (ADR 0622 D2)'),
      { code: 'host_capability_missing', capability: 'host.sample.orgs' },
    );
  }
  return orgs;
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function merged(ctx, key) {
  const inputs = ctx.inputs ?? {};
  const config = ctx.config ?? {};
  return str(inputs[key]) || str(config[key]);
}

function required(ctx, key, hint) {
  const v = merged(ctx, key);
  if (!v) {
    throw Object.assign(
      new Error(`${key} is required — ${hint}`),
      { code: 'validation_error', field: key },
    );
  }
  return v;
}

const optionalOrgId = (ctx) => {
  const orgId = merged(ctx, 'orgId');
  return orgId ? { orgId } : {};
};

export async function invite(ctx) {
  const orgs = ensureOrgs(ctx);
  const email = required(ctx, 'email', 'supply it as an input or set the `newHireEmail` chain parameter');
  const role = merged(ctx, 'role') || 'viewer';
  const out = await orgs.invite({ email, role, ...optionalOrgId(ctx) });
  return { status: 'success', outputs: { inviteId: out.inviteId, orgId: out.orgId, delivery: out.delivery } };
}

export async function listInvitations(ctx) {
  const orgs = ensureOrgs(ctx);
  const out = await orgs.listInvitations({ ...optionalOrgId(ctx) });
  return { status: 'success', outputs: { orgId: out.orgId, invitations: out.invitations, count: out.count } };
}

export async function revokeInvitation(ctx) {
  const orgs = ensureOrgs(ctx);
  const inviteId = required(ctx, 'inviteId', 'wire the `inviteId` port of an upstream invite node or set it in the node config');
  const out = await orgs.revokeInvitation({ inviteId, ...optionalOrgId(ctx) });
  return { status: 'success', outputs: { inviteId: out.inviteId, orgId: out.orgId, revoked: true } };
}

export const nodes = {
  'feature.orgs.nodes.invite': invite,
  'feature.orgs.nodes.list-invitations': listInvitations,
  'feature.orgs.nodes.revoke-invitation': revokeInvitation,
};

export default nodes;
