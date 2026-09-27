/**
 * ADR 0545 P1 — question identity.
 *
 * The bank's whole promise is "a question is asked at most once, ever". That
 * only holds if two employers phrasing the same question differently land on ONE
 * key. So the identity is a NORMALISED form, derived deterministically, while
 * the raw question text is kept alongside it — the `contactIdentityService`
 * discipline (normalise for the index, never destroy the original), which is
 * also what keeps it replay-stable: a key that drifted with a library version
 * would silently re-ask questions a user already answered.
 *
 * ## Three tiers, cheapest first, and each one is falsifiable
 *
 *  1. an explicit SYNONYM table for the standard bank — curated, exact, and the
 *     only tier that can map wildly different wordings ("Are you legally
 *     authorized to work in the US?" ↔ "Do you have US work authorization?");
 *  2. exact match on the slugified stem;
 *  3. token-overlap (Jaccard) against known keys above a threshold, the
 *     `matchCandidatesService` precedent.
 *
 * Tier 3 is the one that can be WRONG, and being wrong here means answering an
 * employer's question with the answer to a different question. So the threshold
 * is deliberately high and the result is advisory: `resolveQuestionKey` reports
 * HOW it matched, and the bank refuses to auto-answer on a fuzzy match alone
 * (see `answerBank.ts`). A confident-looking wrong answer on a job application
 * is worse than an unanswered field, which is merely a parked item.
 */
import { slugify } from '../../../host/slug.js';

/** How a question text was resolved to a key. The caller MUST branch on this. */
export type KeyMatch = 'synonym' | 'exact' | 'fuzzy' | 'new';

export interface ResolvedKey {
  key: string;
  match: KeyMatch;
  /** Jaccard overlap for a fuzzy match; 1 for synonym/exact. */
  score: number;
}

/**
 * Words that carry no identity. Stripped before comparison so "What is your
 * salary expectation?" and "Salary expectation" are the same question.
 */
const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'did', 'you', 'your', 'yours', 'we', 'us',
  'please', 'kindly', 'what', 'which', 'how', 'have', 'has', 'will', 'would', 'can', 'could',
  'to', 'of', 'in', 'on', 'for', 'at', 'by', 'with', 'and', 'or', 'if', 'be', 'been', 'am',
  'this', 'that', 'it', 'any', 'all', 'from', 'as', 'about', 'currently', 'applicant',
]);

const tokens = (s: string): string[] =>
  slugify(s, '')
    .split('-')
    .filter((w) => w.length > 0 && !STOP.has(w));

/**
 * The curated identities for the standard bank (D2).
 *
 * Each entry is a canonical key plus the phrasings real forms use. This is the
 * only tier that can bridge genuinely different wordings, and it is a flat table
 * on purpose: it is reviewable, diffable, and a mistake in it is visible rather
 * than emergent from a scoring function.
 */
const SYNONYMS: ReadonlyArray<{ key: string; phrasings: string[] }> = [
  {
    key: 'work-auth.requires-sponsorship',
    phrasings: [
      'will you now or in the future require sponsorship for employment visa status',
      'do you require sponsorship',
      'will you require visa sponsorship',
      'do you now or in the future require sponsorship to work',
    ],
  },
  {
    key: 'work-auth.legally-authorised',
    phrasings: [
      'are you legally authorized to work in the united states',
      'do you have work authorization',
      // BOTH spellings, and both with and without "legally". The P2 coverage
      // measurement caught this: `authorized` vs `authorised` costs enough
      // token overlap to drop below the threshold, so the AMERICAN spelling of
      // a US-centric question was missing while the British one matched. That
      // is the measurement doing its job — the fix is the synonym table, never
      // the threshold.
      'are you legally authorized to work in the country of employment',
      'are you authorised to work in the country of employment',
      'are you legally authorised to work in the country of employment',
      'are you legally eligible to work',
    ],
  },
  {
    key: 'compensation.expectation',
    phrasings: [
      'what are your salary expectations',
      'salary expectation',
      'desired compensation',
      'expected base salary',
      'what is your expected salary',
    ],
  },
  {
    key: 'availability.notice-period',
    phrasings: ['what is your notice period', 'notice period', 'how much notice do you need to give'],
  },
  {
    key: 'availability.start-date',
    phrasings: ['when can you start', 'earliest start date', 'what is your availability to start'],
  },
  {
    key: 'location.willing-to-relocate',
    phrasings: ['are you willing to relocate', 'would you relocate for this role', 'relocation'],
  },
  {
    key: 'location.remote-preference',
    phrasings: ['what is your work preference', 'remote hybrid or onsite', 'do you prefer remote work'],
  },
  {
    key: 'links.portfolio',
    phrasings: ['portfolio url', 'link to your portfolio', 'website'],
  },
  {
    key: 'links.linkedin',
    phrasings: ['linkedin profile', 'linkedin url', 'link to linkedin'],
  },
  {
    key: 'references.available',
    phrasings: ['can you provide references', 'are references available on request'],
  },
];

