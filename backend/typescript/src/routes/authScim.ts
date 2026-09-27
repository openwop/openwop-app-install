/**
 * SCIM provisioning seam + minimal SCIM 2.0 endpoints (RFC 0050 §B —
 * `openwop-auth-scim`).
 *
 *   POST /v1/host/openwop-app/auth/scim/provision   { scimUrl, op, externalId?, userName?,
 *                                                     email?, displayName?, group?, idpUrl? }
 *   POST   /scim/v2/Users                       create/upsert a principal
 *   PATCH  /scim/v2/Users/:id   { active }      deactivate/reactivate
 *   DELETE /scim/v2/Users/:id                   deactivate (leaver)
 *   POST   /scim/v2/Groups      { members }     group-membership sync
 *
 * The seam drives the host's provisioning service (scimProvisioningService) for
 * a named `op` — `create-user` (-> RFC 0048 principal), `assign-group` (-> role
 * membership), `deactivate-user` (-> fail-closed: subsequent decisions deny,
 * RFC 0050 §B / finding H5). The seam is HOST-LEVEL (not behind the `users`
 * toggle) so the advertised `openwop-auth-scim` capability is always reachable
 * (finding C1); it 404s only when no SCIM endpoint is configured
 * (`OPENWOP_TEST_SCIM_URL` unset), which is how the conformance leg soft-skips.
 *
 * NEVER set `OPENWOP_TEST_SCIM_URL` on a host that will later get a production
 * SP. The seam's `deactivate-user` writes `denyLinkedSubject` rows under the
 * SCIM link realm (`scimLinkRealm()`), and that realm is exactly what the
 * production SAML ACS consults once the realms are aligned (`USERS-13`) — so
 * deny rows pre-seeded through the test seam become live SSO denials the day
 * the SP is configured. The seam is a conformance fixture, not a staging tool.
 *
 * The `/scim/v2/{Users,Groups}` endpoints satisfy the §B MUST "expose SCIM
 * endpoints"; they delegate to the same service. (Advanced SCIM — filtering,
 * full PATCH-op semantics, ETags — is a documented follow-on; provisioning +
 * the fail-closed deactivation contract are honored.)
 *
 * AUTH (finding C3 / §B MUST): SCIM requests are authenticated with the IdP's
 * SCIM bearer (`OPENWOP_SCIM_BEARER`), verified in constant time by
 * `requireScimBearer` on every `/scim/v2/*` route; the routes 404 entirely
 * when the bearer is unconfigured. (This wiring is now IMPLEMENTED — the prior
 * "follow-on" note was stale.)
 */

import { timingSafeEqual } from 'node:crypto';
import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { appendAudit } from '../host/auditChainService.js';
import { samlConfigured } from '../host/auth/samlSso.js';
import { scimLinkRealm } from '../host/auth/subjectLinkService.js';
import {
  DEFAULT_SCIM_USER,
  SCIM_OPS,
  assignGroup,
  deactivateUser,
  isPrincipalResolvable,
  provisionUserWithOutcome,
  resolveScimUser,
  scimUserNameOf,
  setScimActive,
  type ScimOp,
} from '../host/auth/scimProvisioningService.js';
import { extractSamlIssuer } from '../host/auth/samlValidationService.js';
import { isAllowedIdpUrl } from '../host/auth/samlSeamOrigins.js';

const log = createLogger('auth.scim');

