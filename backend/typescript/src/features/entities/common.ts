/**
 * Shared entities-package helpers (ADR 0386) — key grammar + namespace
 * resolution used by both entitiesService and taxonomyService (kept here so the
 * two services never import each other).
 */
import { OpenwopError } from '../../types.js';
import { getProject } from '../projects/projectsService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listOrgs } from '../../host/accessControlService.js';
import { getContentLanguageSettings } from '../../host/contentLocales.js';

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Normalize + validate an immutable machine name (slug). */
export function normalizeTypeName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new OpenwopError(
      'validation_error',
      'Type `name` must be a slug: start with a letter, then letters/digits/`_`/`-`, max 64 chars.',
      400,
      { field: 'name' },
    );
  }
  return name;
}

export const projectKeyOf = (projectId: string | undefined): string => projectId ?? '';

/**
 * Resolve an optional project namespace against the SINGLE project owner
 * (ADR 0046). 404 on a missing/cross-tenant project — no existence leak.
 */
export async function requireProjectNamespace(tenantId: string, projectId: string | undefined): Promise<string> {
  if (projectId === undefined || projectId === '') return '';
  const project = await getProject(tenantId, projectId);
  if (!project) {
    throw new OpenwopError('not_found', 'Project not found.', 404, { projectId });
  }
  return projectId;
}

/**
 * ADR 0406 — the ONE locale-context resolver for entity localization
 * (surface + tools + routes): undefined when the `entities-localization`
 * toggle is off, the tenant has no org, or no locales are authored — callers
 * then serve base values, byte-identical to pre-localization. Settings anchor
 * = the tenant's PRIMARY org (entities are tenant-scoped; recorded ADR open
 * question for multi-org tenants).
 */
export async function entityLocaleContext(
  tenantId: string,
): Promise<{ baseLocale: string; supportedLocales: string[] } | undefined> {
  if (!(await resolveOne('entities-localization', { tenantId }))?.enabled) return undefined;
  const orgId = (await listOrgs(tenantId))[0]?.orgId;
  if (!orgId) return undefined;
  const settings = await getContentLanguageSettings(tenantId, orgId);
  if (settings.supportedLocales.length === 0) return undefined;
  return { baseLocale: settings.baseLocale, supportedLocales: settings.supportedLocales };
}
