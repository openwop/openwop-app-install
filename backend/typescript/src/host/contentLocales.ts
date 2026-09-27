/**
 * Core-shared per-org content-locale settings (ADR 0406 Phase 1 — promoted
 * from the cms feature so cms AND entities consume ONE locale truth per org;
 * the ADR 0408 one-content-kernel program's parity seam).
 *
 * Ownership move, not a data move: the collection name stays
 * `cms:langsettings` (a historical key — zero migration; every stored row is
 * read unchanged). The cms feature keeps its management ROUTES and re-exports
 * these symbols, so consumers and the wire are byte-identical.
 *
 * Core-purity: imports nothing under `features/` (guarded by test, the
 * host/i18n pattern).
 */
import { DurableCollection, hostExtStorage } from './hostExtPersistence.js';
import { LOCALE_RE, hostDefaultLocale } from './i18n/index.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.contentLocales');
const nowIso = (): string => new Date().toISOString();

/** Per-(tenant, org) content-locale configuration (RFC 0103 §A). Invariant:
 *  `baseLocale ∉ supportedLocales`. */
export interface ContentLanguageSettings {
  tenantId: string;
  orgId: string;
  baseLocale: string;
  /** Authored non-base locales (excludes baseLocale). */
  supportedLocales: string[];
  autoTranslateOnPublish: boolean;
  updatedAt: string;
  updatedBy: string;
}

const langSettings = new DurableCollection<ContentLanguageSettings>(
  'cms:langsettings',
  (s) => `${s.tenantId}:${s.orgId}`,
);

/** The org's content-locale settings, or a host-default skeleton (NOT persisted
 *  on read — an org that never configured localization has empty
 *  `supportedLocales`, so delivery is byte-identical to the non-localized CMS). */
export async function getContentLanguageSettings(tenantId: string, orgId: string): Promise<ContentLanguageSettings> {
  const stored = await langSettings.get(`${tenantId}:${orgId}`);
  if (stored && stored.tenantId === tenantId && stored.orgId === orgId) return stored;
  return {
    tenantId,
    orgId,
    baseLocale: hostDefaultLocale(),
    supportedLocales: [],
    autoTranslateOnPublish: false,
    updatedAt: nowIso(),
    updatedBy: 'system',
  };
}

/** Update the org's content-locale settings, enforcing the §A invariant
 *  (`baseLocale ∉ supportedLocales`) and BCP-47 validity. */
export async function updateContentLanguageSettings(
  tenantId: string,
  orgId: string,
  patch: { baseLocale?: unknown; supportedLocales?: unknown; autoTranslateOnPublish?: unknown },
  updatedBy: string,
): Promise<ContentLanguageSettings> {
  const cur = await getContentLanguageSettings(tenantId, orgId);
  let baseLocale = cur.baseLocale;
  if (patch.baseLocale !== undefined) {
    const b = String(patch.baseLocale);
    if (!LOCALE_RE.test(b)) throw new OpenwopError('validation_error', `Invalid baseLocale \`${b}\`.`, 400, { baseLocale: b });
    baseLocale = b;
  }
  let supportedLocales = cur.supportedLocales;
  if (patch.supportedLocales !== undefined) {
    if (!Array.isArray(patch.supportedLocales)) {
      throw new OpenwopError('validation_error', '`supportedLocales` must be an array.', 400, {});
    }
    const seen = new Set<string>();
    supportedLocales = [];
    for (const raw of patch.supportedLocales) {
      const l = String(raw);
      if (!LOCALE_RE.test(l)) throw new OpenwopError('validation_error', `Invalid locale \`${l}\` (expected BCP-47).`, 400, { locale: l });
      if (!seen.has(l)) { seen.add(l); supportedLocales.push(l); }
    }
  }
  // §A invariant: the base locale is never one of the authored translations.
  if (supportedLocales.includes(baseLocale)) {
    throw new OpenwopError('validation_error', 'baseLocale MUST NOT appear in supportedLocales.', 400, { baseLocale });
  }
  const next: ContentLanguageSettings = {
    tenantId,
    orgId,
    baseLocale,
    supportedLocales,
    autoTranslateOnPublish:
      patch.autoTranslateOnPublish !== undefined ? Boolean(patch.autoTranslateOnPublish) : cur.autoTranslateOnPublish,
    updatedAt: nowIso(),
    updatedBy,
  };
  await langSettings.put(next);
  // ADR 0204 C5 — audit the admin config write (payload.tenantId required).
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: next.updatedAt, principalId: updatedBy, action: 'cms.language-settings.update', resource: `${tenantId}:${orgId}`, outcome: 'success', payload: { tenantId, orgId, baseLocale, supportedLocales, autoTranslateOnPublish: next.autoTranslateOnPublish, at: next.updatedAt } })
      .catch((err) => log.warn('content-locales audit append failed', { action: 'language-settings.update', orgId, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
  return next;
}

/** ADR 0592 §8 — anonymize the operator attribution (`updatedBy`) on this
 *  tenant's language-settings rows for an erased subject (any key FORM).
 *  Config itself is kept — it is org configuration, not subject data; the
 *  attribution is the only subject-bearing field. Returns rows touched. */
export async function eraseContentLanguageSettingsSubject(
  tenantId: string,
  subjectForms: ReadonlySet<string>,
  sentinel: string,
): Promise<number> {
  let touched = 0;
  for (const s of await langSettings.list()) {
    if (s.tenantId !== tenantId) continue;
    if (typeof s.updatedBy === 'string' && subjectForms.has(s.updatedBy)) {
      await langSettings.put({ ...s, updatedBy: sentinel });
      touched += 1;
    }
  }
  return touched;
}

/** Test-only reset (called from the cms feature's `__resetCms`). */
export async function __resetContentLocales(): Promise<void> {
  await langSettings.__clear();
}
