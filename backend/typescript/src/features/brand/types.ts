/**
 * Brand entity types. A `Brand` carries two optional facets:
 *
 *   - **voice** (ADR 0155) — how a workspace *sounds*: voice profile, formality,
 *     tone registers, approved/banned phrases, positioning, per-channel rules.
 *     Drives the Campaign Studio messaging kernel + compliance scorer.
 *   - **identity** (ADR 0170) — how the *app* looks: logo, colors, typography,
 *     favicon, title, theme. The single reserved app brand (`brand:host-app`,
 *     ADR 0170) carries this and drives the white-label chrome at runtime; a
 *     tenant marketing brand MAY carry it but it is **inert** — only the reserved
 *     app brand is read by `/public-brand` and applied to `:root`.
 *
 * One model, two facets, distinguished by brand id — the operator's "1:1 mapping"
 * (the same relationship the homepage has to CMS pages). Persisted on the generic
 * `DurableCollection`; no schema migration.
 *
 * @see docs/adr/0155-campaign-studio-brand-guardrails.md
 * @see docs/adr/0170-brand-identity-app-and-marketing-consolidation.md
 */

/** The five Campaign Studio channels per-channel voice rules key on (ADR 0157). */
export const BRAND_CHANNELS = [
  'landing_page',
  'ad_variants',
  'email_sequence',
  'creative_briefs',
  'social_posts',
] as const;
export type BrandChannel = (typeof BRAND_CHANNELS)[number];

/** Formality on a 1 (very casual) … 5 (very formal) scale, with editor labels. */
export const FORMALITY_LABELS: Record<number, string> = {
  1: 'Very casual',
  2: 'Casual',
  3: 'Neutral',
  4: 'Formal',
  5: 'Very formal',
};

/** A named tone register (e.g. "thought leadership") layered over the base voice. */
export interface ToneRegister {
  name: string;
  description: string;
  /** Optional per-register formality override (1–5); falls back to the brand's. */
  formalityLevel?: number;
  samplePhrases: string[];
  avoidPhrases: string[];
}

/** Per-channel voice override (LinkedIn = thought leadership, Meta = casual, …). */
export interface ChannelVoiceRule {
  channel: BrandChannel;
  tone: string;
  /** Optional formality override for this channel (1–5). */
  formalityOverride?: number;
  /** Optional hard length cap for generated content on this channel (chars). */
  maxLength?: number;
  samplePhrases: string[];
  avoidPhrases: string[];
}

/** The voice half of a brand — drives prompt injection + the LLM compliance leg. */
export interface BrandVoiceProfile {
  /** One-line personality (e.g. "confident, not arrogant"). */
  voice: string;
  /** Markdown writing guidelines. */
  guidelines: string;
  /** 1 (very casual) … 5 (very formal). */
  formalityLevel: number;
  /** Exemplar phrases that sound on-brand. */
  samplePhrases: string[];
  /** Phrases to steer away from (soft — warnings, not hard violations). */
  avoidPhrases: string[];
  /** Optional named registers layered over the base voice. */
  toneRegisters: ToneRegister[];
}

/** Positioning + approved/banned language — the deterministic guardrail inputs. */
export interface BrandPositioning {
  tagline: string;
  elevatorPitch: string;
  differentiators: string[];
  competitiveFrame: string;
}

export interface BrandKeyPhrases {
  /** Approved taglines / value props the generator should reach for first. */
  approvedTaglines: string[];
  valuePropositions: string[];
  productDescriptors: string[];
  /** HARD violations — any banned phrase caps a compliance score at ≤30. */
  bannedPhrases: string[];
}

/** Governance maps onto `accessControl` (RFC 0049), NOT a parallel ACL. */
export interface BrandGovernance {
  /** 'none' = any editor; 'partial' = listed editors; 'full' = org-admin only. */
  lockLevel: 'none' | 'partial' | 'full';
  /** User ids permitted to edit under 'partial' (advisory — authority stays RBAC). */
  allowedEditors: string[];
  /** When true, downstream publish flows SHOULD gate on approval (ADR 0157). */
  requireApproval: boolean;
}

/** The closed set of brandable color tokens (ADR 0170 token contract). Each maps
 *  to a `:root` design token at runtime (Phase 5). The functional/status/category
 *  palette is deliberately NOT brandable (it encodes meaning — DESIGN.md §3). */
export const BRAND_COLOR_KEYS = ['accent', 'paper', 'paper2', 'ink', 'ink2', 'rule', 'themeColor'] as const;
export type BrandColorKey = (typeof BRAND_COLOR_KEYS)[number];

/** CSS custom properties the advanced theme-override tier may set (ADR 0171). A
 *  closed allowlist — the override can ONLY touch these tokens (never arbitrary
 *  properties), and every value is `safeColor`-validated. The accent ramp + surfaces
 *  + on-colors are the generated tier; the functional/status + category tokens are
 *  semantic (DESIGN.md §3) and advanced-only. */
export const THEMEABLE_TOKENS = [
  '--clay', '--clay-soft', '--clay-text', '--clay-strong', '--clay-rule', '--clay-wash', '--clay-glow', '--clay-bg-hi',
  '--paper', '--paper-2', '--rule', '--rule-2', '--ink', '--ink-2', '--ink-3', '--star-glow',
  '--color-success', '--color-warning', '--color-danger', '--color-ai', '--color-info',
  '--color-success-text', '--color-warning-text', '--color-danger-text', '--color-ai-text', '--color-info-text',
  '--cat-flow', '--cat-data', '--cat-control', '--cat-ai', '--cat-integration',
] as const;
export type ThemeableToken = (typeof THEMEABLE_TOKENS)[number];

