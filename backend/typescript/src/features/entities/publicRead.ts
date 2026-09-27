/**
 * The ONE anonymous entity-read gate (ADR 0407 D3) — extracted from the
 * `public-entities` route so the crawler prerender resolver and the public
 * route share IDENTICAL semantics: published + `publicRead` types only, LIVE
 * rows only (`excludeDrafts`), scalar projection (`toPublicEntity`), locale-
 * resolved. Sharing this gate is what makes server-side prerender no-cloaking
 * BY CONSTRUCTION — a crawler literally cannot see a draft or non-public row.
 */
import { OpenwopError } from '../../types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listOrgs } from '../../host/accessControlService.js';
import { getContentLanguageSettings } from '../../host/contentLocales.js';
import { LOCALE_RE, negotiateLocale } from '../../host/i18n/index.js';
import {
  getEntity,
  getEntityType,
  queryEntities,
  toPublicEntity,
  type PublicEntity,
} from './entitiesService.js';
import {
  hasContentSectionResolver,
  registerContentSectionResolver,
  type ContentSectionResolver,
  type ResolvedContentSection,
} from '../../host/contentDataSources.js';

const PUBLIC_LIMIT_MAX = 50;
const notFound = (): OpenwopError => new OpenwopError('not_found', 'Not found.', 404, {});

/** ADR 0406 D5 — the anonymous read's locale context (shared by route + resolver).
 *  Undefined when localization is off / no org / no authored locales (base
 *  values, byte-identical to pre-localization). `explicit` (route `?locale=`)
 *  wins; else negotiate `acceptLanguage`. Anchor: the tenant's primary org. */
export async function resolveEntityPublicLocale(
  tenantId: string,
  pref: { explicit?: string; acceptLanguage?: string },
): Promise<{ negotiated: string; baseLocale: string } | undefined> {
  if (!(await resolveOne('entities-localization', { tenantId }))?.enabled) return undefined;
  const orgId = (await listOrgs(tenantId))[0]?.orgId;
  if (!orgId) return undefined;
  const settings = await getContentLanguageSettings(tenantId, orgId);
  if (settings.supportedLocales.length === 0) return undefined;
  if (pref.explicit !== undefined) {
    if (!LOCALE_RE.test(pref.explicit)) {
      throw new OpenwopError('validation_error', `Invalid locale \`${pref.explicit}\` (expected BCP-47).`, 400, { locale: pref.explicit });
    }
    return { negotiated: pref.explicit, baseLocale: settings.baseLocale };
  }
  const negotiated = negotiateLocale(pref.acceptLanguage ?? '', [settings.baseLocale, ...settings.supportedLocales], settings.baseLocale);
  return { negotiated, baseLocale: settings.baseLocale };
}

/** The public-read type gate: published + publicRead, else a uniform 404
 *  (also 404 when the `entities` toggle is off / type absent — no existence
 *  leak). Returns the type. */
async function gatePublicType(tenantId: string, projectId: string | undefined, typeName: string) {
  const assignment = await resolveOne('entities', { tenantId });
  if (!assignment || !assignment.enabled) throw notFound();
  const type = await getEntityType(tenantId, projectId, typeName);
  // ADR 0409 Phase 1 — lock 2 of 2: a `neverPublic` type (CRM records) is
  // refused OUTRIGHT here, the SINGLE funnel every anonymous path routes
  // through (both public routes + the crawler prerender resolver), even if
  // `publicRead` were somehow force-set in storage. Defense-in-depth over the
  // `updateEntityType` refusal (lock 1).
  if (!type || type.status !== 'published' || type.publicRead !== true || type.neverPublic) throw notFound();
  return type;
}

export interface PublicEntityQuery {
  tenantId: string;
  projectId?: string;
  typeName: string;
  filters?: unknown;
  sort?: { key: string; dir?: 'asc' | 'desc' };
  termId?: string;
  limit?: number;
  cursor?: string;
  locale?: { negotiated: string; baseLocale: string };
}

/** Anonymous LIST read — throws a uniform 404 unless the type is publicly
 *  readable; returns LIVE rows only, scalar-projected + locale-resolved. */