function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Authenticate a real SCIM `/scim/v2/*` request (review finding #9). RFC 0050 §B
 * requires the host to authenticate provisioning with the IdP's SCIM bearer and
 * NOT expose it to unauthenticated callers. The endpoints are enabled ONLY when
 * `OPENWOP_SCIM_BEARER` is configured (else 404 — they don't exist), and each
 * request MUST present that bearer (constant-time compare) — so the demo's
 * default anon-session minting can never reach provisioning. The provisioning
 * tenant is the configured SCIM client's tenant (`OPENWOP_SCIM_TENANT`), NOT the
 * caller's `req.tenantId`; it defaults to the dedicated `scim` namespace (NOT
 * `default`, which holds password/OIDC users — review finding #5) so a SCIM
 * bearer can't collide with another auth path's records.
 */
function scimTenant(): string {
  return scimLinkRealm();
}

/**
 * USERS-16 — the IdP-driven leaver on the ADR 0301 audit chain. Ids only
 * (`userId`, never `userName`/`externalId`/email); actor is the literal `scim`
 * (a bearer, not a person). Best-effort: the chain never blocks provisioning.
 */
async function auditScimLifecycle(tenantId: string, userId: string, active: boolean): Promise<void> {
  await appendAudit(tenantId, `users.lifecycle.${active ? 'enable' : 'disable'}`, {
    tenantId,
    userId,
    status: active ? 'active' : 'disabled',
    actor: 'scim',
  }).catch(() => { /* audit is best-effort */ });
}

/**
 * USERS-16 (review NIT-1) — a SCIM-created account is on the chain like an
 * admin-created one (`users.lifecycle.create`, ids only, `actor: 'scim'`);
 * only a NEW row is a create — a mover re-provision refreshes the profile and
 * appends nothing here. Best-effort, like every lifecycle row.
 */
async function auditScimCreate(tenantId: string, user: { userId: string; source: string; groups: string[] }): Promise<void> {
  await appendAudit(tenantId, 'users.lifecycle.create', {
    tenantId,
    userId: user.userId,
    source: user.source,
    groupCount: user.groups.length,
    actor: 'scim',
  }).catch(() => { /* audit is best-effort */ });
}

/**
 * USERS-14 — an externalId-addressed seam op (`create-user` / `deactivate-user`
 * with `externalId`) resolves in the DETERMINISTIC SCIM realm, not the caller's
 * tenant, and a deactivation there writes the cross-lane deny the PRODUCTION
 * SAML ACS consults. With `OPENWOP_TEST_SCIM_URL` set and NO bearer configured
 * the seam is otherwise open to any (even anonymous) caller — so on a host where
 * a production SAML SP exists, an unauthenticated caller could provision then
 * deactivate an arbitrary externalId and deny that NameID's real SSO login.
 * Refused 403 unless a SCIM bearer is configured (and then presented — the
 * `requireScimBearer` line above). A pure-conformance host (no production SP:
 * the only SAML lane is the validate seam, driven by the same suite) keeps the
 * open posture the RFC 0159 scenario needs; that residual is stated, not hidden.
 */
function requireBearerForLinkRealmWrite(externalId: string | undefined): void {
  if (!externalId || process.env.OPENWOP_SCIM_BEARER || !samlConfigured()) return;
  throw new OpenwopError(
    'forbidden',
    'An externalId-addressed SCIM op writes the subject-link realm a production SAML SP consults; configure OPENWOP_SCIM_BEARER (and present it) to use it on this host.',
    403,
    { reason: 'scim_bearer_required' },
  );
}

/**
 * RFC 0163 §B — resolve the IdP entityID (SAML `<saml:Issuer>`) this SCIM
 * connection is bound to, so the SAML decision path can trust-root-scope the
 * cross-lane link.
 *
 * TWO binding paths, per the RFC ("bind each SCIM client credential to exactly
 * one IdP entityID at configuration time and MUST NOT infer it from the request"):
 *   - the conformance seam supplies an `idpUrl` naming the synthetic IdP that
 *     feeds this connection's lane; the entityID is the `<saml:Issuer>` that IdP
 *     signs into its assertions. We resolve it by fetching the IdP once at
 *     provision time — SSRF-guarded to the configured synthetic-IdP allowlist
 *     (never an arbitrary body URL).
 *   - the real `/scim/v2` lane carries no `idpUrl` (it authenticates by bearer),
 *     so the entityID is the config-bound `OPENWOP_SCIM_IDP_ENTITY_ID`.
 * Returns `undefined` when neither is available (an unbound connection — the
 * SAML path then falls back to the RFC 0159 deny-only contract).
 */
async function resolveScimIdpEntityId(idpUrl: string | undefined): Promise<string | undefined> {
  const configured = process.env.OPENWOP_SCIM_IDP_ENTITY_ID;
  if (idpUrl) {
    if (!isAllowedIdpUrl(idpUrl)) {
      throw new OpenwopError('forbidden', 'idpUrl does not match a configured synthetic IdP.', 403, {});
    }
    try {
      const res = await fetch(`${idpUrl}?variant=${encodeURIComponent('valid')}`);
      if (res.ok) {
        const { assertion } = (await res.json()) as { assertion?: string };
        const issuer = typeof assertion === 'string' ? extractSamlIssuer(assertion) : null;
        if (issuer) return issuer;
      }
    } catch {
      /* fall through to the config seat — never fail provisioning on an IdP fetch */
    }
  }
  return configured && configured.length > 0 ? configured : undefined;
}

function requireScimBearer(req: Request): string {
  const configured = process.env.OPENWOP_SCIM_BEARER;
  if (!configured) {
    throw new OpenwopError('not_found', 'SCIM provisioning is not enabled (set OPENWOP_SCIM_BEARER).', 404, {});
  }
  const header = req.header('authorization') ?? '';
  const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OpenwopError('unauthenticated', 'A valid SCIM bearer token is required.', 401, {});
  }
  return scimTenant();
}

/** Coerce one PatchOp `value` to the desired `active` boolean. */
function activeFromValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  // value-object form: { value: { active: false } } (Okta/Azure AD).
  if (value && typeof value === 'object' && 'active' in (value as Record<string, unknown>)) {
    return activeFromValue((value as { active?: unknown }).active);
  }
  return undefined;
}

