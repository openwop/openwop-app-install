/**
 * Brand compliance scorer + voice resolver (ADR 0155, Phase 2).
 *
 * PURE library functions — no I/O, deterministic, unit-testable, replay-trivial.
 * The deterministic compliance leg (banned/avoid phrase, formality register,
 * per-channel length) lives here (60 % of the blended score); the LLM leg is
 * layered in at the node boundary (Phase 3) where `ctx.callAI` exists. Keeping
 * the deterministic half pure is the seam the ADR §"compliance scorer split"
 * decision (and the Phase-1 /architect pass) blessed.
 *
 * @see docs/adr/0155-campaign-studio-brand-guardrails.md
 */

import { FORMALITY_LABELS, type Brand, type BrandChannel, type ComplianceIssue, type ComplianceReport } from './types.js';

/** Pass threshold for the deterministic score (0–100). */
export const DEFAULT_PASS_THRESHOLD = 70;
/** A banned-phrase hit caps the overall score at this ceiling (MyndHyve parity). */
export const BANNED_SCORE_CEILING = 30;

/** Escape a user-supplied phrase for safe use inside a RegExp (no ReDoS — the
 *  phrase becomes a literal; no user metacharacters survive). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive presence test for a (possibly multi-word) phrase.
 *  Falls back to a substring test when the phrase has no word-boundary anchor
 *  (e.g. starts/ends with punctuation). */
function containsPhrase(haystackLower: string, phrase: string): boolean {
  const needle = phrase.trim().toLowerCase();
  if (!needle) return false;
  const anchored = /^\w/.test(needle) && /\w$/.test(needle);
  if (!anchored) return haystackLower.includes(needle);
  const re = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i');
  return re.test(haystackLower);
}

/** Casual markers used by the formality heuristic (deterministic, English v1). */
const CASUAL_MARKERS = [
  'gonna', 'wanna', 'gotta', 'kinda', 'sorta', 'yeah', 'nope', 'hey', 'awesome',
  'super', 'totally', 'stuff', 'cool', 'lol', 'btw',
];

export interface ScoreOptions {
  /** When set, applies that channel's voice rule (length cap, avoid phrases). */
  channel?: BrandChannel;
  /** Override the pass threshold (default 70). */
  passThreshold?: number;
}

/**
 * Score `content` against a brand's deterministic guardrails. Returns a 0–100
 * `deterministicScore`, the issues found, and whether a banned phrase matched
 * (which caps the score at {@link BANNED_SCORE_CEILING}).
 */
export function scoreComplianceDeterministic(
  content: string,
  brand: Brand,
  opts: ScoreOptions = {},
): ComplianceReport {
  const text = String(content ?? '');
  const lower = text.toLowerCase();
  const issues: ComplianceIssue[] = [];
  let score = 100;

  // ── HARD: banned phrases (caps the score) ──
  let hasBannedPhrase = false;
  for (const phrase of brand.keyPhrases.bannedPhrases) {
    if (containsPhrase(lower, phrase)) {
      hasBannedPhrase = true;
      issues.push({
        category: 'banned-phrase',
        severity: 'error',
        description: `Content uses the banned phrase "${phrase}".`,
        suggestion: 'Remove or replace this phrase — it violates the brand guardrails.',
      });
    }
  }

  // ── SOFT: avoid phrases (voice + the active channel rule) ──
  const channelRule = opts.channel
    ? brand.channelVoiceRules.find((r) => r.channel === opts.channel)
    : undefined;
  const avoid = [...brand.voiceProfile.avoidPhrases, ...(channelRule?.avoidPhrases ?? [])];
  for (const phrase of avoid) {
    if (containsPhrase(lower, phrase)) {
      issues.push({
        category: 'voice',
        severity: 'warning',
        description: `Content uses the off-voice phrase "${phrase}".`,
        suggestion: 'Prefer an on-brand alternative.',
      });
      score -= 8;
    }
  }

  // ── SOFT: formality register heuristic ──
  const formality = channelRule?.formalityOverride ?? brand.voiceProfile.formalityLevel;
  if (formality >= 4) {
    const casual = CASUAL_MARKERS.filter((m) => containsPhrase(lower, m));
    if (casual.length > 0) {
      issues.push({
        category: 'formality',
        severity: 'warning',
        description: `Content reads casual (${casual.slice(0, 3).join(', ')}…) but the brand voice is ${FORMALITY_LABELS[formality] ?? 'formal'}.`,
        suggestion: 'Tighten the tone to match the brand formality.',
      });
      score -= Math.min(20, casual.length * 6);
    }
  }

  // ── HARD-ish: per-channel length cap ──
  if (channelRule?.maxLength && text.length > channelRule.maxLength) {
    issues.push({
      category: 'length',
      severity: 'error',
      description: `Content is ${text.length} chars; the ${opts.channel} limit is ${channelRule.maxLength}.`,
      suggestion: `Trim to ${channelRule.maxLength} characters or fewer.`,
    });
    score -= 25;
  }

  if (hasBannedPhrase) score = Math.min(score, BANNED_SCORE_CEILING);
  score = Math.max(0, Math.min(100, Math.round(score)));

  const threshold = opts.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  return {
    deterministicScore: score,
    issues,
    hasBannedPhrase,
    passesThreshold: score >= threshold && !hasBannedPhrase,
    checkedAt: new Date().toISOString(),
  };
}

