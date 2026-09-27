/**
 * ADR 0545 P1 — the answer bank.
 *
 * The ADR names two verification criteria: two employers phrasing the same
 * question differently resolve to one key, and an inferred answer cannot reach
 * an employer unconfirmed. Both are here, plus the two properties this phase
 * added on top: subject-keyed authorization (structural, not a check) and the
 * refusal to store special-category disclosures at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordAnswer, answerFor, listAnswers, noteAnswerUsed, eraseSubjectAnswers, putAnswerRow,
  type Answer, type AnswerRefusal,
} from '../src/features/job-search/autopilot/answerBank.js';
import { resolveQuestionKey, specialCategoryKeyFor, FUZZY_THRESHOLD } from '../src/features/job-search/autopilot/questionKey.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const T = 'user:t-bank';
const ME = 'user:me';
const YOU = 'user:you';

/** Narrows an issuance result, failing loudly on a refusal rather than reading through it. */
function ok(r: Answer | { refused: AnswerRefusal }): Answer {
  if ('refused' in r) throw new Error(`expected an answer, got refusal: ${r.refused}`);
  return r;
}

const put = (questionText: string, value: string, source: 'user' | 'profile' | 'inferred' = 'user', confirmed = true, subjectId = ME) =>
  recordAnswer({ tenantId: T, subjectId, questionText, value, source, confirmed, now: Date.now() });

beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

describe('ADR 0545 P1 — one question, one key', () => {
  it('two employers phrasing the SAME question differently hit one answer', async () => {
    // The ADR's headline criterion. Without it the bank's promise ("asked at
    // most once, ever") is false the first time a second company words it
    // differently, which is immediately.
    ok(await put('What are your salary expectations?', '$180,000'));

    for (const phrasing of [
      'Desired compensation',
      'Expected base salary',
      'What is your expected salary?',
      'Salary expectation',
    ]) {
      const hit = await answerFor(T, ME, phrasing);
      expect('value' in hit, `"${phrasing}" did not resolve to the stored answer`).toBe(true);
      expect((hit as { value: string }).value).toBe('$180,000');
    }
  });

  it('bridges genuinely different WORDINGS, not just punctuation', async () => {
    // A slug-equality scheme passes the previous test and fails this one: these
    // two share almost no tokens, and they are the same question.
    ok(await put('Will you now or in the future require sponsorship for employment visa status?', 'No'));
    const hit = await answerFor(T, ME, 'Do you require sponsorship?');
    expect('value' in hit).toBe(true);
    expect((hit as { value: string }).value).toBe('No');
  });

  it('does NOT collapse two DIFFERENT questions onto one key', async () => {
    // The failure this whole design fears: answering an employer's question with
    // a different question's answer, under the applicant's name.
    ok(await put('What is your notice period?', '4 weeks'));
    ok(await put('When can you start?', '2026-05-01'));
    const notice = await answerFor(T, ME, 'What is your notice period?');
    const start = await answerFor(T, ME, 'Earliest start date');
    expect((notice as { value: string }).value).toBe('4 weeks');
    expect((start as { value: string }).value).toBe('2026-05-01');
  });

  it('an unrelated question is a MISS, not a near-miss answer', async () => {
    ok(await put('What are your salary expectations?', '$180,000'));
    const hit = await answerFor(T, ME, 'Describe a time you resolved a conflict on your team.');
    expect('miss' in hit).toBe(true);
    expect((hit as { miss: string }).miss).toBe('unknown');
  });

  it('never AUTO-answers on a fuzzy match alone', async () => {
    // Fuzzy is advisory by design. `low-confidence` parks the field; parking is
    // an inconvenience the campaign design already absorbs, and a confident
    // wrong answer is not.
    expect(FUZZY_THRESHOLD).toBeGreaterThanOrEqual(0.7);
    const r = resolveQuestionKey('portfolio url website link', ['links.portfolio']);
    if (r.match === 'fuzzy') {
      await putAnswerRow({
        tenantId: T, subjectId: ME, questionKey: r.key, questionText: 'x', value: 'v',
        source: 'user', confirmedAt: new Date().toISOString(), usageCount: 0, updatedAt: new Date().toISOString(),
      });
      const hit = await answerFor(T, ME, 'portfolio url website link');
      expect('miss' in hit ? (hit as { miss: string }).miss : 'answered').toBe('low-confidence');
    }
  });
});

