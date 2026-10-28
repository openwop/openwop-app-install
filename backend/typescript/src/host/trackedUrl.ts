/**
 * ADR 0956 D5 — the ONE tracked-URL helper and the UTM policy linter. Pure (no
 * I/O), so every outbound link (ads, email, social, pages) is stamped and
 * checked the same way. It replaces the campaign-channels pack's `appendUtm`;
 * packs reach it through `ctx.features['campaign-brief'].trackedUrl`.
 *
 * Stamping rules (unchanged from the pack helper): a parameter already on the
 * URL wins; `utm_campaign` falls back to the caller's anchor (the brief id);
 * a relative URL stays relative. ADR 0956 adds `utm_content` ← the variant key
 * and `utm_id` ← our ad reference, again only when the URL has none.
 */

export interface TrackingParams {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

export interface TrackedUrlOptions {
  /** `utm_campaign` when neither the URL nor the UTM schema names one. */
  fallbackCampaign: string;
  /** ADR 0946 variant / experiment arm → `utm_content`. */
  variantKey?: string;
  /** Our ad reference (ADR 0946 member) → `utm_id`. */
  adRef?: string;
}

const PLACEHOLDER_BASE = 'https://x.invalid';
const isAbsolute = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(url);

export function buildTrackedUrl(url: string, utm: TrackingParams | undefined, opts: TrackedUrlOptions): string {
  const params: Record<string, string | undefined> = {
    utm_source: utm?.source,
    utm_medium: utm?.medium,
    utm_campaign: utm?.campaign || opts.fallbackCampaign,
    utm_term: utm?.term,
    utm_content: utm?.content || opts.variantKey,
    utm_id: opts.adRef,
  };
  try {
    // Resolve against a placeholder so a RELATIVE landing URL is still stamped
    // (grade-code AUDIT-9: a bare `new URL(relative)` throws).
    const u = new URL(url, PLACEHOLDER_BASE);
    if (!['http:', 'https:'].includes(u.protocol) || !url.trim()) throw new TypeError('A tracked landing URL must be an HTTP(S) URL or relative path.');
    for (const [k, v] of Object.entries(params)) {
      if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
    }
    return isAbsolute(url) ? u.toString() : url.startsWith('//') ? `//${u.host}${u.pathname}${u.search}${u.hash}` : u.pathname + u.search + u.hash;
  } catch {
    throw new TypeError('The tracked landing URL is invalid.');
  }
}

export const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'] as const;
export type UtmParam = (typeof UTM_PARAMS)[number];

export interface UtmPolicy {
  /** Allowed `utm_source` values; empty means any. */
  sources: string[];
  /** Allowed `utm_medium` values; empty means any. */
  mediums: string[];
  /** Parameters every outbound link must carry. */
  required: UtmParam[];
  /** `lower`: every UTM value must be lowercase. */
  case: 'lower' | 'any';
}

/** The default policy: GA4's default channel-grouping mediums. Sources are
 *  open (GA4 matches them by pattern, which a closed list would not honour). */
export const DEFAULT_UTM_POLICY: UtmPolicy = {
  sources: [],
  mediums: ['cpc', 'ppc', 'paidsearch', 'paid', 'paid-social', 'paidsocial', 'display', 'banner', 'cpm', 'cpv', 'cpa', 'cpp', 'interstitial', 'social', 'social-network', 'social-media', 'sm', 'social network', 'social media', 'email', 'e-mail', 'e_mail', 'e mail', 'affiliate', 'referral', 'organic', 'video', 'audio', 'sms', 'push', 'mobile', 'notification'],
  required: ['utm_source', 'utm_medium', 'utm_campaign'],
  case: 'lower',
};

export interface UtmViolation {
  param: UtmParam | 'url';
  rule: 'missing' | 'not_allowed' | 'case' | 'invalid_url';
  message: string;
}

/** Check one URL against a policy. Pure; an empty array means it passes. */
export function lintTrackedUrl(url: string, policy: UtmPolicy): UtmViolation[] {
  let u: URL;
  try { u = new URL(url, PLACEHOLDER_BASE); } catch {
    return [{ param: 'url', rule: 'invalid_url', message: 'The link is not a valid URL.' }];
  }
  if (!['http:', 'https:'].includes(u.protocol) || !url.trim()) {
    return [{ param: 'url', rule: 'invalid_url', message: 'The link must be an HTTP(S) URL or relative path.' }];
  }
  const out: UtmViolation[] = [];
  for (const p of policy.required) {
    if (!u.searchParams.get(p)) out.push({ param: p, rule: 'missing', message: `${p} is required.` });
  }
  const check = (param: UtmParam, allowed: string[]): void => {
    const v = u.searchParams.get(param);
    if (v && allowed.length > 0 && !allowed.includes(policy.case === 'lower' ? v.toLowerCase() : v)) {
      out.push({ param, rule: 'not_allowed', message: `${param} "${v}" is not in the allowed list.` });
    }
  };
  check('utm_source', policy.sources);
  check('utm_medium', policy.mediums);
  if (policy.case === 'lower') {
    for (const p of UTM_PARAMS) {
      const v = u.searchParams.get(p);
      if (v && v !== v.toLowerCase()) out.push({ param: p, rule: 'case', message: `${p} "${v}" must be lowercase.` });
    }
  }
  return out;
}
