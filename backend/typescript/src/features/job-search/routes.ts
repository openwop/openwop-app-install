/**
 * ADR 0539 — job-search host-extension routes.
 *
 *   GET /v1/host/openwop-app/job-search/status
 *     → { enabled: true, modules: [...] }
 *
 * Non-normative host-extension namespace (`/v1/host/openwop-app/*`) — never
 * touches the OpenWOP wire, so no RFC.
 *
 * This phase claims the namespace and proves the gate. The domain routes arrive
 * with their own ADRs (0540 applications, 0542 listings, …) under this same
 * prefix, so the ownership of `/job-search/*` is established once, here.
 */
import type { Response } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, authorizeOrgScope } from '../featureRoute.js';
import { JOB_SEARCH_TOGGLE, JOB_SEARCH_LABEL } from './service.js';
import { createApplication, advanceApplication, listApplications, resolveApplicationPipeline } from './domain/applications.js';
import { createApplyGrant, revokeApplyGrant, applyGrants } from '../../host/applyGrant.js';
import { listListings, setListingsPublic, listingsArePublic } from './boards/listing.js';
import { listDeals } from '../crm/crmEntitiesService.js';
import { provisionCareerAgent, queueCampaignCard } from './agent/provision.js';
import { getSteering, putSteering } from './agent/steering.js';
import { issueAttestation, previewAttestation, resolveAttestation, revokeAttestation, listAttestations } from './attestation/token.js';
import type { IssueRefusal } from './attestation/token.js';
import { buildFunnelReport } from './lifecycle/funnel.js';
import { dueFollowUps, completeFollowUp } from './lifecycle/followUps.js';
import { listDrafts, approveDraft, type DraftKind } from './lifecycle/drafts.js';
import type { JobDigest } from './domain/digest.js';

export const JOB_SEARCH_BASE = '/v1/host/openwop-app/job-search';

/**
 * Modules of the ONE package that are ACTUALLY IMPLEMENTED (ADR 0539 D0).
 *
 * This listed all six planned modules — `boards`, `agent`, `attestation`,
 * `autopilot` and `lifecycle` among them — while only `domain` existed. That is
 * the "advertise only what is honored" rule broken on a host-extension surface:
 * a client reading `/status` would have been told about capabilities that were
 * not there. Each name lands here when its module does, and
 * `job-search-foundation.test.ts` fails if this list and the source tree
 * disagree in either direction. (Found by `/code-review`.)
 */
const MODULES = ['agent', 'attestation', 'autopilot', 'boards', 'domain', 'lifecycle'] as const;

