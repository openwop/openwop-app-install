/**
 * ADR 0545 D2/P2 — the standard question bank, and the coverage number.
 *
 * D2 is the single highest-leverage decision in the vertical: answering ~20
 * questions once, at a moment the user chose, is not toil. Being asked one
 * question unpredictably, forty times, is — and that is what makes the existing
 * tools feel like work.
 *
 * ## The number is the product claim, so it is computed, not asserted
 *
 * P2's verification says: measure what fraction of required fields the seeded
 * bank answers, and **ship the number**. So coverage is computed here from
 * FIXTURES of real ATS required-field sets rather than stated in prose. A
 * hard-coded "covers 90%" is exactly the unfalsifiable claim ADR 0545 D5a
 * refuses to make about market share; it would be no better made about toil.
 *
 * The fixtures are the honest weak point and are labelled as such: they are a
 * representative reconstruction of the four Tier-1 boards' common application
 * forms, not a scrape of live postings. `coverageReport()` returns the per-board
 * split so the number can never be quoted without the denominators it came from.
 */
import { specialCategoryKeyFor, resolveQuestionKey } from './questionKey.js';

/** How a question is answered, which decides the control the wizard renders. */
export type AnswerKind = 'text' | 'longtext' | 'number' | 'money' | 'date' | 'boolean' | 'choice' | 'url';

export interface StandardQuestion {
  key: string;
  /** The wizard's phrasing — plain, first-person, no ATS jargon. */
  prompt: string;
  kind: AnswerKind;
  /** For `choice`. The wizard renders these verbatim. */
  options?: readonly string[];
  /** Why it is worth answering, shown when the user hesitates or skips. */
  why: string;
  /** Answering this unlocks a large share of forms; the wizard leads with them. */
  core: boolean;
}

/**
 * The bank.
 *
 * Ordered by leverage: the first six answer the overwhelming majority of
 * REQUIRED fields on the Tier-1 boards, so a user who abandons the wizard early
 * still gets most of the benefit. That ordering is a product decision, and
 * `coverageReport` is what keeps it honest.
 */
export const STANDARD_BANK: readonly StandardQuestion[] = [
  {
    key: 'work-auth.legally-authorised',
    prompt: 'Are you legally allowed to work in the country you are applying in?',
    kind: 'boolean',
    why: 'Almost every application asks this, and it is required on all four boards.',
    core: true,
  },
  {
    key: 'work-auth.requires-sponsorship',
    prompt: 'Will you need visa sponsorship, now or in the future?',
    kind: 'boolean',
    why: 'Asked as often as the previous question, and phrased a dozen different ways.',
    core: true,
  },
  {
    key: 'compensation.expectation',
    prompt: 'What compensation are you looking for?',
    kind: 'money',
    why: 'The question people most dread being asked repeatedly. Answer it once.',
    core: true,
  },
  {
    key: 'availability.start-date',
    prompt: 'When could you start?',
    kind: 'date',
    why: 'Required on most forms; a stale date here reads as carelessness.',
    core: true,
  },
  {
    key: 'availability.notice-period',
    prompt: 'How much notice do you have to give your current employer?',
    kind: 'text',
    why: 'Often asked instead of a start date, so both are worth having.',
    core: true,
  },
  {
    key: 'location.remote-preference',
    prompt: 'How do you want to work?',
    kind: 'choice',
    options: ['Remote', 'Hybrid', 'On-site', 'No preference'],
    why: 'Decides which roles are worth applying to at all.',
    core: true,
  },
  {
    key: 'location.willing-to-relocate',
    prompt: 'Would you relocate for the right role?',
    kind: 'boolean',
    why: 'Required whenever a posting is tied to an office.',
    core: false,
  },
  {
    key: 'links.linkedin',
    prompt: 'Your LinkedIn profile',
    kind: 'url',
    why: 'A required field on many forms, and trivially reusable.',
    core: false,
  },
  {
    key: 'links.portfolio',
    prompt: 'Your portfolio, site or GitHub',
    kind: 'url',
    why: 'Optional on most forms, decisive on some.',
    core: false,
  },
  {
    key: 'references.available',
    prompt: 'Can you provide references if asked?',
    kind: 'boolean',
    why: 'Usually a yes/no box rather than the references themselves.',
    core: false,
  },
];