/** The provision seam's closed-world body keys (CLNP-7). `scimUrl` is the conformance
 *  driver's own routing hint — sent on every call, read by nobody here. */
const SEAM_BODY_KEYS: ReadonlySet<string> = new Set([
  'scimUrl', 'op', 'externalId', 'userName', 'email', 'displayName', 'group', 'linkKey', 'idpUrl',
]);

export function assertSeamBodyShape(body: unknown): void {
  if (body === undefined || body === null) return; // an empty POST reaches the `op` check → 400
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new OpenwopError('validation_error', 'The SCIM provision seam body MUST be a JSON object.', 400, {});
  }
  const unknownKeys = Object.keys(body).filter((k) => !SEAM_BODY_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new OpenwopError(
      'validation_error',
      `Unknown field(s) on the SCIM provision seam: ${unknownKeys.join(', ')}. Every field rides the top level (no nested \`user\`); a raw RFC 7643 User belongs on POST /scim/v2/Users.`,
      400,
      { unknown: unknownKeys, allowed: [...SEAM_BODY_KEYS] },
    );
  }
}

/** Read the desired `active` value from a flat `{active}` body OR an RFC 7644
 *  PatchOp — BOTH the `{path:'active', value}` and the path-less
 *  `{value:{active}}` shapes real IdPs send (review finding #2). Exported for
 *  unit tests. */
export function readActive(body: unknown): boolean | undefined {
  const b = (body ?? {}) as { active?: unknown; Operations?: unknown };
  if (typeof b.active === 'boolean') return b.active;
  if (Array.isArray(b.Operations)) {
    for (const op of b.Operations as Array<{ op?: unknown; path?: unknown; value?: unknown }>) {
      if (typeof op.op === 'string' && op.op.toLowerCase() === 'remove') continue;
      if (typeof op.path === 'string' && op.path.toLowerCase() === 'active') {
        const v = activeFromValue(op.value);
        if (v !== undefined) return v;
      } else if (op.path === undefined || op.path === null) {
        // path-less replace: the active flag lives inside the value object.
        const v = activeFromValue(op.value);
        if (v !== undefined) return v;
      }
    }
  }
  return undefined;
}

/** RFC 0159 §A.2 — a cross-lane link key MUST be an OPAQUE, IdP-stable id
 *  (`externalId`), never a mutable/PII attribute. Anything on this list is
 *  rejected: it would let a leaver keep SSO access by rotating the mutable value,
 *  or let a mutable key drive a cross-lane deny on the wrong subject. */
