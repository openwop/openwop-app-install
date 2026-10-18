/**
 * System brand (ADR 0170) — the host-level white-label app identity, modeled the
 * same way as the system site (ADR 0027 / systemSite.ts): a GLOBAL brand edited by
 * the host-level role (super admin), NOT by tenant membership. It is a reserved
 * `brand:host-app` record living in the SAME reserved, auth-unreachable org as the
 * system site (`host:site` / `host-site`) — reused via the documented
 * `accessControl.createOrg({ orgId })` seam, NOT a second reserved-org system
 * (ADR 0170 review correction #1).
 *
 * This is NOT a parallel brand system: the record is a real `brandService` brand
 * (the single owner of the brand store) — `ensureBrand` instantiates it, nothing
 * shadows it. The only new thing is the AUTHORITY: super-admin (host-level) instead
 * of org-scoped RBAC, which stays untouched for every real tenant brand.
 *
 * **Sparse seed** (ADR 0170 implementation refinement): the seeded identity is an
 * EMPTY override set, not a copy of the build-time `VITE_BRAND_*` values. The SPA
 * merges the app brand OVER its build-time brand singleton, so an unedited install
 * is byte-identical to the shipped/adopter identity WITHOUT duplicating the
 * frontend defaults in the backend. A super-admin's later edits are frozen by
 * `ensureBrand`'s create-if-absent semantics (it never clobbers an existing record).
 */
import { createLogger } from '../observability/logger.js';
import { ensureBrand, getBrand, updateBrand, type BrandInput } from '../features/brand/brandService.js';
import { OpenwopError } from '../types.js';
import { SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, ensureSystemSiteOrg } from './systemSite.js';
import type { Brand } from '../features/brand/types.js';

const log = createLogger('host.systemBrand');

/** Deterministic reserved id ⇒ the seed is idempotent across a concurrent
 *  multi-instance first boot (no `brand:host-app` + `…-2` duplicate). */
export const SYSTEM_BRAND_ID = 'brand:host-app';
const SYSTEM_ACTOR = 'system';

/** Run-once-per-process dedupe of concurrent in-instance callers (the common race).
 *  A cross-instance first-boot race is benign — the fixed id upserts to the same
 *  record with identical sparse content. */
let ensuring: Promise<Brand> | null = null;

async function doEnsure(): Promise<Brand> {
  // Reuse the reserved host-site org via the shared single-owner helper (idempotent;
  // no homepage-seed coupling). The app brand lives in the SAME reserved org.
  await ensureSystemSiteOrg();
  const brand = await ensureBrand(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_BRAND_ID, SYSTEM_ACTOR, {
    name: 'App identity',
    description: 'The white-label visual identity for this installation (ADR 0170). Edited by a super admin at Admin → Appearance.',
    // Sparse: no identity overrides on a fresh install — the SPA falls back to its
    // build-time brand (stock OpenWOP or the adopter's VITE_BRAND_* values).
  });
  return brand;
}

/** Ensure the reserved app-brand record exists (idempotent). */
export function ensureSystemBrand(): Promise<Brand> {
  if (!ensuring) ensuring = doEnsure().catch((err) => { ensuring = null; throw err; });
  return ensuring;
}

/** Test-only: drop the run-once ensure cache so a fresh in-memory store re-seeds
 *  (mirrors `brandService.__clearBrands`). No effect in a real single-store process. */
export function __resetSystemBrand(): void {
  ensuring = null;
}

/** The current app brand — ensures it exists, then RE-READS fresh (the cached
 *  `ensuring` promise only guarantees existence; reading fresh reflects edits). */
export async function getAppBrand(): Promise<Brand> {
  await ensureSystemBrand();
  const b = await getBrand(SYSTEM_SITE_TENANT, SYSTEM_BRAND_ID);
  if (!b) throw new Error('app brand missing after ensure');
  return b;
}

/**
 * Host-level edit of the app brand (super-admin authority; the route gates). The
 * reserved record is never re-seeded, so a partial PUT persists; subsequent boots
 * return the edited record untouched (ensureBrand is create-if-absent).
 */
export async function editAppBrand(input: BrandInput, actor: string): Promise<Brand> {
  await ensureSystemBrand();
  // ADR 0891 D9 — the audit row names the super-admin who made the edit (it said
  // `editor`). The brand eraser scrubs these rows on every DSAR (D8).
  const next = await updateBrand(SYSTEM_SITE_TENANT, SYSTEM_BRAND_ID, input, actor);
  if (!next) throw new Error('app brand missing after ensure');
  log.info('app_brand_edited', { actor });
  return next;
}

/**
 * ADR 0883 correction — the typography the Appearance editor stored when a super
 * admin picked "Editorial (default)" (or the "Clay (default)" preset) before the
 * default display face changed. The editor copied the DEFAULT pairing into the
 * override, so the old face stayed live after the default moved to Bricolage
 * Grotesque (app.openwop.dev, 2026-10-14). Matched EXACTLY: an operator who chose
 * Instrument Serif any other way keeps it.
 */
export const LEGACY_DEFAULT_TYPOGRAPHY = Object.freeze({
  serif: '"Instrument Serif", "Times New Roman", serif',
  sans: '"Geist", ui-sans-serif, system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
  fontsHref: 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap',
});

function isLegacyDefaultTypography(t: Record<string, unknown> | undefined): boolean {
  if (!t) return false;
  const keys = Object.keys(t).filter((k) => t[k] !== undefined);
  const legacy = LEGACY_DEFAULT_TYPOGRAPHY as Record<string, string>;
  return keys.length === Object.keys(legacy).length && keys.every((k) => t[k] === legacy[k]);
}

/**
 * Drop a frozen copy of the legacy default typography from the app brand, so the
 * app follows its shipped face again. Every other identity field is kept. The
 * write is a CAS on `updatedAt`, so a super admin's concurrent edit wins and is
 * never clobbered; a second boot finds nothing to do. Idempotent.
 */
export async function clearLegacyDefaultTypography(): Promise<{ cleared: boolean; reason: 'cleared' | 'absent' | 'operator-choice' | 'concurrent-edit' }> {
  const brand = await getAppBrand();
  const identity = brand.identity as (Record<string, unknown> & { typography?: Record<string, unknown> }) | undefined;
  if (!identity?.typography) return { cleared: false, reason: 'absent' };
  if (!isLegacyDefaultTypography(identity.typography)) return { cleared: false, reason: 'operator-choice' };
  const { typography: _legacy, ...rest } = identity;
  try {
    await updateBrand(SYSTEM_SITE_TENANT, SYSTEM_BRAND_ID, { identity: rest, expectedUpdatedAt: brand.updatedAt }, SYSTEM_ACTOR);
  } catch (err) {
    if (err instanceof OpenwopError && err.httpStatus === 409) return { cleared: false, reason: 'concurrent-edit' };
    throw err;
  }
  log.info('app_brand_legacy_typography_cleared', { brandId: SYSTEM_BRAND_ID });
  return { cleared: true, reason: 'cleared' };
}