describe('ADR 0545 OQ-2 — an unconfirmed inference never reaches an employer', () => {
  it('is not served at all until a human affirms it', async () => {
    // OQ-2 resolves STRICTER than the phase table's "cannot be used twice":
    // confirm-before-first-use. The resolved decision is the one implemented.
    ok(await put('How many years of Python experience do you have?', '6', 'inferred', false));
    const first = await answerFor(T, ME, 'How many years of Python experience do you have?');
    expect('miss' in first).toBe(true);
    expect((first as { miss: string }).miss, 'not merely unknown — the caller must know it exists').toBe('unconfirmed');

    // …and a SECOND lookup does not quietly become usable.
    const second = await answerFor(T, ME, 'How many years of Python experience do you have?');
    expect('miss' in second).toBe(true);
  });

  it('becomes a `user` answer once confirmed, and is then served', async () => {
    ok(await put('How many years of Python experience do you have?', '6', 'inferred', false));
    const confirmed = ok(await put('How many years of Python experience do you have?', '6', 'inferred', true));
    expect(confirmed.source, 'a confirmed inference IS a user answer').toBe('user');
    expect(confirmed.confirmedAt).toBeTruthy();
    const hit = await answerFor(T, ME, 'How many years of Python experience do you have?');
    expect((hit as { value: string }).value).toBe('6');
  });

  it('a `user` answer is confirmed by construction — it was typed', async () => {
    const r = ok(await put('What is your notice period?', '4 weeks', 'user', false));
    expect(r.confirmedAt).toBeTruthy();
  });
});

describe('ADR 0545 — special-category disclosures are not stored', () => {
  it.each([
    'Do you have a disability?',
    'Voluntary Self-Identification of Disability',
    'Are you a protected veteran?',
    'What is your gender?',
    'Race or ethnicity',
  ])('refuses to store: %s', async (q) => {
    // The store cannot hold it, so no access rule has to protect it and no leak
    // can expose it. `DurableCollection` is plaintext and masking is
    // dictionary-reversible for values this low-cardinality.
    const r = await recordAnswer({ tenantId: T, subjectId: ME, questionText: q, value: 'yes', source: 'user', confirmed: true, now: Date.now() });
    expect(r).toEqual({ refused: 'special-category' });
    expect(await listAnswers(T, ME), 'nothing may be written, not even a key').toHaveLength(0);
  });

  it('reads report the category so the caller can decline to self-identify', async () => {
    const hit = await answerFor(T, ME, 'Are you a protected veteran?');
    expect((hit as { miss: string }).miss).toBe('special-category');
  });

  it('the refusal keys on the QUESTION, so it cannot be smuggled in', async () => {
    // A caller cannot dodge it by dressing the question up: detection runs on
    // the text before any key is chosen.
    expect(specialCategoryKeyFor('Please complete the voluntary self identification of disability form')).toBeTruthy();
    const r = await recordAnswer({
      tenantId: T, subjectId: ME, questionText: 'Please complete the voluntary self identification of disability form',
      value: 'Yes', source: 'user', confirmed: true, now: Date.now(),
    });
    expect(r).toEqual({ refused: 'special-category' });
  });

  it('does not over-refuse an ordinary question', async () => {
    // Over-detection has a cost too: a legitimate question that can never be
    // answered parks an application forever.
    for (const q of ['What are your salary expectations?', 'Are you willing to relocate?', 'When can you start?']) {
      expect(specialCategoryKeyFor(q), `${q} was wrongly treated as special category`).toBeNull();
    }
  });
});

