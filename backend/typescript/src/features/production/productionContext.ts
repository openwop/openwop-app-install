/**
 * Production context builder (ADR 0172) — a PURE ranking function that scores the
 * internal team (Profiles, ADR 0005) + the Vendor Directory against a brief's
 * enabled channels, then formats a TOKEN-CAPPED context block for the production-
 * planning prompt. Ported from MyndHyve `ProductionContextBuilder` with the
 * port-not-clone correction: openwop `Profile.skills` carry free-text NAMES (no
 * category enum), so team relevance is scored by inferring a category from each
 * skill name (`SKILL_NAME_CATEGORY_HINTS`) instead of reading a category field.
 *
 * Pure + side-effect-free ⇒ trivially unit-testable and safe to call from both the
 * `ctx.features.production` surface and the plan-generate node.
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 */

import type { Profile } from '../profiles/profilesService.js';
import type { Vendor, ProductionCategory } from './productionService.js';

/** Rough chars-per-token; the cap is deliberately conservative (MyndHyve parity). */
const TOKEN_BUDGET = 1500;
const CHARS_PER_TOKEN = 4;
const MAX_TEAM_MEMBERS = 10;
const MAX_VENDORS = 5;

/** Brief channel type → the production categories it needs. */
const CHANNEL_CATEGORY_MAP: Record<string, ProductionCategory[]> = {
  landing_page: ['design', 'development', 'writing'],
  ad_variants: ['design', 'writing', 'strategy', 'social-media'],
  email_sequence: ['writing', 'design', 'strategy'],
  creative_briefs: ['design', 'video', 'photography', 'audio'],
  social_posts: ['writing', 'social-media', 'design', 'photography'],
};

/** Keyword hints mapping a free-text skill/interest name → a category. First match wins. */
const SKILL_NAME_CATEGORY_HINTS: Array<{ re: RegExp; category: ProductionCategory }> = [
  { re: /(ui|ux|visual|graphic|brand|illustrat|figma|photoshop|design)/i, category: 'design' },
  { re: /(react|typescript|javascript|node|python|api|engineer|develop|frontend|backend|code)/i, category: 'development' },
  { re: /(copy|content|writ|editor|blog|script)/i, category: 'writing' },
  { re: /(video|motion|animation|editing|premiere|after effects)/i, category: 'video' },
  { re: /(photo|camera|shoot|lightroom)/i, category: 'photography' },
  { re: /(audio|sound|music|podcast|voice)/i, category: 'audio' },
  { re: /(strateg|planning|research|analyst|market)/i, category: 'strategy' },
  { re: /(social|instagram|tiktok|linkedin|community)/i, category: 'social-media' },
];

function inferCategory(name: string): ProductionCategory | null {
  for (const { re, category } of SKILL_NAME_CATEGORY_HINTS) if (re.test(name)) return category;
  return null;
}

export interface RankedMember {
  userId: string;
  name: string;
  role: string;
  score: number;
  matchingSkills: string[];
  availability?: string;
}
export interface RankedVendor {
  vendorId: string;
  name: string;
  type: Vendor['type'];
  score: number;
  matchingCapabilities: string[];
  contractStatus: Vendor['contractStatus'];
}
export interface ProductionContextResult {
  relevantCategories: ProductionCategory[];
  teamCapabilitySection: string;
  /** RECORDABLE — never carries rates. Safe to echo into node outputs, which
   *  land in the tenant-scoped run event log (PROD2-R3). */
  vendorSection: string;
  /** IN-PROCESS ONLY — the same ranking WITH the rates the caller is entitled
   *  to see. For prompt assembly; never echo it into a node's outputs. */
  vendorSectionPriced: string;
  rankedMembers: RankedMember[];
  rankedVendors: RankedVendor[];
  gaps: ProductionCategory[];
}

export function relevantCategoriesFor(channels: string[]): ProductionCategory[] {
  const set = new Set<ProductionCategory>();
  for (const c of channels) for (const cat of CHANNEL_CATEGORY_MAP[c] ?? []) set.add(cat);
  return [...set];
}

/** A display name for a profile (jobTitle is descriptive, not identity). */
function memberRole(p: Profile): string {
  return p.jobTitle ?? p.department ?? 'Team member';
}

function rankMember(p: Profile, relevant: Set<ProductionCategory>): RankedMember {
  const matching = new Set<string>();
  let score = 0;
  for (const skill of p.skills ?? []) {
    const cat = inferCategory(skill.name);
    if (cat && relevant.has(cat)) {
      score += 2;
      if (skill.proficiency >= 4) score += 1; // expert bonus
      matching.add(skill.name);
    }
  }
  // ADR 0356 P6 — explicit growth aspirations outrank generic interests.
  for (const interest of (p.growthInterests?.length ? p.growthInterests : p.interests) ?? []) {
    const cat = inferCategory(interest);
    if (cat && relevant.has(cat)) score += 1; // growth-interest alignment
  }
  return {
    userId: p.userId,
    // Descriptive display label (never the opaque userId echoed as a name).
    name: memberRole(p),
    role: memberRole(p),
    score,
    matchingSkills: [...matching],
    ...(p.availability?.status ? { availability: p.availability.status } : {}),
  };
}

function rankVendor(v: Vendor, relevant: Set<ProductionCategory>): RankedVendor {
  const matching: string[] = [];
  let score = 0;
  for (const cap of v.capabilities ?? []) {
    if (relevant.has(cap.category)) {
      score += 2;
      if ((cap.qualityRating ?? 0) >= 4) score += 1;
      matching.push(cap.name);
    }
  }
  if (v.contractStatus === 'preferred') score += 1; // preferred vendors surface higher
  return { vendorId: v.vendorId, name: v.name, type: v.type, score, matchingCapabilities: matching, contractStatus: v.contractStatus };
}