/** phrasing-token-set → canonical key, precomputed once. */
const SYNONYM_INDEX: ReadonlyArray<{ key: string; tokens: Set<string> }> = SYNONYMS.flatMap(({ key, phrasings }) =>
  phrasings.map((p) => ({ key, tokens: new Set(tokens(p)) })),
);

const SPECIAL_INDEX: ReadonlyArray<{ key: string; tokens: Set<string> }> = [
  { key: 'eeo.disability', tokens: new Set(tokens('do you have a disability')) },
  { key: 'eeo.disability', tokens: new Set(tokens('voluntary self identification of disability')) },
  { key: 'eeo.veteran-status', tokens: new Set(tokens('are you a protected veteran')) },
  { key: 'eeo.veteran-status', tokens: new Set(tokens('veteran status')) },
  { key: 'eeo.race-ethnicity', tokens: new Set(tokens('race or ethnicity')) },
  { key: 'eeo.race-ethnicity', tokens: new Set(tokens('what is your ethnicity')) },
  { key: 'eeo.gender', tokens: new Set(tokens('what is your gender')) },
];

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/**
 * The fuzzy threshold.
 *
 * High on purpose. Tier 3's failure mode is answering a question with another
 * question's answer, which reaches an employer under the applicant's name. A
 * missed match merely parks one item — an outcome ADR 0545 D3 already designs
 * for — so the asymmetry says: refuse when unsure.
 */
export const FUZZY_THRESHOLD = 0.75;

/** Is this question one we refuse to keep an answer to? */
export function specialCategoryKeyFor(question: string): string | null {
  const q = new Set(tokens(question));
  if (q.size === 0) return null;
  for (const e of SPECIAL_INDEX) {
    // Deliberately LOWER than FUZZY_THRESHOLD: over-detecting a special category
    // costs one parked field; under-detecting means storing a disability
    // disclosure in a plaintext row. The asymmetry runs the other way here.
    if (jaccard(q, e.tokens) >= 0.5) return e.key;
  }
  return null;
}

/**
 * Resolve a question's text to a stable key.
 *
 * `knownKeys` are the keys this subject already has answers for — passed in
 * rather than read here, so this module stays pure and deterministic (and so a
 * test can drive it without a store).
 */
export function resolveQuestionKey(question: string, knownKeys: readonly string[] = []): ResolvedKey {
  const special = specialCategoryKeyFor(question);
  if (special) return { key: special, match: 'synonym', score: 1 };

  const q = new Set(tokens(question));
  if (q.size === 0) return { key: '', match: 'new', score: 0 };

  // 1 — curated synonyms. Exact token-set equality first, then a high-overlap
  //     pass so a form that adds "(required)" still matches.
  let best: { key: string; score: number } | null = null;
  for (const e of SYNONYM_INDEX) {
    const s = jaccard(q, e.tokens);
    if (s === 1) return { key: e.key, match: 'synonym', score: 1 };
    if (s >= FUZZY_THRESHOLD && (!best || s > best.score)) best = { key: e.key, score: s };
  }
  if (best) return { key: best.key, match: 'synonym', score: best.score };

  // 2 — exact match on the normalised stem of a key this subject already has.
  const stem = [...q].sort().join('-');
  for (const k of knownKeys) if (k === stem) return { key: k, match: 'exact', score: 1 };

  // 3 — token overlap against known keys. Advisory: the caller must not
  //     auto-answer on this alone.
  let fuzzy: { key: string; score: number } | null = null;
  for (const k of knownKeys) {
    const s = jaccard(q, new Set(k.split(/[.\-]/).filter((w) => w && !STOP.has(w))));
    if (s >= FUZZY_THRESHOLD && (!fuzzy || s > fuzzy.score)) fuzzy = { key: k, score: s };
  }
  if (fuzzy) return { key: fuzzy.key, match: 'fuzzy', score: fuzzy.score };

  return { key: stem, match: 'new', score: 0 };
}