const MUTABLE_LINK_KEYS = new Set(['email', 'username', 'phone', 'phonenumber', 'name', 'displayname', 'givenname', 'familyname']);

export function registerScimAuthRoutes(app: Express): void {
  // ---- Conformance seam ----
  // BOTH spellings, unconditionally (the multiPartyConversationSeam idiom): the
  // pinned suite drives `/v1/host/sample/*`, and the testSeam namespace rewrite
  // that would map it onto the product path only runs under
  // OPENWOP_TEST_SEAM_ENABLED — but the RFC 0159 legs opt in on
  // OPENWOP_TEST_SAML_IDP_URL + OPENWOP_TEST_SCIM_URL alone, so the `sample`
  // alias must be reachable whether or not the rewrite is active. The handler
  // 404s without OPENWOP_TEST_SCIM_URL, so registering both is production-safe.
  app.post(['/v1/host/openwop-app/auth/scim/provision', '/v1/host/sample/auth/scim/provision'], async (req, res, next) => {
    try {
      if (!process.env.OPENWOP_TEST_SCIM_URL) {
        throw new OpenwopError('not_found', 'SCIM test seam not configured (set OPENWOP_TEST_SCIM_URL).', 404, {});
      }
      // If the deployment has configured a SCIM bearer, the test seam MUST honor
      // it too — otherwise it's an unauthenticated bypass of the bearer-gated
      // /scim/v2/* surface (review finding #1). Pure-conformance deployments
      // (no bearer configured) leave it open + tenant-isolated to the caller.
      if (process.env.OPENWOP_SCIM_BEARER) requireScimBearer(req);
      // USERS-21 — ONE body shape. Every field rides the TOP LEVEL, which is both
      // what the vendored conformance scenario sends and what real SCIM 2.0 does
      // (`{schemas, userName, displayName, …}` is flat; nothing nests under `user`).
      // The legacy nested `user:{}` fallback is GONE: it was the sole carrier of
      // `displayName`, which is why it survived earlier sweeps, so lifting that field
      // here is what made the fallback removable. Safe because this seam is a
      // conformance fixture — it 404s unless `OPENWOP_TEST_SCIM_URL` is set, and the
      // header of this file forbids setting that on a host with a production SP.
      // CLNP-7 — the ONE shape is ENFORCED, not just sent. Every field below is optional
      // and `userName` falls back to the default principal, so an unrecognised key used to
      // be silently dropped: a legacy nested `user:{}`, a case-typo `UserName`, and a
      // literal RFC 7643 body (`schemas`, `emails[]`, `name{}`) all got 201 WITH THE
      // DEFAULT PRINCIPAL — a success that provisioned someone the caller never named.
      // Closed world instead. Trade-off, accepted on purpose: a future suite that sends a
      // new key now gets a loud 400 rather than a quiet wrong answer. Real SCIM bodies
      // belong on `POST /scim/v2/Users`, which reads the RFC 7643 shape.
      assertSeamBodyShape(req.body);
      const body = (req.body ?? {}) as { op?: unknown; group?: unknown; externalId?: unknown; userName?: unknown; email?: unknown; displayName?: unknown; linkKey?: unknown; idpUrl?: unknown };
      const op = body.op as ScimOp | undefined;
      if (op === undefined || !(SCIM_OPS as readonly string[]).includes(op)) {
        throw new OpenwopError('validation_error', `Field \`op\` MUST be one of ${SCIM_OPS.join(', ')}.`, 400, { allowed: SCIM_OPS });
      }
      const externalId = str(body.externalId);
      const email = str(body.email);
      const userName = str(body.userName) ?? DEFAULT_SCIM_USER.userName;
      const callerTenant = tenantOf(req);
      // RFC 0159 (ADR 0613) — a subject-link op (addressed by the opaque
      // externalId) resolves in the DETERMINISTIC SCIM realm (OPENWOP_SCIM_TENANT),
      // so create/deactivate and the pre-auth SAML-validate consult all agree on
      // one tenant with no session to derive it from. A plain userName op keeps
      // the caller's tenant (unchanged behavior).
      const linkTenant = scimTenant();
      requireBearerForLinkRealmWrite(externalId); // USERS-14

      switch (op) {
        case 'create-user': {
          const tenantId = externalId ? linkTenant : callerTenant;
          // RFC 0163 §B — bind the connection's trust-root entityID (from the
          // seam's idpUrl, or the config seat) so the SAML lane can trust-root-
          // scope the link. Only meaningful for a linkable (externalId) record.
          const idpEntityId = externalId ? await resolveScimIdpEntityId(str(body.idpUrl)) : undefined;
          const { user: principal, created } = await provisionUserWithOutcome({
            tenantId,
            userName,
            ...(externalId ? { externalId } : {}),
            ...(idpEntityId ? { idpEntityId } : {}),
            ...(email ? { email } : {}),
            displayName: str(body.displayName) ?? DEFAULT_SCIM_USER.displayName,
          });
          if (created) await auditScimCreate(tenantId, principal);
          // USERS-15 — ids only: `userName` is an email in practice.
          log.info('scim_user_provisioned', { userId: principal.userId, tenantId, linked: Boolean(externalId) });
          res.status(201).json({ op, principal, resolvable: await isPrincipalResolvable(tenantId, userName) });
          return;
        }
        case 'assign-group': {
          const group = str(body.group) ?? 'scim-group';
          const principal = await assignGroup({ tenantId: callerTenant, userName, group });
          if (!principal) throw new OpenwopError('not_found', 'SCIM user not found; provision it first.', 404, { userName });
          res.status(200).json({ op, principal, groups: principal.groups });
          return;
        }
        case 'deactivate-user': {
          // Addressed by the opaque externalId (subject-link leaver) → resolve +
          // disable in the deterministic realm AND write the cross-lane deny
          // (deactivateUser owns the deny write). Fail-closed if unresolved.
          if (externalId) {
            const principal = await deactivateUser({ tenantId: linkTenant, externalId });
            if (!principal) throw new OpenwopError('not_found', 'SCIM user not found.', 404, { externalId });
            log.info('scim_user_deactivated', { userId: principal.userId, tenantId: linkTenant, linked: true });
            await auditScimLifecycle(linkTenant, principal.userId, false); // USERS-16
            res.status(200).json({ op, principal, resolvable: false });
            return;
          }
          // RFC 0159 §A.2 — a deactivation addressed only by a mutable/PII key
          // (email) MUST NOT write an externalId-keyed cross-lane deny. There is
          // no opaque subject to act on; acknowledge without a link effect.
          if (email && !userName) {
            res.status(200).json({ op, linked: false, note: 'RFC 0159 §A.2: no opaque externalId; no cross-lane deny written' });
            return;
          }
          const principal = await deactivateUser({ tenantId: callerTenant, userName });
          if (!principal) throw new OpenwopError('not_found', 'SCIM user not found.', 404, { userName });
          log.info('scim_user_deactivated', { userId: principal.userId, tenantId: callerTenant, linked: false }); // USERS-15
          await auditScimLifecycle(callerTenant, principal.userId, false); // USERS-16
          // Fail-closed: the principal is no longer resolvable to an active id.
          res.status(200).json({ op, principal, resolvable: await isPrincipalResolvable(callerTenant, userName) });
          return;
        }
        case 'link': {
          // RFC 0159 §A.2 — reject a mutable/PII link key; form NO cross-lane
          // link from it. (The legitimate link is IMPLICIT: externalId ==
          // persistent SAML NameID, established at provision time — the host
          // never mints a separate link record from a `link` op.)
          const linkKey = str(body.linkKey);
          if (!linkKey || MUTABLE_LINK_KEYS.has(linkKey.toLowerCase())) {
            throw new OpenwopError(
              'validation_error',
              'RFC 0159 §A.2: a cross-lane link key MUST be an opaque, IdP-stable id (externalId), not a mutable/PII attribute.',
              400,
              { linkKey: linkKey ?? null },
            );
          }
          res.status(200).json({ op, linked: false, note: 'cross-lane link is implicit via externalId==NameID; no mutable-key link formed' });
          return;
        }
      }
    } catch (err) {
      next(err);
    }
  });

  // ---- Real SCIM 2.0 endpoints (§B "MUST expose") — bearer-authenticated ----
  app.post('/scim/v2/Users', async (req, res, next) => {
    try {
      const tenantId = requireScimBearer(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userName = str(body.userName);
      if (!userName) throw new OpenwopError('validation_error', 'SCIM `userName` is required.', 400, {});
      const emails = Array.isArray(body.emails) ? (body.emails as Array<{ value?: unknown }>) : [];
      // RFC 0163 §B — the real /scim/v2 lane carries no idpUrl (bearer-authed),
      // so the connection's trust root is the config-bound entityID.
      const idpEntityId = str(body.externalId) ? await resolveScimIdpEntityId(undefined) : undefined;
      const { user: principal, created } = await provisionUserWithOutcome({
        tenantId,
        userName,
        ...(str(body.externalId) ? { externalId: str(body.externalId)! } : {}),
        ...(idpEntityId ? { idpEntityId } : {}),
        ...(str(body.displayName) ? { displayName: str(body.displayName)! } : {}),
        ...(str(emails[0]?.value) ? { email: str(emails[0]!.value)! } : {}),
      });
      if (created) await auditScimCreate(tenantId, principal);
      res.status(201).json({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: principal.userId, userName, active: principal.status === 'active' });
    } catch (err) {
      next(err);
    }
  });

  // Lifecycle: `:id` is EITHER the durable id returned by create
  // (`user:<sha256-prefix>` — the deterministic `userIdFor` hash, NOT a UUID;
  // this comment used to say `user:<uuid>`) OR the SCIM userName (review
  // finding #4). PATCH carries an explicit `active`
  // (flat or RFC 7644 PatchOp) so reactivate (true) and deactivate (false) both
  // work (review finding #5); DELETE is always deactivate.
  for (const handler of ['patch', 'delete'] as const) {
    app[handler]('/scim/v2/Users/:id', async (req, res, next) => {
      try {
        const tenantId = requireScimBearer(req);
        const idOrUserName = req.params.id;
        const user = await resolveScimUser(tenantId, idOrUserName);
        if (!user) throw new OpenwopError('not_found', 'SCIM user not found.', 404, { id: idOrUserName });
        const active = handler === 'delete' ? false : readActive(req.body);
        if (active === undefined) {
          throw new OpenwopError('validation_error', 'PATCH MUST set `active` (flat or via Operations).', 400, {});
        }
        const updated = await setScimActive(user, active);
        log.info('scim_user_lifecycle', { userId: user.userId, active });
        await auditScimLifecycle(tenantId, user.userId, active); // USERS-16 — the IdP-driven leaver on the chain
        // Echo the REAL userName, not the addressed id (review finding #8).
        res.status(200).json({ id: user.userId, userName: scimUserNameOf(user), active: updated?.status === 'active' });
      } catch (err) {
        next(err);
      }
    });
  }

  app.post('/scim/v2/Groups', async (req, res, next) => {
    try {
      const tenantId = requireScimBearer(req);
      const body = (req.body ?? {}) as { displayName?: unknown; members?: unknown };
      const group = str(body.displayName);
      if (!group) throw new OpenwopError('validation_error', 'SCIM group `displayName` is required.', 400, {});
      const members = Array.isArray(body.members) ? (body.members as Array<{ value?: unknown }>) : [];
      const assigned: string[] = [];
      for (const m of members) {
        const ref = str(m.value);
        // members may carry the durable id or the userName; resolve either.
        const u = ref ? await resolveScimUser(tenantId, ref) : null;
        if (u && (await assignGroup({ tenantId, userName: scimUserNameOf(u), group }))) assigned.push(scimUserNameOf(u));
      }
      res.status(201).json({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: group, members: assigned.map((value) => ({ value })) });
    } catch (err) {
      next(err);
    }
  });
}