export interface ResolveVoiceOptions {
  /** Apply the named channel's voice rule. */
  channel?: BrandChannel;
  /** Apply a named tone register over the base voice. */
  register?: string;
}

/**
 * Render a brand's voice into a prompt-injectable text block. Downstream
 * generators (ADR 0156/0157) prepend this to their AI prompts so every channel
 * sounds the same. Pure string assembly — no AI call.
 */
export function resolveVoice(brand: Brand, opts: ResolveVoiceOptions = {}): string {
  const vp = brand.voiceProfile;
  const channelRule = opts.channel ? brand.channelVoiceRules.find((r) => r.channel === opts.channel) : undefined;
  const register = opts.register ? vp.toneRegisters.find((r) => r.name === opts.register) : undefined;
  const formality = channelRule?.formalityOverride ?? register?.formalityLevel ?? vp.formalityLevel;

  const lines: string[] = [];
  lines.push(`# Brand voice — ${brand.name}`);
  if (vp.voice) lines.push(`Voice: ${vp.voice}`);
  lines.push(`Formality: ${formality}/5 (${FORMALITY_LABELS[formality] ?? 'neutral'}).`);
  if (vp.guidelines) lines.push(`\nGuidelines:\n${vp.guidelines}`);

  if (register) {
    lines.push(`\nTone register "${register.name}": ${register.description}`);
    if (register.samplePhrases.length) lines.push(`On-tone examples: ${register.samplePhrases.join('; ')}`);
  }
  if (channelRule) {
    lines.push(`\nChannel (${channelRule.channel}) tone: ${channelRule.tone}`);
    if (channelRule.maxLength) lines.push(`Hard length limit: ${channelRule.maxLength} characters.`);
    if (channelRule.samplePhrases.length) lines.push(`Channel examples: ${channelRule.samplePhrases.join('; ')}`);
  }

  if (brand.positioning.tagline) lines.push(`\nPositioning: ${brand.positioning.tagline}`);
  if (brand.positioning.differentiators.length) {
    lines.push(`Differentiators: ${brand.positioning.differentiators.join('; ')}`);
  }
  const approved = [...brand.keyPhrases.approvedTaglines, ...brand.keyPhrases.valuePropositions];
  if (approved.length) lines.push(`\nReach for these approved phrases first: ${approved.join('; ')}`);

  const avoid = [...vp.avoidPhrases, ...(channelRule?.avoidPhrases ?? [])];
  if (avoid.length) lines.push(`Avoid (off-voice): ${avoid.join('; ')}`);
  if (brand.keyPhrases.bannedPhrases.length) {
    lines.push(`NEVER use (banned): ${brand.keyPhrases.bannedPhrases.join('; ')}`);
  }
  if (vp.samplePhrases.length) lines.push(`\nOn-brand sample phrasing: ${vp.samplePhrases.join('; ')}`);

  return lines.join('\n');
}
