/**
 * ADR 0931 — the system site's per-distribution configuration: who the public
 * site says it IS (`OPENWOP_SYSTEM_SITE_PROFILE`), and which built-in seeds it
 * writes (`OPENWOP_SYSTEM_SITE_SEEDS_DISABLED`).
 *
 * Both are read from the environment on every call (tests set them per case);
 * the profile is parsed once per distinct value, and a file is read once per
 * path. With neither set, every caller behaves exactly as before.
 */
import { readFileSync } from 'node:fs';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.systemSiteConfig');

/** The shape `OPENWOP_SYSTEM_SITE_PROFILE` carries (inline JSON, or a path to a
 *  JSON file). `siteName` is required; everything else is optional. */
export interface ConfiguredSiteProfile {
  siteName: string;
  /** Organization `sameAs` URLs (http/https only). */
  organizationSameAs: string[];
  /** Extra JSON-LD for the home page. `@context` defaults to schema.org. */
  homeJsonLd: object[];
  /** The `/llms.txt` head. Absent → the generic head. */
  llms: { title: string; summary: string; body: string } | null;
}

/** `undefined` = not configured (the built-in profile applies). `null` = set but
 *  invalid (no profile at all: a distribution that tried to name itself must
 *  never fall back to claiming to be OpenWOP). */
export type SiteProfileSetting = ConfiguredSiteProfile | null | undefined;

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null;
const isHttpUrl = (v: string): boolean => /^https?:\/\/[^\s]+$/i.test(v);

/** Validate a parsed profile. Returns the reason it is invalid, or the profile. */
export function parseSiteProfile(raw: unknown): ConfiguredSiteProfile | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not a JSON object';
  const r = raw as Record<string, unknown>;
  const siteName = str(r.siteName, 120);
  if (!siteName) return 'siteName is required (a non-empty string of at most 120 characters)';
  const sameAs = r.organizationSameAs ?? [];
  if (!Array.isArray(sameAs) || !sameAs.every((u) => typeof u === 'string' && isHttpUrl(u))) {
    return 'organizationSameAs must be an array of http(s) URLs';
  }
  const blocks = r.homeJsonLd ?? [];
  if (!Array.isArray(blocks) || !blocks.every((b) => b && typeof b === 'object' && !Array.isArray(b) && typeof (b as Record<string, unknown>)['@type'] === 'string')) {
    return 'homeJsonLd must be an array of JSON-LD objects, each with an @type';
  }
  let llms: ConfiguredSiteProfile['llms'] = null;
  if (r.llms !== undefined) {
    const l = r.llms as Record<string, unknown> | null;
    const title = str(l?.title, 200);
    const summary = str(l?.summary, 500);
    const body = str(l?.body, 4000);
    if (!title || !summary || !body) return 'llms must have non-empty title, summary and body';
    llms = { title, summary, body };
  }
  return {
    siteName,
    organizationSameAs: sameAs as string[],
    homeJsonLd: (blocks as Array<Record<string, unknown>>).map((b) => ({ '@context': 'https://schema.org', ...b })),
    llms,
  };
}

let memo: { raw: string; value: ConfiguredSiteProfile | null } | null = null;

/** The configured profile, `null` when the setting is invalid, `undefined` when unset. */
export function configuredSiteProfile(): SiteProfileSetting {
  const raw = process.env.OPENWOP_SYSTEM_SITE_PROFILE?.trim();
  if (!raw) return undefined;
  if (memo?.raw === raw) return memo.value;
  let value: ConfiguredSiteProfile | null = null;
  try {
    const text = raw.startsWith('{') ? raw : readFileSync(raw, 'utf8');
    const parsed = parseSiteProfile(JSON.parse(text));
    if (typeof parsed === 'string') log.error('system_site_profile_invalid', { reason: parsed });
    else value = parsed;
  } catch (err) {
    log.error('system_site_profile_invalid', { reason: err instanceof Error ? err.message : String(err) });
  }
  memo = { raw, value };
  return value;
}

/** The seeds a distribution can turn off. The home page is not one of them: it
 *  also creates the system-site org, and a person's edit already freezes it. */
export const OPTIONAL_SYSTEM_SITE_SEEDS = ['blog', 'docs', 'seo', 'marketing'] as const;
export type OptionalSystemSiteSeed = (typeof OPTIONAL_SYSTEM_SITE_SEEDS)[number];

let warnedFor: string | null = null;

/** False when `OPENWOP_SYSTEM_SITE_SEEDS_DISABLED` (comma-separated) names the
 *  seed. Turning a seed off stops it writing; it never deletes a page. */
export function systemSiteSeedEnabled(seed: OptionalSystemSiteSeed): boolean {
  const raw = process.env.OPENWOP_SYSTEM_SITE_SEEDS_DISABLED ?? '';
  const names = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return true;
  const unknown = names.filter((n) => !(OPTIONAL_SYSTEM_SITE_SEEDS as readonly string[]).includes(n));
  if (unknown.length > 0 && warnedFor !== raw) {
    warnedFor = raw;
    log.warn('system_site_seeds_disabled_unknown', { unknown, known: OPTIONAL_SYSTEM_SITE_SEEDS });
  }
  return !names.includes(seed);
}

/** Test-only: forget the parsed profile and the unknown-name warning. */
export function __resetSystemSiteConfigForTests(): void {
  memo = null;
  warnedFor = null;
}