describe('ADR 0545 row 8 — the key IS the authorization', () => {
  it('one subject cannot read another’s answers', async () => {
    ok(await put('What are your salary expectations?', '$180,000', 'user', true, ME));
    ok(await put('What are your salary expectations?', '$95,000', 'user', true, YOU));

    const mine = await answerFor(T, ME, 'Desired compensation');
    const yours = await answerFor(T, YOU, 'Desired compensation');
    expect((mine as { value: string }).value).toBe('$180,000');
    expect((yours as { value: string }).value).toBe('$95,000');

    // …and a list is scoped by construction, not by a filter someone can forget.
    expect(await listAnswers(T, ME)).toHaveLength(1);
    expect(JSON.stringify(await listAnswers(T, ME))).not.toContain('$95,000');
  });

  it('has no admin override and no org-scope gate — in the CODE, not the prose', async () => {
    // Structural: the subject is a KEY component. There is no `asSubject` option
    // and no admin override — the property row 8 asks for is the absence of one.
    //
    // COMMENTS ARE STRIPPED FIRST. The header of that module explains, in
    // English, that the bank must never sit behind `authorizeOrgScope` — and a
    // raw text scan flags exactly the sentence written to prevent the mistake.
    // I have made that error repeatedly this session; scanning prose is not
    // scanning code.
    const src = (await import('node:fs')).readFileSync(
      (await import('node:path')).join(process.cwd(), 'src', 'features', 'job-search', 'autopilot', 'answerBank.ts'), 'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code.length, 'stripping must not empty the file — that would make this vacuous').toBeGreaterThan(1000);
    expect(code, 'the prose says this too, but the code is what binds').not.toMatch(/isSuperadmin|authorizeOrgScope|orgAdmin/);
    // …and the positive half: the subject really is part of every row key.
    expect(code).toMatch(/const rowKey = \(tenantId: string, subjectId: string, questionKey: string\)/);
  });
});

describe('ADR 0464 — erasure of a subject’s answers', () => {
  it('DELETES them, and leaves the other subject alone', async () => {
    ok(await put('What are your salary expectations?', '$180,000', 'user', true, ME));
    ok(await put('When can you start?', '2026-05-01', 'user', true, ME));
    ok(await put('What are your salary expectations?', '$95,000', 'user', true, YOU));

    await eraseSubjectAnswers(T, ME);

    expect(await listAnswers(T, ME), 'the subject’s own content, with nothing depending on it').toHaveLength(0);
    expect(await listAnswers(T, YOU)).toHaveLength(1);
  });

  it('is registered, not merely exported', async () => {
    // The ADR 0464 scanner binds `userId: string`; this row type declares
    // `subjectId`, so the gate does NOT see this store (measured: two other
    // feature stores share that position). Coverage therefore rests on THIS
    // assertion — a registration that exists only as an export is a coverage
    // claim nobody checks.
    const src = (await import('node:fs')).readFileSync(
      (await import('node:path')).join(process.cwd(), 'src', 'features', 'job-search', 'autopilot', 'answerBank.ts'), 'utf8',
    );
    expect(src).toMatch(/registerSubjectEraser\(eraseSubjectAnswers\)/);
  });
});

describe('usage counting', () => {
  it('counts uses, not lookups', async () => {
    // A lookup that incremented would make the number mean "times considered",
    // and the setup wizard shows it as "answers earning their keep".
    ok(await put('What are your salary expectations?', '$180,000'));
    await answerFor(T, ME, 'Desired compensation');
    await answerFor(T, ME, 'Desired compensation');
    expect((await listAnswers(T, ME))[0]!.usageCount).toBe(0);

    await noteAnswerUsed(T, ME, 'compensation.expectation', Date.now());
    expect((await listAnswers(T, ME))[0]!.usageCount).toBe(1);
  });
});
