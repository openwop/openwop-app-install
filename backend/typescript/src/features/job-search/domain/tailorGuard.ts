/**
 * ADR 0540 D4/D4a/P3 — tailoring may reword, never fabricate.
 *
 * The prior art's genuinely valuable insight is that this is ENFORCEMENT, not a
 * prompt instruction. A model told "do not invent metrics" will sometimes invent
 * metrics; a diff that rejects any number absent from the source cannot. So the
 * guard runs server-side on the model's output, and a fabrication is a typed
 * failure rather than a warning.
 *
 * The rule in one line: **every FACT in the rewrite must already exist in the
 * source.** Rewording, reordering, compressing and re-emphasising are all fine —
 * they carry no new facts. Adding a number, an employer, or a date is not.
 *
 * Scope note: this deliberately does NOT try to judge whether a rewrite is
 * *better*. It answers one falsifiable question — did a fact appear from
 * nowhere — because that is the question a machine can answer correctly, and a
 * guard that also tried to judge quality would fail at both.
 *
 * Applies identically to a cover-letter paragraph (D4a): same guard, same
 * verdict type. A letter is not an exception to honesty because it is prose.
 */

export type ViolationKind =
  | 'fabricated-number'
  | 'fabricated-employer'
  | 'fabricated-date'
  | 'fabricated-year';

export interface TailorViolation {
  kind: ViolationKind;
  /** The offending token, verbatim, so the failure names the fabrication rather
   *  than saying "output rejected" — a repair pass needs to know WHAT to drop. */
  token: string;
}

export interface TailorVerdict {
  ok: boolean;
  violations: TailorViolation[];
}

export interface TailorGuardOptions {
  /** Employer names the applicant genuinely has, including umbrella/parent names
   *  (the prior art whitelists these because "IBM" for a subsidiary is not a
   *  fabrication). Compared case-insensitively. */
  allowedEmployers?: readonly string[];
}

/** Digits, percentages, multipliers, money — the tokens that make a claim
 *  measurable, and therefore the ones worth fabricating. */
const NUMBER_RE = /\d[\d,.]*\s*(?:%|x\b|k\b|m\b|bn\b)?/gi;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
];

/** `1,200` and `1200` are the SAME claim; `10 %` and `10%` are too. Without this
 *  a model could evade the guard purely by reformatting, which would make the
 *  whole check theatre. */
function normaliseNumber(raw: string): string {
  return raw.toLowerCase().replace(/[,\s]/g, '').replace(/\.0+$/, '');
}

function numbersIn(text: string): string[] {
  return (text.match(NUMBER_RE) ?? []).map(normaliseNumber).filter((n) => n !== '');
}

/**
 * Capitalised multi-word runs — the shape of an organisation name. Deliberately
 * over-inclusive: it also catches product and technology names, and that is the
 * safe direction. A false positive costs one rejected rewrite; a false negative
 * puts an employer the applicant never worked for onto their résumé.
 */