export async function readPublicEntities(input: PublicEntityQuery): Promise<{ entities: PublicEntity[]; nextCursor?: string }> {
  await gatePublicType(input.tenantId, input.projectId, input.typeName);
  const page = await queryEntities({
    tenantId: input.tenantId,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    typeName: input.typeName,
    ...(input.filters !== undefined ? { filters: input.filters } : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : {}),
    ...(input.termId !== undefined ? { termId: input.termId } : {}),
    limit: Math.min(input.limit ?? 20, PUBLIC_LIMIT_MAX),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    excludeDrafts: true,
  });
  return {
    entities: page.entities.map((rec) => toPublicEntity(rec, input.locale)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/** Anonymous single-entity read — 404 unless publicly readable; null for a
 *  missing OR draft row (a draft is invisible to the anonymous surface). */
export async function readPublicEntity(input: {
  tenantId: string;
  projectId?: string;
  typeName: string;
  entityId: string;
  locale?: { negotiated: string; baseLocale: string };
}): Promise<PublicEntity | null> {
  await gatePublicType(input.tenantId, input.projectId, input.typeName);
  const rec = await getEntity({
    tenantId: input.tenantId,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    typeName: input.typeName,
    entityId: input.entityId,
  });
  if (!rec || rec.status === 'draft') return null;
  return toPublicEntity(rec, input.locale);
}

// ─── Content-section resolvers (ADR 0407 D3) ────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * ADR 0593 §C9 (review, `CMSA-12` cross-tenant half) — a section may only
 * resolve entities from ITS OWN PAGE'S tenant.
 *
 * `ContentResolveContext.pageTenantId` was threaded in by the prerenderer
 * (`prerenderService.ts`) and never read, while the resolvers took the tenant
 * from `data.tenantId` — a field a `workspace:write` editor controls. So a
 * section could embed another tenant's rows into an approved published page's
 * crawler HTML and JSON-LD. `readPublicEntities` still gates
 * `published + publicRead`, so this is a cross-tenant EMBED of already-public
 * rows rather than a data leak — but "already public over there" is not consent
 * to appear as this org's content, and the page's own approval gate cannot see
 * a row it does not own.
 *
 * The context is advisory-by-absence: when the caller does not supply a page
 * tenant (no page context) there is nothing to compare and the resolver
 * proceeds, which is why the WRITE side refuses a foreign tenant too — the SPA
 * lane reads `data.tenantId` straight from the section and never passes through
 * here at all, so a read-only cure would make the crawler see less than a human.
 */
function sameTenantOrNull(dataTenantId: string, ctx: { pageTenantId?: string }): boolean {
  if (!ctx.pageTenantId) return true;
  return dataTenantId === ctx.pageTenantId;
}

/** Build the resolved item list for an `entityList` section — the SAME data,
 *  gate, and tenant the SPA renderer resolves (SPA reads `data.tenantId`), so
 *  crawler HTML == what a human sees. */
const entityListResolver: ContentSectionResolver = async (data, ctx): Promise<ResolvedContentSection | null> => {
  const tenantId = str(data.tenantId);
  const typeName = str(data.typeName);
  const titleField = str(data.titleField);
  if (!tenantId || !typeName || !titleField) return null;
  if (!sameTenantOrNull(tenantId, ctx)) return null; // §C9 CMSA-12
  const bodyField = str(data.bodyField);
  const sortKey = str(data.sortKey);
  const sortDir = data.sortDir === 'asc' || data.sortDir === 'desc' ? data.sortDir : undefined;
  const filters =
    str(data.filterKey) && str(data.filterValue)
      ? [{ key: str(data.filterKey), op: 'eq', value: str(data.filterValue) }]
      : undefined;
  const loc = await resolveEntityPublicLocale(tenantId, ctx.locale ? { acceptLanguage: ctx.locale } : {}).catch(() => undefined);
  const res = await readPublicEntities({
    tenantId,
    typeName,
    ...(filters ? { filters } : {}),
    ...(sortKey ? { sort: { key: sortKey, ...(sortDir ? { dir: sortDir } : {}) } } : {}),
    ...(str(data.termId) ? { termId: str(data.termId) } : {}),
    limit: typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : 6,
    ...(loc ? { locale: loc } : {}),
  });
  const items = res.entities
    .map((e) => {
      const title = e.values[titleField];
      const body = bodyField ? e.values[bodyField] : undefined;
      return {
        title: title === undefined || title === null ? '' : String(title),
        ...(body !== undefined && body !== null && String(body) ? { body: String(body) } : {}),
      };
    })
    .filter((i) => i.title.length > 0);
  return { items };
};

/** One-entity resolver for `entityDetail`. */
const entityDetailResolver: ContentSectionResolver = async (data, ctx): Promise<ResolvedContentSection | null> => {
  const tenantId = str(data.tenantId);
  const typeName = str(data.typeName);
  const entityId = str(data.entityId);
  const titleField = str(data.titleField);
  if (!tenantId || !typeName || !entityId || !titleField) return null;
  if (!sameTenantOrNull(tenantId, ctx)) return null; // §C9 CMSA-12
  const bodyField = str(data.bodyField);
  const loc = await resolveEntityPublicLocale(tenantId, ctx.locale ? { acceptLanguage: ctx.locale } : {}).catch(() => undefined);
  const rec = await readPublicEntity({ tenantId, typeName, entityId, ...(loc ? { locale: loc } : {}) });
  if (!rec) return null;
  const title = rec.values[titleField];
  const titleStr = title === undefined || title === null ? '' : String(title);
  if (!titleStr) return null;
  const body = bodyField ? rec.values[bodyField] : undefined;
  return {
    items: [{
      title: titleStr,
      ...(body !== undefined && body !== null && String(body) ? { body: String(body) } : {}),
    }],
  };
};

/** Register the entity content-section resolvers into the core registry (called
 *  at entities-feature init). Idempotent — a multi-`createApp` test process
 *  re-inits the feature; the has-guard keeps that safe. Publishing consumes
 *  these via `resolveContentSection`. */
export function registerEntityContentResolvers(): void {
  if (!hasContentSectionResolver('entityList')) registerContentSectionResolver('entityList', entityListResolver);
  if (!hasContentSectionResolver('entityDetail')) registerContentSectionResolver('entityDetail', entityDetailResolver);
}
