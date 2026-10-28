/**
 * ADR 0945 D6 — AI disclosure as data: (destination, AI realism, ad context) →
 * what the destination must show. A pure, dated, versioned table. Every row
 * cites its source and is PROVISIONAL until re-verified against the platform's
 * current rules when its adapter ships (ADR 0945 Q6); a provisional row still
 * binds, because the cost of an unlabelled AI ad is the platform's, the
 * client's and the law's, and the cost of a refused one is a retry.
 *
 * A row whose mechanism is `platform-flag` needs the destination adapter to set
 * that flag. No adapter on this host sets one yet, so those rows refuse
 * (`disclosure_unsupported`) instead of publishing an unlabelled AI ad.
 * NOT here yet: EU AI Act Art. 50(4) (needs the audience's geography, which a
 * publish call does not carry — owed to ADR 0952) and a client's "label more
 * than required" policy (Q3, open).
 */
export const DISCLOSURE_RULES_VERSION = 'disc-2026-10-20b';

/**
 * ADR 0945 Q3 (decided 2026-10-20 by team-lead; David can override): label AI
 * content WHEREVER the destination offers a label, even where no rule requires
 * it. Transparency is the brand-safe default, and an extra label costs nothing.
 * `'required-only'` would label only where a platform or law requires it.
 */
export const DISCLOSURE_POLICY: 'label-where-offered' | 'required-only' = 'label-where-offered';

export type DisclosureDestination = 'ads:meta' | 'ads:google' | 'ads:tiktok' | 'ads:linkedin' | 'openwop.cms.page';

export interface AiDisclosure {
  required: boolean;
  label: 'ai-generated' | 'ai-edited' | 'none';
  mechanism: 'platform-flag' | 'caption' | 'overlay' | 'none';
  /** The rule that decided it (`none` when no row applies). */
  basis: string;
  /** Why it is labelled: a platform or legal rule requires it, or the Q3
   *  policy labels where a label is merely offered. Absent when none. */
  requiredBy?: 'rule' | 'policy';
}

export interface DisclosureRule {
  id: string;
  destination: DisclosureDestination;
  /** When the destination REQUIRES the label (absent: never required). */
  requiredWhen?: 'always' | 'political';
  /** When the destination OFFERS a label the adapter could set. */
  offeredWhen: 'always' | 'political';
  label: AiDisclosure['label'];
  mechanism: AiDisclosure['mechanism'];
  source: string;
  dated: string;
  status: 'provisional' | 'verified';
}

export const DISCLOSURE_RULES: readonly DisclosureRule[] = [
  {
    id: 'tiktok-aigc', destination: 'ads:tiktok', requiredWhen: 'always', offeredWhen: 'always', label: 'ai-generated', mechanism: 'platform-flag',
    source: 'TikTok advertising policies: AI-generated content in ads must be disclosed (the AIGC disclosure in TikTok Ads Manager)',
    dated: '2026-10-20', status: 'provisional',
  },
  {
    // Meta's advertiser-set AI disclosure exists only on political/social-issue ads.
    id: 'meta-political-ai', destination: 'ads:meta', requiredWhen: 'political', offeredWhen: 'political', label: 'ai-generated', mechanism: 'platform-flag',
    source: 'Meta: advertisers must disclose digitally created or altered content in political or social-issue ads',
    dated: '2026-10-20', status: 'provisional',
  },
  {
    id: 'google-political-ai', destination: 'ads:google', requiredWhen: 'political', offeredWhen: 'political', label: 'ai-generated', mechanism: 'platform-flag',
    source: 'Google political content policy: election ads with synthetic content must carry a disclosure',
    dated: '2026-10-20', status: 'provisional',
  },
];

/** The disclosure an AI asset needs at a destination. Non-AI content needs none. */
export function disclosureFor(input: { destination: DisclosureDestination; ai: boolean; edited: boolean; political: boolean }, policy: typeof DISCLOSURE_POLICY = DISCLOSURE_POLICY, rules: readonly DisclosureRule[] = DISCLOSURE_RULES): AiDisclosure {
  const none: AiDisclosure = { required: false, label: 'none', mechanism: 'none', basis: 'none' };
  if (!input.ai) return none;
  const applies = (when: 'always' | 'political' | undefined): boolean => when === 'always' || (when === 'political' && input.political);
  for (const row of rules) {
    if (row.destination !== input.destination) continue;
    const byRule = applies(row.requiredWhen);
    const byPolicy = policy === 'label-where-offered' && applies(row.offeredWhen);
    if (!byRule && !byPolicy) continue;
    return {
      required: true,
      label: input.edited && row.label === 'ai-generated' ? 'ai-edited' : row.label,
      mechanism: row.mechanism,
      basis: `${DISCLOSURE_RULES_VERSION}:${row.id}`,
      requiredBy: byRule ? 'rule' : 'policy',
    };
  }
  return none;
}