export function registerJobSearchRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${JOB_SEARCH_BASE}/status`, async (req, res, next) => {
    try {
      // Toggle gate first, and it is a REAL gate: the bundle is priced, so
      // ADR 0539's honesty consequence is that `job-search` must genuinely fail
      // closed for a workspace that has not bought it.
      await requireFeatureEnabled(req, JOB_SEARCH_TOGGLE, JOB_SEARCH_LABEL);
      res.json({ enabled: true, modules: [...MODULES] });
    } catch (err) {
      next(err);
    }
  });

  // ── Applications (ADR 0540 P2) ────────────────────────────────────────────
  //
  // ORG-scoped. `authorizeOrgScope` is toggle-gate + org membership + scope in
  // one call, and the tenantId it returns comes from the PRINCIPAL — never from
  // a path or body parameter. That is what makes a cross-tenant id a 404 rather
  // than a read: an attacker supplying another tenant's dealId is scoped out
  // before any lookup happens.

  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/applications`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const rows = await listApplications(tenantId, orgId);
      // Resolve the stage NAME and an applied date here rather than shipping raw
      // ids to the client.
      //
      // Found by looking at the rendered page: the Stage and Applied columns were
      // permanently "—". The deal exposes `stageId`, not `stageName`, so the
      // client was reading a field that does not exist; and `appliedAt` is
      // declared in APPLICATION_FIELD_DEFS but never written — the same
      // dead-schema class as `board`. A column that can only ever be empty is
      // worse than no column: it reads as missing DATA rather than as a missing
      // feature.
      const pipeline = (await resolveApplicationPipeline(tenantId, orgId)) ?? undefined;
      const stageNames = new Map((pipeline?.stages ?? []).map((s) => [s.stageId, s.name]));
      res.json({
        applications: rows.map((r) => ({
          ...r,
          stageName: stageNames.get(r.deal.stageId ?? '') ?? null,
          // The deal's own creation IS the moment the application was recorded.
          // `customFields.appliedAt` wins when a real submission wrote one.
          appliedAt: (r.deal.customFields as Record<string, unknown> | undefined)?.appliedAt ?? r.deal.createdAt ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${JOB_SEARCH_BASE}/orgs/:orgId/applications`, async (req, res, next) => {
    try {
      const { tenantId, orgId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const body = (req.body ?? {}) as {
        dealId?: unknown; digest?: Partial<JobDigest>; profile?: unknown; applicant?: unknown;
      };
      if (typeof body.dealId !== 'string' || !body.dealId.startsWith('deal:')) {
        res.status(400).json({ error: 'validation_error', message: 'dealId must be a `deal:`-prefixed string.' });
        return;
      }
      const result = await createApplication({
        tenantId, orgId, actor: user.userId, dealId: body.dealId,
        digest: normaliseDigest(body.digest),
        profile: normaliseProfile(body.profile),
        applicant: normaliseApplicant(body.applicant),
      });
      // An ineligible application is NOT an error — it is a decision, and the
      // caller needs the quoted reason. 200 with `eligible:false` says that;
      // a 4xx would conflate "we chose not to apply" with "you called this wrong".
      res.status(result.deal && !result.existed ? 201 : 200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── The career agent (ADR 0543 P1) ────────────────────────────────────────

  app.post(`${JOB_SEARCH_BASE}/orgs/:orgId/agent/provision`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      // Idempotent: a second call returns the same roster member and board
      // rather than a second agent.
      res.json(await provisionCareerAgent(tenantId));
    } catch (err) {
      next(err);
    }
  });

  // WF-JS-1 — queue one campaign pass as a card on the career agent's board.
  // Queuing is the ONLY thing this route does: execution stays with the
  // heartbeat loop (ranked pick → policy → budget → review-approval → run), so
  // there is no direct "run now" path around those gates. 409 `no_active_grant`
  // when nothing could submit; idempotent while an identical card is waiting.
  app.post(`${JOB_SEARCH_BASE}/orgs/:orgId/agent/queue-campaign`, async (req, res, next) => {
    try {
      const { tenantId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const result = await queueCampaignCard(tenantId, user.userId, Date.now());
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/agent/steering`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json(await getSteering(tenantId));
    } catch (err) {
      next(err);
    }
  });

  app.put(`${JOB_SEARCH_BASE}/orgs/:orgId/agent/steering`, async (req, res, next) => {
    try {
      const { tenantId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = (req.body ?? {}) as { goals?: unknown; policy?: unknown };
      res.json(await putSteering(tenantId, b, user.userId));
    } catch (err) {
      next(err);
    }
  });

/**
 * Attach the human title of each row's deal.
 *
 * `/grade-ux` finding: both panels rendered a raw `deal:9f3c…` id, which tells a
 * user nothing about WHICH application is waiting on them — the one fact they
 * need to act. One bulk read of the org's deals, joined in memory, rather than a
 * lookup per row.
 */
async function withDealTitles<T extends { dealId: string }>(
  tenantId: string,
  orgId: string,
  rows: readonly T[],
): Promise<Array<T & { dealTitle: string }>> {
  if (rows.length === 0) return [];
  const titles = new Map((await listDeals(tenantId, orgId, {})).map((d) => [d.dealId, d.title]));
  // Falls back to the id rather than to an empty string: an unlabelled row is
  // still better than a row that looks like it has no subject at all.
  return rows.map((r) => ({ ...r, dealTitle: titles.get(r.dealId) ?? r.dealId }));
}

/**
 * Map an issuance refusal to a response.
 *
 * Both are 4xx and NEITHER is a 500: "this host never sent that application" and
 * "that is not your application" are answers, not faults. They stay DISTINCT
 * because the applicant is the owner of this data and needs to know which one it
 * was — unlike the public verifier, for whom the two would be an oracle.
 */
function sendRefusal(res: Response, reason: IssueRefusal): void {
  if (reason === 'not-the-subject') {
    res.status(403).json({ error: 'forbidden', message: 'An attestation states a person’s own conduct; only they can issue it.' });
    return;
  }
  res.status(404).json({ error: 'not_found', message: 'This host has no record of sending that application.' });
}

  // ── Attestations (ADR 0544) ───────────────────────────────────────────────

  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/attestations`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ attestations: await listAttestations(tenantId) });
    } catch (err) {
      next(err);
    }
  });

  // What WOULD be disclosed — the read that makes the consent real (matrix row
  // 10). Same projection as the public route, so the applicant reads exactly
  // what the employer will.
  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/applications/:dealId/attestation-preview`, async (req, res, next) => {
    try {
      const { tenantId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const out = await previewAttestation({
        tenantId, dealId: req.params.dealId ?? '', actingUser: user.userId, now: Date.now(),
      });
      if ('refused' in out) { sendRefusal(res, out.refused); return; }
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  app.post(`${JOB_SEARCH_BASE}/orgs/:orgId/attestations`, async (req, res, next) => {
    try {
      const { tenantId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = (req.body ?? {}) as { dealId?: unknown };
      if (typeof b.dealId !== 'string' || !b.dealId) {
        res.status(400).json({ error: 'validation_error', message: 'dealId is required.' });
        return;
      }
      // NO campaignId, and that is the fix: P2 accepted one here, which let any
      // campaign's numbers be attached to any application. It is now derived
      // from the audit row that recorded the submission.
      const out = await issueAttestation({ tenantId, dealId: b.dealId, issuedBy: user.userId, now: Date.now() });
      if ('refused' in out) { sendRefusal(res, out.refused); return; }
      // The raw token is returned ONCE, here. It is never readable again.
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${JOB_SEARCH_BASE}/orgs/:orgId/attestations/:attestationId`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const ok = await revokeAttestation(tenantId, req.params.attestationId ?? '', Date.now());
      if (!ok) {
        res.status(404).json({ error: 'not_found', message: 'Attestation not found or already revoked.' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Lifecycle (ADR 0546) ──────────────────────────────────────────────────
  //
  // ORG-scoped, unlike the ADR 0545 answer bank. These are about the
  // WORKSPACE's applications — which are CRM deals (ADR 0540) and already
  // org-scoped — rather than about a person's private answers. The distinction
  // is deliberate: the answer bank holds a salary expectation, this holds a
  // pipeline.

  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/funnel`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json(await buildFunnelReport(tenantId, orgId));
    } catch (err) { next(err); }
  });

  // JSUX-FUN-2 (R3) — the funnel page fired THREE reads per mount, the exact
  // fan-out shape the rate-limit note warns about. One bundle route with the
  // SAME per-part predicates: it composes the three existing reads server-side
  // and the page makes ONE request. The individual routes stay (other
  // consumers + the node lane read them singly).
  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/funnel-bundle`, async (req, res, next) => {
    try {
      const { tenantId, orgId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const [report, followUpRows, draftRows] = await Promise.all([
        buildFunnelReport(tenantId, orgId),
        dueFollowUps(tenantId, user.userId, Date.now()),
        listDrafts(tenantId, user.userId),
      ]);
      const [followUps, drafts] = await Promise.all([
        withDealTitles(tenantId, orgId, followUpRows),
        withDealTitles(tenantId, orgId, draftRows),
      ]);
      res.json({ report, followUps, drafts });
    } catch (err) { next(err); }
  });

  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/follow-ups`, async (req, res, next) => {
    try {
      const { tenantId, orgId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const rows = await dueFollowUps(tenantId, user.userId, Date.now());
      res.json({ followUps: await withDealTitles(tenantId, orgId, rows) });
    } catch (err) { next(err); }
  });

  app.post(`${JOB_SEARCH_BASE}/orgs/:orgId/follow-ups/:dealId/:stage/complete`, async (req, res, next) => {
    try {
      const { tenantId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const ok = await completeFollowUp(tenantId, user.userId, req.params.dealId ?? '', req.params.stage ?? '', Date.now());
      if (!ok) { res.status(404).json({ error: 'not_found', message: 'No open follow-up there.' }); return; }
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/drafts`, async (req, res, next) => {
    try {
      const { tenantId, orgId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ drafts: await withDealTitles(tenantId, orgId, await listDrafts(tenantId, user.userId)) });
    } catch (err) { next(err); }
  });

  /**
   * Approve a draft. Records a human decision — it does NOT send anything, and
   * there is no route that does (ADR 0546 D2).
   */
  app.post(`${JOB_SEARCH_BASE}/orgs/:orgId/drafts/:dealId/:kind/approve`, async (req, res, next) => {
    try {
      const { tenantId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const kind = req.params.kind as DraftKind;
      if (!['interview-reply', 'prep-sheet', 'warm-intro'].includes(kind)) {
        res.status(400).json({ error: 'validation_error', message: 'Unknown draft kind.' });
        return;
      }
      const out = await approveDraft(tenantId, user.userId, req.params.dealId ?? '', kind, user.userId, Date.now());
      if (!out) { res.status(404).json({ error: 'not_found', message: 'Draft not found.' }); return; }
      res.json({ draft: out });
    } catch (err) { next(err); }
  });

  // ── Listings (ADR 0542 P5) ────────────────────────────────────────────────

  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/listings`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const rows = await listListings(tenantId);
      // Project to the SPA's shape; the kernel row carries storage internals the
      // client has no use for and should not learn.
      res.json({
        listings: rows.map((r) => {
          const v = (r.values ?? {}) as Record<string, unknown>;
          return {
            listingId: r.entityId,
            title: String(v.title ?? ''),
            companyName: String(v.company_name ?? ''),
            location: typeof v.location === 'string' ? v.location : null,
            remote: typeof v.remote === 'boolean' ? v.remote : null,
            sourceBoard: typeof v.source_board === 'string' ? v.source_board : null,
            sourceUrl: typeof v.source_url === 'string' ? v.source_url : null,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/listings/visibility`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ public: await listingsArePublic(tenantId) });
    } catch (err) {
      next(err);
    }
  });

  app.put(`${JOB_SEARCH_BASE}/orgs/:orgId/listings/visibility`, async (req, res, next) => {
    try {
      const { tenantId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const wanted = (req.body as { public?: unknown } | undefined)?.public;
      if (typeof wanted !== 'boolean') {
        res.status(400).json({ error: 'validation_error', message: '`public` must be a boolean.' });
        return;
      }
      // ADR 0542 D4 — publishing is a DELIBERATE act, so it is an explicit PUT
      // rather than a side effect of any other write.
      const ok = await setListingsPublic(tenantId, wanted, user.userId);
      if (!ok) {
        res.status(404).json({ error: 'not_found', message: 'No listings to publish yet.' });
        return;
      }
      res.json({ public: wanted });
    } catch (err) {
      next(err);
    }
  });


  // ── Apply grants (ADR 0541 P4) ────────────────────────────────────────────

  app.get(`${JOB_SEARCH_BASE}/orgs/:orgId/grants`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const rows = (await applyGrants.listByPrefix(`${tenantId}:`)).filter((g) => g.orgId === orgId);
      // Projected, not returned raw: a grant is an authority record and the list
      // is what the "what have I authorised" surface renders.
      res.json({
        grants: rows.map((g) => ({
          grantId: g.grantId, subjectId: g.subjectId, grantedBy: g.grantedBy, campaignId: g.campaignId,
          maxSubmits: g.maxSubmits, submitsUsed: g.submitsUsed,
          maxPrepared: g.maxPrepared, preparedUsed: g.preparedUsed,
          ratePerHour: g.ratePerHour, tiers: g.tiers, origins: g.origins,
          expiresAt: g.expiresAt, revokedAt: g.revokedAt ?? null, createdAt: g.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${JOB_SEARCH_BASE}/orgs/:orgId/grants`, async (req, res, next) => {
    try {
      const { tenantId, orgId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      // `grantedBy` is the ACTING USER, never a body field: a grant records who
      // authorised it, and letting a caller name someone else would forge consent.
      const grant = await createApplyGrant({
        tenantId,
        orgId,
        subjectId: typeof b.subjectId === 'string' && b.subjectId ? b.subjectId : user.userId,
        grantedBy: user.userId,
        campaignId: String(b.campaignId ?? ''),
        maxSubmits: b.maxSubmits as number,
        maxPrepared: b.maxPrepared as number,
        ratePerHour: b.ratePerHour as number,
        ...(Array.isArray(b.tiers) ? { tiers: (b.tiers as string[]).filter((x): x is 'A' | 'B' => x === 'A' || x === 'B') } : {}),
        origins: Array.isArray(b.origins) ? (b.origins as string[]) : [],
        resumePolicy: String(b.resumePolicy ?? 'default'),
        expiresAt: String(b.expiresAt ?? ''),
      });
      res.status(201).json({ grant });
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${JOB_SEARCH_BASE}/orgs/:orgId/grants/:grantId`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      // Revocation is immediate and does not require the campaign to stop (D5).
      const ok = await revokeApplyGrant(tenantId, orgId, req.params.grantId ?? '', Date.now());
      if (!ok) {
        res.status(404).json({ error: 'not_found', message: 'Grant not found or already revoked.' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.post(`${JOB_SEARCH_BASE}/orgs/:orgId/applications/:dealId/advance`, async (req, res, next) => {
    try {
      const { tenantId, orgId, user } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const stage = (req.body as { stage?: unknown } | undefined)?.stage;
      if (typeof stage !== 'string' || stage.trim() === '') {
        res.status(400).json({ error: 'validation_error', message: 'stage is required.' });
        return;
      }
      const deal = await advanceApplication(tenantId, orgId, req.params.dealId ?? '', stage, user.userId);
      if (!deal) {
        // Unknown deal AND unknown stage both land here as 404 — a caller must
        // not be able to probe which dealIds exist in another org by the code.
        res.status(404).json({ error: 'not_found', message: 'Application or stage not found.' });
        return;
      }
      res.json({ deal });
    } catch (err) {
      next(err);
    }
  });
}

const FEATURE = { toggleId: JOB_SEARCH_TOGGLE, label: JOB_SEARCH_LABEL };

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Closed-world normalisation: an unknown field in the body is DROPPED, never
 *  stored. The digest reaches a model later (ADR 0543), so accepting arbitrary
 *  caller keys here would be an injection surface. */
function normaliseDigest(d: Partial<JobDigest> | undefined): Omit<JobDigest, 'dealId' | 'tenantId' | 'version'> {
  const sponsorship = d?.sponsorship;
  return {
    title: str(d?.title, 'Untitled role'),
    companyName: str(d?.companyName, 'Unknown company'),
    location: typeof d?.location === 'string' ? d.location : null,
    remote: typeof d?.remote === 'boolean' ? d.remote : null,
    skills: strArr(d?.skills),
    requirements: strArr(d?.requirements),
    responsibilities: strArr(d?.responsibilities),
    descriptionExcerpt: str(d?.descriptionExcerpt),
    employmentType:
      d?.employmentType === 'w2' || d?.employmentType === '1099' || d?.employmentType === 'contract' || d?.employmentType === 'internship'
        ? d.employmentType
        : 'unknown',
    // Anything not explicitly 'offered'/'not-offered' is SILENT — the never-skip
    // default. A malformed value must never read as "no sponsorship".
    sponsorship: sponsorship === 'offered' || sponsorship === 'not-offered' ? sponsorship : 'silent',
    citizenshipRequirementQuote: typeof d?.citizenshipRequirementQuote === 'string' ? d.citizenshipRequirementQuote : null,
    clearanceRequirementQuote: typeof d?.clearanceRequirementQuote === 'string' ? d.clearanceRequirementQuote : null,
    sponsorshipQuote: typeof d?.sponsorshipQuote === 'string' ? d.sponsorshipQuote : null,
    salaryMin: num(d?.salaryMin),
    salaryMax: num(d?.salaryMax),
    currency: typeof d?.currency === 'string' ? d.currency : null,
    sourceUrl: typeof d?.sourceUrl === 'string' ? d.sourceUrl : null,
    capturedAt: str(d?.capturedAt, new Date(0).toISOString()),
  };
}

function normaliseProfile(p: unknown) {
  const o = (p ?? {}) as Record<string, unknown>;
  return {
    skills: strArr(o.skills),
    targetTitles: strArr(o.targetTitles),
    salaryFloor: num(o.salaryFloor),
    wantsRemote: typeof o.wantsRemote === 'boolean' ? o.wantsRemote : null,
  };
}

/** Defaults are the SAFE direction: an applicant whose constraints were not
 *  supplied is assumed to need nothing, so a missing field cannot invent a
 *  disqualification the caller never asserted. */
function normaliseApplicant(a: unknown) {
  const o = (a ?? {}) as Record<string, unknown>;
  return {
    requiresSponsorship: o.requiresSponsorship === true,
    meetsCitizenshipRequirement: o.meetsCitizenshipRequirement !== false,
    holdsRequiredClearance: o.holdsRequiredClearance !== false,
  };
}

/**
 * ADR 0544 D3/P3 — the PUBLIC verification surface.
 *
 * Registered on a SIBLING prefix (`public-attestations`), never nested under the
 * authed `/job-search` namespace — the `public-forms` ≠ `forms` rule. Nesting it
 * would put an anonymous route inside a namespace whose every other path is
 * authenticated, which is exactly how a public hole gets opened by accident.
 *
 * The verifier is an unauthenticated stranger. Requiring onboarding would make
 * the feature unusable; requiring auth would tell us who is checking, which is
 * not ours to know.
 */
export function registerPublicAttestationRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get('/v1/host/openwop-app/public-attestations/:token', async (req, res, next) => {
    try {
      const token = req.params.token ?? '';
      // Payload cap BEFORE any lookup: a token is a bounded secret, and an
      // unbounded path segment on an anonymous route is free work for anyone.
      if (token.length > 200) {
        res.status(404).json(UNIFORM_NOT_FOUND);
        return;
      }
      const view = await resolveAttestation(token);
      if (!view) {
        // ONE answer for unknown, revoked, malformed and cross-tenant. A caller
        // that could tell them apart would learn that an attestation once
        // existed and was withdrawn — a fact about the applicant they were never
        // given.
        res.status(404).json(UNIFORM_NOT_FOUND);
        return;
      }
      res.json(view);
    } catch (err) {
      next(err);
    }
  });
}

/** Frozen so every failure is byte-identical, not merely similar. */
const UNIFORM_NOT_FOUND = Object.freeze({ error: 'not_found', message: 'Not found.' });
