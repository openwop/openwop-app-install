/**
 * Consent feature routes (host-extension, ADR 0020).
 *   Public (unauthed):  /v1/host/openwop-app/public-consent/:orgId[/:subjectToken]
 *   Authed (org-scoped, RBAC):  /v1/host/openwop-app/consent/orgs/:orgId/*
 * The public prefix is on PUBLIC_PATH_PREFIXES (auth.ts). Consent is TENANT-scoped
 * (a visitor's choices apply across the tenant's orgs); the public path resolves
 * org→tenant and gates on the org-tenant's `consent` toggle (uniform 404).
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireOrgScope, requireTenantScope, optionalString } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg } from '../../host/accessControlService.js';
import { getRetentionHold, RetentionHoldError } from '../../host/retentionHold.js';
import {
  mergeConsentCategories, getConsent, listConsent, getPolicy, setPolicy, deleteSubject, readmitSubject,
  type DefaultMode,
} from './consentService.js';
import { mintPublicSubjectToken, verifyPublicSubjectToken } from './publicSubjectToken.js';
import { requireCategories } from './surface.js';

// ADR 0657 D4 (CNWF-5) — a per-org fixed-window budget on the public capture (the it.9
// analytics-beacon shape): the per-IP limiter alone lets one visitor mint an unbounded
// number of `visitor:` rows into a store with no age-out. Read per call; `0` disables.
function orgCapturePerMin(): number { const n = Number(process.env.OPENWOP_CONSENT_CAPTURE_ORG_REQS_PER_MIN ?? 600); return Number.isFinite(n) && n >= 0 ? n : 600; }
const orgCaptureWindows = new Map<string, { windowStart: number; count: number }>();
function takeOrgCaptureBudget(orgId: string, now = Date.now()): boolean {
  const limit = orgCapturePerMin();
  if (limit === 0) return true;
  const w = orgCaptureWindows.get(orgId);
  if (!w || now - w.windowStart >= 60_000) { orgCaptureWindows.set(orgId, { windowStart: now, count: 1 }); return true; }
  if (w.count >= limit) return false;
  w.count += 1; return true;
}
/** Test affordance — never routed. */
export function __resetOrgCaptureBudgetForTests(): void { orgCaptureWindows.clear(); }
import {
  listPurposeVocab, addPurposeCode, removePurposeCode, isStrictPurposes, setStrictPurposes, validatePurposes,
} from '../cdp/purposeVocabService.js';

const FEATURE = { toggleId: 'consent', label: 'Consent' };
const ORG = '/v1/host/openwop-app/consent/orgs/:orgId';
const PUB = '/v1/host/openwop-app/public-consent';

type Scope = 'workspace:read' | 'workspace:write';

