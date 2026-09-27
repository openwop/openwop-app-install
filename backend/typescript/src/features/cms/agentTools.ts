/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the CMS agents' REAL conversational tools.
 *
 * The `feature.cms.agents` pack (localizer + content-editor, ADR 0204 C6)
 * allowlisted `openwop:feature.cms.nodes.<verb>` — WORKFLOW-node typeIds, which
 * the live dispatch lanes (`conversationToolLoop` / `agentRunnerNode`) intersect
 * against `builtinAgentToolIds()` and silently DROP (they are not registered
 * agent tools). So both agents loaded, responded, and could call nothing — the
 * exact founding shape of ADR 0308 / ADR 0358. These registrations make the
 * exchange real: the same governed capabilities the `feature.cms.nodes` pack
 * projects for a WORKFLOW are now offerable to a CHAT turn, over the same
 * `ctx.features.cms` surface owner (`buildCmsSurface`), with the org-RBAC gate
 * the HTTP editor path enforces added on top (the surface trusts a run's tenant;
 * a chat turn must prove the acting user's org access — the app-builder
 * `resolveOrgScope` precedent, mirroring `requireCmsScope` → `requireOrgScope`).
 *
 * Clean ids (`openwop:cms.<verb>`, the documents/app-builder convention), NOT
 * the node-typeId-shaped ids the pack used to allowlist: those never resolved so
 * nothing depends on them, and the node-projection namespace
 * (`openwop:<typeId>`) stays unambiguous — the workflow nodes keep their ids.
 *
 * Governed-write posture (unchanged from the node pack + the Phase-C review):
 * the write verbs DRAFT and SUBMIT only; there is NO publish tool — publishing
 * stays a human action (route or the ADR 0066 ApprovalsInbox). Reads FAIL EMPTY
 * without an acting user (no system/scheduled turn enumerates a tenant's pages —
 * the kicktodo-core read-tool posture); writes fail TYPED so the agent loop can
 * repair.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { ManagedProviderError } from '../../providers/managedProvider.js';
import { LOCALE_RE } from '../../host/i18n/index.js';
import { buildCmsSurface } from './surface.js';
import { translateSectionData } from './translate.js';
import { getLocaleGrant, SECTION_TYPES, type SectionType } from './cmsService.js';

export const CMS_GET_PAGE_TOOL_ID = 'openwop:cms.get-page';
export const CMS_LIST_PAGES_TOOL_ID = 'openwop:cms.list-pages';
export const CMS_GET_DRAFT_PAGE_TOOL_ID = 'openwop:cms.get-draft-page';
export const CMS_TRANSLATE_SECTION_TOOL_ID = 'openwop:cms.translate-section';
export const CMS_UPDATE_SECTION_DRAFT_TOOL_ID = 'openwop:cms.update-section-draft';
export const CMS_SUBMIT_PAGE_TOOL_ID = 'openwop:cms.submit-page';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must say what failed and what to do next. */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

function ok(payload: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify(payload) };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Per-tenant `cms-localization` toggle (dynamic, fail-closed) — the SAME gate
 *  the `/translate-section` route enforces (`requireFeatureEnabled`). CMS itself
 *  is always-on (ADR 0027), so only the localization capability is gated. */
async function cmsLocalizationEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne('cms-localization', { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/** The org RBAC gate the HTTP editor path applies via `requireCmsScope` →
 *  `requireOrgScope` (`resolveEffectiveAccess`), reproduced for a chat turn: the
 *  surface trusts a run's tenant, so a conversational call must prove the acting
 *  user's org access. Explicit `orgId`, else the workspace's sole org; with
 *  several the model must name one. (The reserved system-site superadmin
 *  exception is deliberately NOT reachable from chat — an agent tool never
 *  confers host-site authority.) */
async function resolveOrgScope(
  scope: BundleScope,
  orgIdInput: string | undefined,
  needed: 'workspace:read' | 'workspace:write',
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return toolError('acting_user_required', 'CMS pages can only be read or edited from a human-initiated turn.');
  }
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) {
    return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
  }
  if (!orgs.some((o) => o.orgId === orgId)) return toolError('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes(needed)) {
    return toolError('forbidden_scope', `The user does not have ${needed === 'workspace:write' ? 'write' : 'read'} access to that organization.`);
  }
  return { orgId, actingUserId };
}

/** Narrow an unknown surface field to a string, else the fallback. */
function strField(v: unknown, fallback: string): string {
  return typeof v === 'string' && v ? v : fallback;
}

/** Catch a surface `OpenwopError` (non-draft 409, translator-grant 403) and hand
 *  it back to the loop as a typed, repairable result rather than a raw throw. */
function fromSurfaceError(err: unknown): ToolResult {
  if (err instanceof OpenwopError) return toolError(err.code, err.message, err.details);
  throw err;
}