/** Keys the wizard leads with. */
export const CORE_KEYS: readonly string[] = STANDARD_BANK.filter((q) => q.core).map((q) => q.key);

/**
 * Representative REQUIRED fields on the four Tier-1 boards' common forms.
 *
 * A reconstruction, not a scrape — stated plainly because the coverage number
 * derived from it inherits that limitation. Fields an employer supplies from the
 * résumé/profile (name, email, résumé upload) are excluded: they are not
 * questions, and counting them would inflate the number by measuring the easy
 * part.
 */
export const ATS_REQUIRED_FIXTURES: ReadonlyArray<{ board: string; required: readonly string[] }> = [
  {
    board: 'greenhouse',
    required: [
      'Are you legally authorized to work in the United States?',
      'Will you now or in the future require sponsorship for employment visa status?',
      'LinkedIn Profile',
      'What are your salary expectations?',
      'Website',
    ],
  },
  {
    board: 'lever',
    required: [
      'Are you legally authorized to work in the country of employment?',
      'Do you require sponsorship?',
      'LinkedIn URL',
      'When can you start?',
      'What is your work preference?',
    ],
  },
  {
    board: 'ashby',
    required: [
      'Do you have work authorization?',
      'Will you require visa sponsorship?',
      'Desired compensation',
      'Earliest start date',
      'Are you willing to relocate?',
    ],
  },
  {
    board: 'workable',
    required: [
      'Are you legally eligible to work?',
      'Do you now or in the future require sponsorship to work?',
      'Notice period',
      'Link to your portfolio',
      'Can you provide references?',
      // The category this system deliberately does not keep an answer to. It is
      // in the fixture on purpose: excluding it would flatter the number by
      // hiding the one field we answer with "decline to self-identify".
      'Voluntary Self-Identification of Disability',
    ],
  },
];

export interface CoverageRow {
  board: string;
  required: number;
  /** Answered from the seeded bank. */
  covered: number;
  /** Answered as "decline to self-identify" — handled, but not from the bank. */
  declined: number;
  uncovered: string[];
}

export interface CoverageReport {
  rows: CoverageRow[];
  totalRequired: number;
  totalCovered: number;
  totalDeclined: number;
  /** Covered ÷ required, 0–1. The number D2 says to ship. */
  ratio: number;
}

/**
 * What fraction of required fields does the SEEDED bank answer?
 *
 * `seededKeys` defaults to the whole standard bank — the number for a user who
 * finished the wizard. Pass `CORE_KEYS` for the number a user gets if they
 * answer only the first six, which is the more interesting product question.
 *
 * `declined` is counted SEPARATELY and never folded into `covered`. A special
 * category answered by declining is a field that will not stop an application,
 * but it is not an answer the user gave, and merging the two would let the
 * headline number quietly include fields the bank does not actually hold.
 */
export function coverageReport(seededKeys: readonly string[] = STANDARD_BANK.map((q) => q.key)): CoverageReport {
  const seeded = new Set(seededKeys);
  const rows: CoverageRow[] = ATS_REQUIRED_FIXTURES.map(({ board, required }) => {
    let covered = 0;
    let declined = 0;
    const uncovered: string[] = [];
    for (const question of required) {
      if (specialCategoryKeyFor(question)) { declined += 1; continue; }
      const { key, match } = resolveQuestionKey(question, [...seeded]);
      // A fuzzy match is not coverage: the bank refuses to auto-answer on one,
      // so counting it here would measure something the runtime will not do.
      if (match !== 'fuzzy' && seeded.has(key)) covered += 1;
      else uncovered.push(question);
    }
    return { board, required: required.length, covered, declined, uncovered };
  });

  const totalRequired = rows.reduce((n, r) => n + r.required, 0);
  const totalCovered = rows.reduce((n, r) => n + r.covered, 0);
  const totalDeclined = rows.reduce((n, r) => n + r.declined, 0);
  return {
    rows,
    totalRequired,
    totalCovered,
    totalDeclined,
    ratio: totalRequired === 0 ? 0 : totalCovered / totalRequired,
  };
}
