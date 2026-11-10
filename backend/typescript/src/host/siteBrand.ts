/**
 * ADR 1030 P2 — the brand a workspace's custom-domain site is styled with.
 *
 * A workspace chooses ONE of its own brands for its site (`site:brand`, keyed
 * `<tenantId>:<orgId>`); nothing is guessed when it has several. The designed-
 * pages prerender (ADR 1030 D4) then puts that brand's colours, corner radius and
 * public-page motion preset (ADR 1029 D6) on the page as one inline `:root` token
 * block, which `PRERENDER_CSP` already allows (`style-src 'unsafe-inline'`).
 *
 * The tokens are produced by the SAME theme generator the SPA uses (ADR 0171),
 * mirrored byte-for-byte in `features/brand/theme/` and pinned to the frontend
 * copy by `test/adr1030-p2-site-brand.test.ts`, so the contrast-critical tokens
 * are AA-solved here exactly as in the app (ADR 0510 §5: never a raw accent).
 *
 * This is not a second brand system: `brandService` stays the only owner of the
 * brand store (the `host/systemBrand.ts` precedent); this module stores only the
 * pointer and reads brands through it.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { getBrand, listBrands } from '../features/brand/brandService.js';
import type { BrandIdentity } from '../features/brand/types.js';
import { generateTheme, type ThemeInputs } from '../features/brand/theme/generate.js';

const log = createLogger('host.siteBrand');

export interface SiteBrandSetting {
  tenantId: string;
  orgId: string;
  brandId: string;
  updatedAt: string;
  updatedBy: string;
}

const siteBrand = new DurableCollection<SiteBrandSetting>('site:brand', (s) => `${s.tenantId}:${s.orgId}`);

/** The brand this workspace's site uses, or null when it chose none. */
export async function getSiteBrandId(tenantId: string, orgId: string): Promise<string | null> {
  const row = await siteBrand.get(`${tenantId}:${orgId}`);
  return row && row.tenantId === tenantId && row.orgId === orgId ? row.brandId : null;
}

/** The workspace's brands a site may use: its own, with an identity facet. */
export async function listSiteBrandChoices(tenantId: string, orgId: string): Promise<Array<{ id: string; name: string }>> {
  const brands = await listBrands(tenantId, orgId);
  return brands.filter((b) => b.orgId === orgId && b.identity).map((b) => ({ id: b.id, name: b.name }));
}

/** Set (or clear, with null) the site's brand. The brand must be this
 *  workspace's own and carry an identity; anything else is a 400, never a silent
 *  pointer into another org. */
export async function setSiteBrandId(tenantId: string, orgId: string, brandId: unknown, updatedBy: string): Promise<string | null> {
  const key = `${tenantId}:${orgId}`;
  if (brandId === null || brandId === '') {
    await siteBrand.delete(key);
    tokensCache.delete(key);
    return null;
  }
  if (typeof brandId !== 'string' || brandId.length > 200) {
    throw new OpenwopError('validation_error', 'brandId must be a brand id or null.', 400, {});
  }
  const brand = await getBrand(tenantId, brandId);
  if (!brand || brand.orgId !== orgId || !brand.identity) {
    throw new OpenwopError('validation_error', 'Choose one of this workspace\'s brands that has an app identity.', 400, {});
  }
  await siteBrand.put({ tenantId, orgId, brandId, updatedAt: new Date().toISOString(), updatedBy });
  tokensCache.delete(key);
  return brandId;
}

/** The generator's inputs from a brand identity: the theme inputs, with the
 *  identity's accent colour as the seed when the theme names none. */
function inputsOf(identity: BrandIdentity): ThemeInputs {
  const t = identity.theme ?? {};
  const accent = t.accentSeed ?? identity.colors?.accent;
  return {
    ...(accent ? { accentSeed: accent } : {}),
    ...(t.neutralSeed ? { neutralSeed: t.neutralSeed } : {}),
    ...(t.contrastLevel ? { contrastLevel: t.contrastLevel } : {}),
    ...(t.radius ? { radius: t.radius } : {}),
    ...(t.motion ? { motion: t.motion } : {}),
  };
}

/** The same value grammar the SPA's injector enforces (`applyBrand.ts`). */
const SAFE_TOKEN_VALUE = /^[^;{}<>]+$/;
const block = (sel: string, map: Record<string, string>): string => {
  const decls = Object.entries(map)
    .filter(([k, v]) => /^--[a-z0-9-]+$/.test(k) && SAFE_TOKEN_VALUE.test(v))
    .map(([k, v]) => `${k}:${v}`).join(';');
  return decls ? `${sel}{${decls}}` : '';
};

/** The inline token CSS for one brand identity: light on `:root`, dark under the
 *  OS dark preference (a custom-domain page has no app theme switch). '' when the
 *  identity changes nothing. Pure: same identity, same CSS. */
export function siteBrandTokenCss(identity: BrandIdentity): string {
  const inputs = inputsOf(identity);
  if (Object.keys(inputs).length === 0) return '';
  const { light, dark } = generateTheme(inputs);
  const l = block('[data-owp-site]', light);
  const d = block('[data-owp-site]', dark);
  return [l, d ? `@media (prefers-color-scheme: dark){${d}}` : ''].filter(Boolean).join('\n');
}

const TTL_MS = 60_000;
const tokensCache = new Map<string, { at: number; css: string }>();

/** The site's token CSS, or '' when it chose no brand or the brand is gone.
 *  Cached a minute per workspace (a page view must not re-run the generator),
 *  dropped at once when the choice changes. A read failure is '' (the page keeps
 *  the distribution's look) and is logged, never thrown into the page. */
export async function siteBrandCssFor(tenantId: string, orgId: string): Promise<string> {
  const key = `${tenantId}:${orgId}`;
  const hit = tokensCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.css;
  let css = '';
  try {
    const brandId = await getSiteBrandId(tenantId, orgId);
    const brand = brandId ? await getBrand(tenantId, brandId) : null;
    if (brand && brand.orgId === orgId && brand.identity) css = siteBrandTokenCss(brand.identity);
  } catch (err) {
    log.warn('site_brand_unreadable', { error: err instanceof Error ? err.message : String(err) });
    return '';
  }
  tokensCache.set(key, { at: Date.now(), css });
  return css;
}

/** ADR 0464 — DSAR subject-eraser: REDACT `updatedBy` on the tenant's site-brand
 *  rows. The attribution is the only subject field; which brand a workspace's
 *  site uses is org config and is kept (the workflow:budget precedent). */
export async function eraseSubjectSiteBrand(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const r of await siteBrand.listByPrefix(`${tenantId}:`)) {
    if (r.tenantId === tenantId && r.updatedBy && forms.has(r.updatedBy)) await siteBrand.put({ ...r, updatedBy: ERASED });
  }
}

/** ADR 0464 — called from `registerHostSubjectErasers()` (one explicit boot list). */
export function registerSiteBrandErasure(): void {
  registerSubjectEraser(eraseSubjectSiteBrand);
}

export function __resetSiteBrandForTests(): void {
  tokensCache.clear();
}
