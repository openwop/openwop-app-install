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
  return skeletonSettings(tenantId, orgId);
}

function skeletonSettings(tenantId: string, orgId: string): ContentLanguageSettings {
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

/** ADR 0861 D4 — the STORED row, or `null` when the org never configured
 *  localization. A caller that gates a write on what it read passes this to
 *  `updateContentLanguageSettings` as `expected`, so the write is a CAS against
 *  exactly that row (`null` = insert-if-absent). */
export async function getStoredContentLanguageSettings(tenantId: string, orgId: string): Promise<ContentLanguageSettings | null> {
  const stored = await langSettings.get(`${tenantId}:${orgId}`);
  return stored && stored.tenantId === tenantId && stored.orgId === orgId ? stored : null;
}

/** Update the org's content-locale settings, enforcing the §A invariant
 *  (`baseLocale ∉ supportedLocales`) and BCP-47 validity.
 *
 *  ADR 0861 D4 (CMSL2WF-4) — with `opts.expected` the write is a compare-and-swap
 *  against the row the caller's gates decided on, and a miss is a 409. Without it,
 *  two admins raced last-write-wins: a write built from a stale read put back a
 *  locale the other had just removed, and the widening gate never saw it. */
export async function updateContentLanguageSettings(
  tenantId: string,
  orgId: string,
  patch: { baseLocale?: unknown; supportedLocales?: unknown; autoTranslateOnPublish?: unknown },
  updatedBy: string,
  opts?: { expected: ContentLanguageSettings | null },
): Promise<ContentLanguageSettings> {
  const cur = opts ? (opts.expected ?? skeletonSettings(tenantId, orgId)) : await getContentLanguageSettings(tenantId, orgId);
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
  if (opts) {
    if (!(await langSettings.compareAndSwap(opts.expected, next))) {
      throw new OpenwopError('conflict', 'The language settings changed while this change was being saved — reload and try again.', 409, { orgId });
    }
  } else {
    await langSettings.put(next);
  }
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
      // ADR 0861 D4 (review H7) — a CAS against the listed row: a blind `put` of a
      // stale row put back whatever an admin had changed since the list.
      let row: ContentLanguageSettings | null = s;
      for (let attempt = 0; row && attempt < 3; attempt += 1) {
        if (!(typeof row.updatedBy === 'string' && subjectForms.has(row.updatedBy))) { row = null; break; }
        if (await langSettings.compareAndSwap(row, { ...row, updatedBy: sentinel })) { touched += 1; row = null; break; }
        row = await langSettings.get(`${s.tenantId}:${s.orgId}`);
      }
      if (row) throw new Error(`content-locales erasure: settings row ${s.tenantId}:${s.orgId} kept changing under the rewrite`);
    }
  }
  return touched;
}

/** Test-only reset (called from the cms feature's `__resetCms`). */
export async function __resetContentLocales(): Promise<void> {
  await langSettings.__clear();
}