/** Per-mode token override maps (advanced tier) — keys ⊆ THEMEABLE_TOKENS, values
 *  CSS-grammar-validated. Injected to `:root`/`.theme-dark` at runtime (ADR 0170). */
export interface BrandThemeOverride { light?: Record<string, string>; dark?: Record<string, string> }

/** The generative theme inputs (ADR 0171) — the small set that DETERMINISTICALLY
 *  produces the full light/dark token set (src/brand/theme/generate.ts). Persisting
 *  the inputs (not the expanded tokens) keeps the payload tiny + replay-safe.
 *  MIRROR: the frontend `ThemeInputs` (src/brand/theme/generate.ts) + the
 *  `PublicBrandIdentity.theme` shape mirror this — see the MIRROR CONTRACT. */
export interface BrandTheme {
  defaultMode?: 'system' | 'light' | 'dark';
  /** Brand seed colors (CSS-safe). `accentSeed` is the one required-ish input. */
  accentSeed?: string;
  neutralSeed?: string;
  secondarySeed?: string;
  contrastLevel?: 'standard' | 'medium' | 'high';
  radius?: 'sm' | 'md' | 'lg';
  density?: 'compact' | 'comfortable';
  /** Advanced tier: explicit per-token overrides layered over the generated set. */
  override?: BrandThemeOverride;
}

/** The visual-identity facet (ADR 0170). Mirrors the frontend `BrandConfig`
 *  (src/brand/defaults.ts) so the Phase-2 boot seed maps field-for-field. All
 *  fields optional; the reserved app brand fills them, a tenant brand need not.
 *  MIRROR CONTRACT: this shape is hand-mirrored to the frontend `PublicBrandIdentity`
 *  (frontend/react/src/brand/applyBrand.ts) — see the contract there before adding a
 *  field. */
export interface BrandIdentity {
  productName?: string;
  /** Three-part header wordmark (pre / emphasis / sub). */
  wordmark?: { pre: string; emphasis: string; sub: string };
  tagline?: string;
  footerText?: string;
  instanceName?: string;
  assistantName?: string;
  documentTitle?: string;
  /** Logo assets — URL / root-relative / small `data:image` (validated). */
  logo?: { markSrc?: string; lockupSrc?: string; faviconSrc?: string };
  /** Brandable colors, closed key set → `:root` tokens. CSS-grammar-validated. */
  colors?: Partial<Record<BrandColorKey, string>>;
  typography?: { serif?: string; sans?: string; mono?: string; fontsHref?: string };
  /** Theme: default light/dark mode + the generative inputs + advanced override (ADR 0171). */
  theme?: BrandTheme;
  domains?: { primaryDomain?: string; homeUrl?: string; repoUrl?: string };
  /** Ported MyndHyve BrandingPolicy chrome toggles. */
  chromePolicy?: { showPoweredBy?: boolean; customFooter?: string; customCopyright?: string };
}

/** A brand. Tenant + org scoped; persisted on `DurableCollection`. Carries an
 *  optional `voiceProfile`-led marketing facet (ADR 0155) and/or an optional
 *  `identity` app-chrome facet (ADR 0170). */
export interface Brand {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  /** Optional parent for a product-line sub-brand (cascade resolution deferred). */
  parentBrandId?: string;
  voiceProfile: BrandVoiceProfile;
  positioning: BrandPositioning;
  keyPhrases: BrandKeyPhrases;
  channelVoiceRules: ChannelVoiceRule[];
  governance: BrandGovernance;
  /** Visual-identity facet (ADR 0170) — inert unless this is the reserved app brand. */
  identity?: BrandIdentity;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A single guardrail finding surfaced by the deterministic scorer (Phase 2). */
export interface ComplianceIssue {
  category: 'banned-phrase' | 'formality' | 'length' | 'voice';
  severity: 'error' | 'warning' | 'info';
  description: string;
  suggestion?: string;
}

/** The deterministic compliance report (Phase 2). The node (Phase 3) blends in
 *  an LLM leg to produce the final 0–100 `overallScore`. */
export interface ComplianceReport {
  /** 0–100 (deterministic-only here; the node blends the LLM leg). */
  deterministicScore: number;
  issues: ComplianceIssue[];
  /** True when a banned phrase was matched (caps the overall score ≤30). */
  hasBannedPhrase: boolean;
  /** Whether the content meets the pass threshold (default 70). */
  passesThreshold: boolean;
  checkedAt: string;
}

/** The default editable shape the UI/service seeds a brand from. */
export const EMPTY_VOICE_PROFILE: BrandVoiceProfile = {
  voice: '',
  guidelines: '',
  formalityLevel: 3,
  samplePhrases: [],
  avoidPhrases: [],
  toneRegisters: [],
};

export const EMPTY_POSITIONING: BrandPositioning = {
  tagline: '',
  elevatorPitch: '',
  differentiators: [],
  competitiveFrame: '',
};

export const EMPTY_KEY_PHRASES: BrandKeyPhrases = {
  approvedTaglines: [],
  valuePropositions: [],
  productDescriptors: [],
  bannedPhrases: [],
};

export const DEFAULT_GOVERNANCE: BrandGovernance = {
  lockLevel: 'none',
  allowedEditors: [],
  requireApproval: false,
};

/** An empty identity facet — the editor/service seeds from this. */
export const EMPTY_IDENTITY: BrandIdentity = {};