export function registerCmsAgentTools(): void {
  // ── Reads (workspace:read; FAIL EMPTY without an acting user) ─────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CMS_GET_PAGE_TOOL_ID,
      description:
        'Read a PUBLISHED CMS page resolved for a locale — the base content the localizer translates FROM. '
        + 'Inputs: { slug, locale?, orgId? } → { page: { slug, title, sections: [{ sectionId, sectionType, data }] } | null, locale }. '
        + 'Omit `locale` for the org base locale. Published-only; a draft/unknown slug returns page:null.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The page slug.' },
          locale: { type: 'string', description: 'Optional BCP-47 target locale (defaults to the org base locale).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['slug'],
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return ok({ page: null, locale: null });
      const slug = str(input.slug);
      if (!slug) return toolError('validation_error', '`slug` is required.');
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in gate) return gate;
      const surface = buildCmsSurface(scope);
      const locale = str(input.locale);
      const getPageFn = surface.getPage;
      if (!getPageFn) return toolError('surface_unavailable', 'cms surface method getPage is not available.');
      const res = await getPageFn({ orgId: gate.orgId, slug, ...(locale ? { locale } : {}) });
      return ok({ page: res.page, locale: res.locale });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CMS_LIST_PAGES_TOOL_ID,
      description:
        'List an org\'s PUBLISHED CMS pages (titles/slugs/status, not section bodies). '
        + 'Inputs: { orgId? } → { pages: [{ pageId, slug, title, status }] }.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return ok({ pages: [] });
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in gate) return gate;
      const surface = buildCmsSurface(scope);
      const listPagesFn = surface.listPages;
      if (!listPagesFn) return toolError('surface_unavailable', 'cms surface method listPages is not available.');
      const res = await listPagesFn({ orgId: gate.orgId });
      return ok({ pages: res.pages });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 review H4 — the READ-BEFORE-WRITE body for CMS editing, and its
    // `sections[]` is the closed set of legal `sectionId`s the WRITE tool
    // enforces: `cms.update-section-draft` requires a `sectionId` and
    // `surface.updateSectionDraft` returns `{updated:false,
    // reason:'section_not_found'}` for anything not in that array — a typed
    // refusal, no write. Under `lossy` a page with more than five sections
    // elides its middle, so the model patches a section it was never shown, or
    // reports a real section as missing. (Its published sibling
    // `cms.get-page` is NOT exempt — nothing writes against a published
    // section id; see the adjudication table in
    // test/schema-read-exemption-completeness.test.ts.)
    schemaCarrying: true,
    def: {
      name: CMS_GET_DRAFT_PAGE_TOOL_ID,
      description:
        'Read a DRAFT/in-review page\'s RAW sections (base data + which overlay locales already exist) — the '
        + 'read-before-write for editing. Inputs: { pageId, orgId? } → { page: { pageId, slug, title, status, '
        + 'sections: [{ sectionId, sectionType, data, locales }] } | null }.',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'The page id.' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['pageId'],
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return ok({ page: null });
      const pageId = str(input.pageId);
      if (!pageId) return toolError('validation_error', '`pageId` is required.');
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in gate) return gate;
      const surface = buildCmsSurface(scope);
      const getDraftPageFn = surface.getDraftPage;
      if (!getDraftPageFn) return toolError('surface_unavailable', 'cms surface method getDraftPage is not available.');
      const res = await getDraftPageFn({ orgId: gate.orgId, pageId });
      return ok({ page: res.page });
    },
  });

  // ── Generative draft: translate a section (workspace:write + localization) ─
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CMS_TRANSLATE_SECTION_TOOL_ID,
      description:
        'Draft a structure-preserving per-locale overlay for one section\'s base `data` (JSON-in / JSON-out; keys '
        + 'preserved, only human-readable VALUES translated; URLs / media tokens / {{variables}} left intact). '
        + 'Inputs: { sectionType, data, targetLocale, orgId? } → { overlay, targetLocale }. The overlay is a DRAFT '
        + 'to review and save via update-section-draft — it is NOT persisted here. Requires content-localization to '
        + 'be enabled for the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          sectionType: { type: 'string', description: `One of: ${SECTION_TYPES.join(', ')}.` },
          data: { type: 'object', description: 'The section\'s base data object to translate.' },
          targetLocale: { type: 'string', description: 'BCP-47 target locale (e.g. "es", "pt-BR").' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['sectionType', 'data', 'targetLocale'],
      },
    },
    async run(input, scope) {
      if (!(await cmsLocalizationEnabled(scope.tenantId, scope.actingUserId))) {
        return toolError('feature_disabled', 'Content localization is not enabled for this workspace — tell the user AI translation is unavailable here.');
      }
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in gate) return gate;
      const sectionType = str(input.sectionType);
      if (!sectionType || !SECTION_TYPES.includes(sectionType as SectionType)) {
        return toolError('validation_error', `\`sectionType\` must be one of: ${SECTION_TYPES.join(', ')}.`);
      }
      const targetLocale = str(input.targetLocale);
      if (!targetLocale || !LOCALE_RE.test(targetLocale)) {
        return toolError('validation_error', 'Invalid `targetLocale` (expected BCP-47, e.g. "es", "pt-BR").');
      }
      // ADR 0205 D1 — a translator may only AI-draft into granted locales (the
      // same narrowing the route applies before dispatching the translation).
      const grant = await getLocaleGrant(scope.tenantId, gate.orgId, gate.actingUserId);
      if (grant && !grant.locales.includes(targetLocale)) {
        return toolError('forbidden_scope', `Your translator grant is limited to [${grant.locales.join(', ')}].`, { grantedLocales: grant.locales });
      }
      const data = (typeof input.data === 'object' && input.data !== null ? input.data : {}) as Record<string, unknown>;
      try {
        const overlay = await translateSectionData(scope.tenantId, sectionType as SectionType, data, targetLocale);
        return ok({ overlay, targetLocale });
      } catch (err) {
        // ADR 0592 §7/§9 (CMSL-12) — mirror the ROUTE's discrimination instead
        // of a catch-all: provider-unavailable and unusable-model-output are
        // honest degrades the agent can explain; anything else is a genuine
        // internal error and must NOT masquerade as "provider down".
        if (err instanceof ManagedProviderError) {
          return toolError('translation_unavailable', 'Automatic translation is unavailable right now — the section must be translated manually.');
        }
        if (err instanceof OpenwopError && err.code === 'translation_invalid') {
          return toolError('translation_invalid', 'Automatic translation returned unusable output (one repair was attempted) — the section must be translated manually.');
        }
        if (err instanceof OpenwopError && err.code === 'internal_error' && err.httpStatus === 503) {
          // resolveHeadlessAi found no text-capable provider — provider-down.
          return toolError('translation_unavailable', 'No AI provider is available for translation right now — the section must be translated manually.');
        }
        throw err;
      }
    },
  });

  // ── Governed writes (workspace:write; DRAFT + SUBMIT only, never publish) ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CMS_UPDATE_SECTION_DRAFT_TOOL_ID,
      description:
        'Patch ONE section of a DRAFT page — its base `data`, or one per-locale overlay when `locale` is set. '
        + 'Inputs: { pageId, sectionId, data, locale?, orgId? } → { updated, locale? }. Works ONLY on draft pages '
        + '(a non-draft page is a typed error — do not try to work around it); the write is sanitized like any '
        + 'editor save. Read the page with get-draft-page first.',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'The DRAFT page id.' },
          sectionId: { type: 'string', description: 'The section to patch.' },
          data: { type: 'object', description: 'The fields to set (base data, or the overlay when `locale` is set).' },
          locale: { type: 'string', description: 'Optional BCP-47 locale — set to write a per-locale overlay instead of base data.' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['pageId', 'sectionId', 'data'],
      },
    },
    async run(input, scope) {
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in gate) return gate;
      const pageId = str(input.pageId);
      const sectionId = str(input.sectionId);
      if (!pageId || !sectionId) return toolError('validation_error', '`pageId` and `sectionId` are required.');
      const locale = str(input.locale);
      if (locale && !LOCALE_RE.test(locale)) return toolError('validation_error', 'Invalid `locale` (expected BCP-47).');
      const data = (typeof input.data === 'object' && input.data !== null ? input.data : {}) as Record<string, unknown>;
      const surface = buildCmsSurface(scope);
      try {
        const updateSectionDraftFn = surface.updateSectionDraft;
      if (!updateSectionDraftFn) return toolError('surface_unavailable', 'cms surface method updateSectionDraft is not available.');
      const res = await updateSectionDraftFn({ orgId: gate.orgId, pageId, sectionId, data, ...(locale ? { locale } : {}) });
        if (!res.updated) {
          return toolError(strField(res.reason, 'not_updated'), `The section was not updated (${strField(res.reason, 'unknown reason')}).`);
        }
        return ok({ updated: true, ...(res.locale ? { locale: res.locale } : {}) });
      } catch (err) {
        return fromSurfaceError(err);
      }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CMS_SUBMIT_PAGE_TOOL_ID,
      description:
        'Submit a DRAFT page for editorial review — your TERMINAL action. Inputs: { pageId, orgId? } → '
        + '{ submitted, status }. This ALWAYS queues an Approvals-inbox row for '
        + 'a human. You CANNOT publish; after submitting, tell the user it is awaiting human review.',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'The DRAFT page id.' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['pageId'],
      },
    },
    async run(input, scope) {
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in gate) return gate;
      const pageId = str(input.pageId);
      if (!pageId) return toolError('validation_error', '`pageId` is required.');
      const surface = buildCmsSurface(scope);
      try {
        const submitPageFn = surface.submitPage;
      if (!submitPageFn) return toolError('surface_unavailable', 'cms surface method submitPage is not available.');
      const res = await submitPageFn({ orgId: gate.orgId, pageId });
        if (!res.submitted) {
          return toolError(strField(res.reason, 'not_submitted'), `The page was not submitted (${strField(res.reason, 'unknown reason')}).`);
        }
        return ok({ submitted: true, status: res.status, note: 'The page is awaiting human review — tell the user a human must approve and publish it.' });
      } catch (err) {
        return fromSurfaceError(err);
      }
    },
  });
}