/** Truncate a section so team + vendor together stay within the token budget. */
function capToBudget(team: string, vendor: string): { team: string; vendor: string } {
  const budgetChars = TOKEN_BUDGET * CHARS_PER_TOKEN;
  if (team.length + vendor.length <= budgetChars) return { team, vendor };
  // Split the budget proportionally, preferring to keep the team section.
  const teamShare = Math.floor(budgetChars * 0.6);
  const vendorShare = budgetChars - teamShare;
  const trunc = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3))}...`);
  return { team: trunc(team, teamShare), vendor: trunc(vendor, vendorShare) };
}

export function buildProductionContext(input: {
  channels: string[];
  profiles: Profile[];
  vendors: Vendor[];
  /** UX_UPGRADE-production R2 (PROD2-B2) — include each vendor's price ranges in
   *  the prompt block. The caller decides entitlement with the SAME
   *  `canSeeVendorPricing` predicate the REST face and the chat tool use; this
   *  builder never resolves access itself.
   *
   *  Why it matters: the node's system prompt asks for "a budget estimate" and
   *  says "Ground every recommendation in the provided context" — and the
   *  context contained ZERO pricing, because `rankVendor` never read
   *  `priceRanges` and the KB path deliberately strips figures. So every
   *  min/max the model emitted was invented, then sanitised into a typed
   *  record, AJV-validated, persisted, and rendered to the user as a plain
   *  number range. Grounding a budget in a context that structurally cannot
   *  contain one is an instruction to fabricate. */
  includePricing?: boolean;
}): ProductionContextResult {
  const relevantCats = relevantCategoriesFor(input.channels);
  const relevant = new Set(relevantCats);

  if (relevant.size === 0) {
    return { relevantCategories: [], teamCapabilitySection: '', vendorSection: '', vendorSectionPriced: '', rankedMembers: [], rankedVendors: [], gaps: [] };
  }

  const rankedMembers = input.profiles
    .map((p) => rankMember(p, relevant))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TEAM_MEMBERS);

  const rankedVendors = input.vendors
    .map((v) => rankVendor(v, relevant))
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_VENDORS);

  // Gap analysis: categories the brief needs that NEITHER team nor vendors cover.
  const covered = new Set<ProductionCategory>();
  for (const p of input.profiles) for (const s of p.skills ?? []) { const c = inferCategory(s.name); if (c) covered.add(c); }
  for (const v of input.vendors) for (const c of v.capabilities ?? []) covered.add(c.category);
  const gaps = relevantCats.filter((c) => !covered.has(c));

  const teamLines = rankedMembers.map(
    (m) => `- ${m.role}${m.availability ? ` (${m.availability})` : ''} — skills: ${m.matchingSkills.join(', ') || 'general'}`,
  );
  // PROD2-B2 — the price ranges the caller is entitled to see, for the matching
  // capabilities only (the whole directory would blow the token cap).
  const priceFor = (vendorId: string): string => {
    if (!input.includePricing) return '';
    const v = input.vendors.find((x) => x.vendorId === vendorId);
    const ranges = (v?.priceRanges ?? []).filter((r) => r && typeof r.min === 'number' && typeof r.max === 'number');
    if (ranges.length === 0) return ' — no pricing on file';
    return ` — rates: ${ranges.map((r) => `${r.capability} ${r.min}-${r.max}/${r.unit}`).join('; ')}`;
  };
  const vendorLine = (v: RankedVendor, withPrice: boolean): string =>
    `- ${v.name} [${v.type}${v.contractStatus === 'preferred' ? ', preferred' : ''}] — ${v.matchingCapabilities.join(', ') || 'general'}${withPrice ? priceFor(v.vendorId) : ''}`;
  const vendorLines = rankedVendors.map((v) => vendorLine(v, false));
  const vendorLinesPriced = rankedVendors.map((v) => vendorLine(v, true));

  const teamSection = teamLines.length ? `INTERNAL TEAM (ranked by fit):\n${teamLines.join('\n')}` : 'INTERNAL TEAM: no strong matches for these channels.';
  const vendorSection = vendorLines.length ? `EXTERNAL VENDORS (ranked by fit):\n${vendorLines.join('\n')}` : 'EXTERNAL VENDORS: none on file for these channels.';
  // PROD2-R3 — TWO projections of the same ranking. `vendorSection` is the
  // RECORDABLE one and never carries rates; `vendorSectionPriced` is for
  // in-process prompt use only. A node's outputs land in the run event log, and
  // run reads are TENANT-scoped with no org check — so a single section
  // carrying rates would let any viewer in the tenant read another org's
  // pricing back out of the run bundle, re-opening at the log what PROD2-B1
  // just closed at the surface.
  const vendorSectionPriced = vendorLinesPriced.length
    ? `EXTERNAL VENDORS (ranked by fit):\n${vendorLinesPriced.join('\n')}`
    : vendorSection;
  const gapNote = gaps.length ? `\nCOVERAGE GAPS (no internal or vendor coverage): ${gaps.join(', ')}` : '';

  const capped = capToBudget(teamSection, vendorSection + gapNote);
  const cappedPriced = capToBudget(teamSection, vendorSectionPriced + gapNote);
  return {
    relevantCategories: relevantCats,
    teamCapabilitySection: capped.team,
    vendorSection: capped.vendor,
    vendorSectionPriced: cappedPriced.vendor,
    rankedMembers,
    rankedVendors,
    gaps,
  };
}
