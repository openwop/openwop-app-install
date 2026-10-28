/**
 * ADR 0946 P1 — the ONE built-in ad text-policy rule list (ADR 0933's "Later"
 * row). The data lives in `adPolicyRules.json`; `vendor.myndhyve.ads-policy`
 * and `vendor.myndhyve.ads-creative-validate` read a generated copy instead of
 * carrying their own. P2 folds `ads.policy.check` into the content-rules
 * library (D5); until then this is the shared source.
 */
import table from './adPolicyRules.json';

export interface AdPolicyRule {
  id: string;
  name: string;
  description: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  platforms: string[];
  autoResolvable: boolean;
  patterns: string[];
  keywords: string[];
  recommendation: string;
  enabled: boolean;
}

export const AD_POLICY_RULES_VERSION: string = table.version;
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/** Validate the data at load: a malformed rule must fail loudly. */
function readRule(r: (typeof table.rules)[number]): AdPolicyRule {
  if (!SEVERITIES.has(r.severity)) throw new Error(`adPolicyRules.json: rule ${r.id} has severity ${r.severity}`);
  for (const p of r.patterns) new RegExp(p, 'i'); // throws on an invalid pattern
  return { ...r, severity: r.severity as AdPolicyRule['severity'] };
}

export const AD_POLICY_RULES: readonly AdPolicyRule[] = table.rules.map(readRule);