function properNounsIn(text: string): string[] {
  const out: string[] = [];
  // Connectors that occur INSIDE a single organisation name ("Bank of America",
  // "The New York Times"). `and`/`for` are deliberately EXCLUDED: joining across
  // "and" merged "Northwind Systems and Goldman Sachs" into one run, which then
  // matched the known employer as a substring and let the fabricated one
  // through. A conjunction separates entities; it does not belong to one.
  // A period is part of a token only when NOT followed by whitespace, so
  // "Inc." and "U.S." survive while a SENTENCE BOUNDARY terminates the run.
  // Without that, "…at Harbor Analytics. If you think…" captured
  // "Harbor Analytics. If" as one entity — found by running this guard on PROSE
  // (a warm intro) rather than the résumé bullets it was written for.
  const word = "[A-Z][A-Za-z&'-]*(?:\\.(?!\\s|$))?";
  const re = new RegExp(`\\b${word}(?:\\s+(?:of|the|de)?\\s*${word})*`, 'g');
  // Sentence openers and salutations are not entities. "Hi Dana" was flagged as
  // a fabricated employer because "Hi" is capitalised and adjacent to a name.
  const OPENERS = new Set(['hi', 'hello', 'dear', 'the', 'if', 'i', 'we', 'happy', 'thanks', 'thank']);
  for (const raw of text.match(re) ?? []) {
    const m = raw.replace(/^(?:Hi|Hello|Dear|The|If|I|We|Happy|Thanks|Thank)\s+/, '');
    if (OPENERS.has(m.trim().toLowerCase())) continue;
    // Strip TRAILING sentence punctuation. The char class keeps `.` so "Inc."
    // and "U.S." survive, which means a name ending a sentence captures the
    // full stop too — and "Northwind Systems." then fails to match the source's
    // "Northwind Systems", flagging the applicant's own employer as fabricated.
    const t = m.trim().replace(/[.,;:]+$/, '');
    // Single leading-capital words are usually sentence starts, not employers.
    if (t.includes(' ') || /[A-Z]{2,}/.test(t)) out.push(t);
  }
  return out;
}

const lower = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Does the rewrite introduce a fact the source does not support?
 *
 * Fails CLOSED: any violation makes the whole rewrite unusable. A partial accept
 * ("keep the honest half") would ship a bullet the applicant never verified,
 * which is the exact outcome the guard exists to prevent.
 */
export function guardRewrite(
  original: string,
  reworded: string,
  opts: TailorGuardOptions = {},
): TailorVerdict {
  const violations: TailorViolation[] = [];

  // 1. Numbers. Every measurable claim must already be in the source.
  const sourceNumbers = new Set(numbersIn(original));
  for (const n of numbersIn(reworded)) {
    if (!sourceNumbers.has(n)) violations.push({ kind: 'fabricated-number', token: n });
  }

  // 2. Years and months. Dates are SERVER-DERIVED (D4) and must never arrive
  //    from a model, so any date token not present in the source is a defect
  //    even when it happens to be correct — the pipeline, not the value, is
  //    what is wrong.
  const sourceYears = new Set(original.match(YEAR_RE) ?? []);
  for (const y of reworded.match(YEAR_RE) ?? []) {
    if (!sourceYears.has(y)) violations.push({ kind: 'fabricated-year', token: y });
  }
  const sourceLower = lower(original);
  for (const m of MONTHS) {
    const inRewrite = new RegExp(`\\b${m}\\b`, 'i').test(reworded);
    if (inRewrite && !new RegExp(`\\b${m}\\b`, 'i').test(sourceLower)) {
      violations.push({ kind: 'fabricated-date', token: m });
    }
  }

  // 3. Employers / proper nouns. Allowed when present in the source or on the
  //    applicant's real employer list (umbrella names included).
  const allowed = new Set((opts.allowedEmployers ?? []).map(lower));
  const sourceNouns = new Set(properNounsIn(original).map(lower));
  for (const noun of properNounsIn(reworded)) {
    const key = lower(noun);
    if (sourceNouns.has(key) || allowed.has(key)) continue;
    // ONE direction only: the rewrite's noun may be a SHORTENING of a known one
    // ("Northwind" for "Northwind Systems"). The reverse — a longer run that
    // merely CONTAINS a known name — is how a fabricated entity smuggles itself
    // in beside a real one, so it is not contained, it is added.
    const contained = [...sourceNouns, ...allowed].some((s) => s.includes(key));
    if (!contained) violations.push({ kind: 'fabricated-employer', token: noun });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Extraction is verbatim (D4): parsing a résumé never "improves" it.
 *
 * Returns the source text unchanged for the fields it recognises. Present as a
 * named function rather than a comment so the rule has somewhere to live and a
 * test can assert it — an `extract` that quietly normalised capitalisation or
 * expanded an abbreviation would be inventing content one edit at a time.
 */
export function extractVerbatim<T extends Record<string, string>>(fields: T): T {
  return { ...fields };
}