export function registerConsentRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);
  /**
   * CONS-5 — the DATA-SUBJECT lane, RBAC-gated but NOT toggle-gated.
   *
   * `authz` composes `requireFeatureEnabled('consent')` with `requireOrgScope`,
   * and `consentFeature.toggleDefault.status` is `'off'`. So in the DEFAULT
   * posture the ONLY DSAR erasure route the product ships answered 404 — while
   * every other feature kept writing subject PII regardless. Erasure is not a
   * product feature a tenant buys; it is an obligation over data that exists
   * whether or not they configured a consent regime.
   *
   * DELIBERATELY NOT the alternative fix. Flipping the toggle default to `on`
   * would ALSO flip `isAllowed` from the documented permissive posture
   * ("toggle off ⇒ permissive, honest opt-in", `feature.ts`) to fail-closed
   * under the `opt-in` default — i.e. every existing tenant would start DENYING
   * analytics and marketing for every subject with no record, silently breaking
   * live sends. That is exactly the "do not silently flip a default that changes
   * who can erase" trap, one layer over. Enforcement semantics are untouched;
   * only reachability of the obligation changes.
   *
   * The READ is on the same lane as the DELETE on purpose: the console's flow is
   * look-up-then-erase, and an erase that works beside a lookup that 404s is a
   * worse surface than either. Both keep the identical RBAC scope they had.
   */
  const dsarAuthz = (req: Request, scope: Scope) => requireOrgScope(req, scope);

  // org → tenant, gated on the org-tenant's `consent` toggle (uniform 404).
  const resolvePublicTenant = async (orgId: string): Promise<string> => {
    const notFound = (): never => { throw new OpenwopError('not_found', 'Not found.', 404, {}); };
    const org = await getOrg(orgId);
    if (!org) return notFound();
    const a = await resolveOne(FEATURE.toggleId, { tenantId: org.tenantId });
    if (!a || !a.enabled) return notFound();
    return org.tenantId;
  };

  // ───────────────────────── public record + read ─────────────────────────────
  //
  // CONS-2 — this lane has its OWN identity space (`visitor:<uuid>`), addressed
  // only by a host-minted, HMAC-signed token. It used to take `subjectKey`
  // straight from an unauthenticated body into the keyspace shared with CRM
  // contactIds, userIds, emails and E.164 numbers, and `recordConsent` REPLACES
  // wholesale — so anyone who knew a subject key could forge or wipe that
  // person's consent, and the GET was the matching anonymous oracle. Full
  // reasoning (including why this does not fail closed on the only capture path
  // the host ships) in `publicSubjectToken.ts`.
  app.post(`${PUB}/:orgId`, async (req, res, next) => {
    try {
      const tenantId = await resolvePublicTenant(req.params.orgId);
      if (!takeOrgCaptureBudget(req.params.orgId)) { // D4 — after the org resolved (the uniform 404 stays for unknown/off)
        res.setHeader('Retry-After', '60');
        throw new OpenwopError('rate_limited', 'Too many consent captures for this organization; retry shortly.', 429, { scope: 'org' });
      }
      const categories = requireCategories(((req.body ?? {}) as Record<string, unknown>).categories); // D4 — never mint on an empty body
      const body = (req.body ?? {}) as Record<string, unknown>;
      const region = optionalString(body.region);
      // A caller-supplied `subjectKey` is REFUSED rather than ignored: silently
      // dropping it would let a caller believe they recorded consent for a
      // person they did not. The refusal names the replacement — the exit.
      if (body.subjectKey !== undefined) {
        throw new OpenwopError(
          'validation_error',
          'Public consent capture no longer accepts `subjectKey`. Omit it to mint a `subjectToken`, then send that token back on later writes and reads.',
          400,
          { field: 'subjectKey' },
        );
      }
      // Review F1 — PRESENCE, not truthiness. This read `optionalString(body
      // .subjectToken)`, which returns `undefined` for `""`, `"   "`, `null`,
      // `0` and `{}` alike — so every one of those fell through to the MINT
      // branch and answered `201 {ok:true}` with a brand-new identity, which is
      // precisely the "silent fresh mint" the comment below forbids and ADR
      // 0586 D3 states as an invariant. The live shape is not exotic: a banner
      // sending `localStorage.getItem('owp') ?? ''` after a storage clear, or a
      // serializer emitting `null`, re-mints on every load, and each abandoned
      // identity takes its recorded opt-OUT with it — `isAllowed` then finds
      // neither record nor tombstone for the new key and returns the fail-open
      // `opt-out` default. A recorded refusal became a permission, exactly the
      // CONS-1 shape. `subjectKey` one branch above already had the strict
      // `!== undefined` test; the asymmetry was the bug.
      let token: string;
      let subjectKey: string;
      if (body.subjectToken !== undefined) {
        if (typeof body.subjectToken !== 'string' || body.subjectToken.trim().length === 0) {
          throw new OpenwopError(
            'validation_error',
            'Field `subjectToken` must be a non-empty string. Omit the field entirely to mint a new one.',
            400,
            { field: 'subjectToken' },
          );
        }
        const supplied = body.subjectToken.trim();
        const resolved = verifyPublicSubjectToken(tenantId, supplied);
        // An INVALID token is a 400, never a silent fresh mint — that would
        // write a brand-new record while the caller believes they updated
        // theirs (a fabrication with a green status code).
        //
        // Review F3 — the refusal NAMES ITS EXIT. A session-secret rotation
        // (or, with `OPENWOP_SESSION_SECRET` unset, any restart) invalidates
        // every minted token at once; without a stated way forward the visitor
        // could no longer read, update or WITHDRAW consent, and Art. 7(3)
        // requires withdrawal to be as easy as giving. A gate with no exit is a
        // defect — see `publicSubjectToken.ts`.
        if (!resolved) {
          throw new OpenwopError(
            'validation_error',
            'Invalid `subjectToken`. Discard it and omit the field to mint a new one — the previous record will no longer be reachable.',
            400,
            { field: 'subjectToken' },
          );
        }
        token = supplied;
        subjectKey = resolved;
      } else {
        ({ token, subjectKey } = mintPublicSubjectToken(tenantId));
      }
      // ADR 0302 — OPTIONAL opaque permitted-purpose codes. `recordConsent` runs the
      // capture hook (rejects with 400 only under strict-purpose mode). In non-strict
      // mode we ALSO surface any unknown codes as a non-fatal warning (fail-open).
      const purposes = Array.isArray(body.purposes)
        ? body.purposes.filter((p): p is string => typeof p === 'string')
        : undefined;
      // CONS-3 — MERGE, never replace. A public write that mentions only the
      // categories the visitor touched must not drop the ones they set
      // elsewhere (an email opt-in silently granting sms + push).
      const rec = await mergeConsentCategories({
        tenantId,
        subjectKey,
        categories, // D4 — validated BEFORE any token is minted
        source: 'public',
        ...(region ? { region } : {}),
        ...(purposes ? { purposes } : {}),
      });
      const warn = purposes ? (await validatePurposes(tenantId, purposes)).unknown : [];
      res.status(201).json({ ok: true, subjectToken: token, categories: rec.categories, ...(warn.length ? { unknownPurposes: warn } : {}) });
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/:orgId/:subjectToken`, async (req, res, next) => {
    try {
      const tenantId = await resolvePublicTenant(req.params.orgId);
      const subjectKey = verifyPublicSubjectToken(tenantId, req.params.subjectToken);
      // Uniform 404 — matching `resolvePublicTenant`'s posture. A distinct 400
      // here would turn the route back into an oracle (it would confirm which
      // tokens are well-formed for this tenant).
      if (!subjectKey) throw new OpenwopError('not_found', 'Not found.', 404, {});
      const rec = await getConsent(tenantId, subjectKey);
      if (rec) { res.json({ recorded: true, categories: rec.categories, ...(rec.region ? { region: rec.region } : {}) }); return; }
      const policy = await getPolicy(tenantId);
      res.json({ recorded: false, defaultMode: policy?.defaultMode ?? 'opt-in', categories: { necessary: true, analytics: false, marketing: false } });
    } catch (err) { next(err); }
  });

  // ───────────────────────── authed policy + records + data-subject ───────────
  app.get(`${ORG}/policy`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:read');
      // CONS-4 / CONS-UX-2 — the hold is READ-ONLY here on purpose. Placing and
      // lifting a hold stays on the superadmin ops surface (`routes/admin.ts`);
      // what the compliance console needs, and had no way to get, is simply
      // whether erasure is currently forbidden — so the confirm can say so
      // BEFORE the operator commits to an irreversible action rather than
      // returning a 409 they could not have anticipated.
      const hold = await getRetentionHold(tenantId);
      res.json({
        policy: (await getPolicy(tenantId)) ?? { tenantId, regulatedRegions: [], defaultMode: 'opt-in' as DefaultMode },
        ...(hold ? { legalHold: { reason: hold.reason, since: hold.createdAt } } : {}),
      });
    } catch (err) { next(err); }
  });

  app.put(`${ORG}/policy`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const input: { regulatedRegions?: string[]; defaultMode?: DefaultMode } = {};
      if (Array.isArray(body.regulatedRegions)) input.regulatedRegions = body.regulatedRegions.filter((r): r is string => typeof r === 'string');
      if (body.defaultMode === 'opt-in' || body.defaultMode === 'opt-out') input.defaultMode = body.defaultMode;
      res.json({ policy: await setPolicy(tenantId, input) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/records`, async (req, res, next) => {
    try { const { tenantId } = await authz(req, 'workspace:read'); res.json({ records: await listConsent(tenantId) }); }
    catch (err) { next(err); }
  });

  app.get(`${ORG}/subjects/:subjectKey`, async (req, res, next) => {
    try { const { tenantId } = await dsarAuthz(req, 'workspace:read'); res.json({ record: await getConsent(tenantId, req.params.subjectKey) }); }
    catch (err) { next(err); }
  });

  app.delete(`${ORG}/subjects/:subjectKey`, async (req, res, next) => {
    try {
      // ADR 0657 D6 — ONE authority for both doors onto `eraseSubject`: the scope the users
      // erase door already requires (`users/routes.ts`). `workspace:write` used to suffice,
      // so any editor could erase anyone in the workspace.
      const { tenantId } = await dsarAuthz(req, 'workspace:write');
      await requireTenantScope(req, 'host:members:manage');
      // GDPR erasure: idempotent — purges the consent record + fans out to every
      // registered feature eraser (Analytics events, …). No 404; erasing a subject
      // with no consent record still purges downstream data.
      let result: Awaited<ReturnType<typeof deleteSubject>>;
      try {
        result = await deleteSubject(tenantId, req.params.subjectKey);
      } catch (err) {
        // CONS-4 / WF-CONS-1 — a tenant under LEGAL HOLD refuses erasure with a
        // 409 the operator can act on, not a 200 that reads as "erased" and not
        // a bare 500. Art. 17(3)(b)/(e): a hold overrides the right to erasure.
        if (err instanceof RetentionHoldError) {
          throw new OpenwopError(
            'legal_hold',
            `This workspace is under legal hold (${err.reason}), so data cannot be erased. Lift the hold, then retry.`,
            409,
            { held: true, reason: err.reason, since: err.createdAt },
          );
        }
        throw err;
      }
      // CONS-G1 — `ok` reports whether the ERASURE completed, not merely whether
      // the request was handled. It was hard-coded `true`, so a fan-out in which
      // N feature erasers threw (leaving the subject's data in place) came back
      // indistinguishable from a clean one. The HTTP status stays 200: the
      // request was accepted and is idempotently retryable, and a partial
      // erasure is a reportable outcome, not a transport error.
      res.status(200).json({ ok: result.erasure.failed === 0, ...result });
    } catch (err) { next(err); }
  });

  // ADR 0657 D7 — the operator's attested door back. Clears the DSAR's tombstone GROUP
  // (requested key + every resolved key) and grants nothing: the subject's next
  // affirmative opt-in re-grants. Un-toggle-gated like the DSAR itself (a refusal
  // erasure wrote is not a feature a tenant buys). `not_erased` is informational.
  app.post(`${ORG}/subjects/:subjectKey/readmit`, async (req, res, next) => {
    try {
      const { tenantId } = await dsarAuthz(req, 'workspace:write');
      await requireTenantScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await readmitSubject(tenantId, req.params.subjectKey, typeof body.attestation === 'string' ? body.attestation : '');
      res.status(200).json({ ok: true, subjectKey: req.params.subjectKey, ...result, ...(result.readmitted ? {} : { reason: 'not_erased' }) });
    } catch (err) { next(err); }
  });

  // ───────────────────────── purpose-vocabulary registry (ADR 0302) ───────────
  // ADVISORY, host-local. Manages the tenant's known purpose codes + the
  // `strictPurposes` capture flag. Does NOT touch the RFC 0128 opaque-string wire.
  app.get(`${ORG}/purpose-vocab`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:read');
      res.json({ purposes: await listPurposeVocab(tenantId), strict: await isStrictPurposes(tenantId) });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/purpose-vocab`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.status(201).json({ purposes: await addPurposeCode(tenantId, body.code) });
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/purpose-vocab/:code`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:write');
      res.json({ purposes: await removePurposeCode(tenantId, req.params.code) });
    } catch (err) { next(err); }
  });

  app.put(`${ORG}/purpose-vocab/strict`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.strict !== 'boolean') {
        throw new OpenwopError('validation_error', 'Field `strict` is required and MUST be a boolean.', 400, { field: 'strict' });
      }
      res.json({ strict: await setStrictPurposes(tenantId, body.strict) });
    } catch (err) { next(err); }
  });
}
