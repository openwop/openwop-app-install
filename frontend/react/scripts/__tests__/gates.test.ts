/**
 * The gates' own tests — because a guard with no guard is the asymmetry these
 * gates exist to criticise.
 *
 * `check-notice-announce` and `check-failure-card-announce` were both shipped
 * with no test of their own. Each was probed by hand at authoring time, which
 * proves it worked once; nothing stopped a later edit from weakening it. Two
 * gates, same hole, both graded A-not-A+ for it.
 *
 * These run the REAL scripts as child processes against fixture trees. Testing
 * an extracted copy of the scanning logic would prove the copy works — the same
 * mistake as mocking the thing you are trying to integrate with. The only
 * concession is `OPENWOP_GATE_SRC`, which points the real script at a fixture
 * directory and is unset in every normal invocation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
let root: string;

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'owp-gate-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** Write a fixture tree and run `gate` against it. Returns exit code + output. */
function runGate(
  gate: string,
  files: Record<string, string>,
  env: Record<string, string> = {},
): { code: number; out: string } {
  const dir = mkdtempSync(join(root, 'src-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  try {
    const out = execFileSync('node', [join(SCRIPTS, gate)], {
      env: { ...process.env, ...env, OPENWOP_GATE_SRC: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('check-notice-announce — rule 1, success notices', () => {
  it('passes a success notice that announces', () => {
    const r = runGate('check-notice-announce.mjs', {
      'ok.tsx': `export const A = () => <Notice variant="success" announce={t('x')}>{t('x')}</Notice>;\n`,
    });
    expect(r.code).toBe(0);
  });

  it('FAILS a silent success notice, and names its file and line', () => {
    const r = runGate('check-notice-announce.mjs', {
      'bad.tsx': `const A = 1;\nexport const B = () => <Notice variant="success">done</Notice>;\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('bad.tsx:2');
  });

  // The trap this gate was written to avoid: prose is not code.
  it('is NOT comment-blind — the same markup in a JSX comment passes', () => {
    const r = runGate('check-notice-announce.mjs', {
      'prose.tsx': `export const A = () => (<div>\n  {/* e.g. <Notice variant="success">x</Notice> — see #2618 */}\n</div>);\n`,
    });
    expect(r.code).toBe(0);
  });

  // It counted its own fixtures once: 38 vs a true 30.
  it('does not scan __tests__ fixtures', () => {
    const r = runGate('check-notice-announce.mjs', {
      '__tests__/fixture.tsx': `export const A = () => <Notice variant="success">deliberate silent fixture</Notice>;\n`,
    });
    expect(r.code).toBe(0);
  });
});

describe('check-notice-announce — rule 2, failed-read disclosures', () => {
  it('FAILS a warning notice gated on a failed-read flag with no announce', () => {
    const r = runGate('check-notice-announce.mjs', {
      'read.tsx': `export const A = () => <>{statsFailed ? <Notice variant="warning">{t('f')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/failed-read disclosure/i);
  });

  // The compound gate my own hand-written sweep missed on the payout console.
  it('catches a COMPOUND gate, which a single-flag grep misses', () => {
    const r = runGate('check-notice-announce.mjs', {
      'compound.tsx': `export const A = () => <>{policyFailed || runsFailed ? <Notice variant="warning">{t('f')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(1);
  });

  // Static furniture must stay silent — announcing it fires on every mount.
  it('leaves an UNGATED info notice alone', () => {
    const r = runGate('check-notice-announce.mjs', {
      'furniture.tsx': `export const A = () => <Notice variant="info">{t('hint')}</Notice>;\n`,
    });
    expect(r.code).toBe(0);
  });
});

/**
 * ADR 0598 — the three shapes rule 2 could not see, each with its own case.
 *
 * A `/grade-ux` pass ran this gate against `features/strategy` and got a GREEN
 * TICK while three failure notices reached assistive tech not at all. These are
 * the assertions that make the extension worth something: each fixture is red
 * under the extension and was green before it, and each is paired with the
 * NEAREST shape that must stay green, so the gate cannot pass by flagging
 * everything.
 */
describe('check-notice-announce — rule 2, the ADR 0598 shapes', () => {
  it('FAILS an ERROR notice gated on a failed-read flag (hole 3)', () => {
    const r = runGate('check-notice-announce.mjs', {
      'err.tsx': `export const A = () => <>{loadFailed ? <Notice variant="error">{t('f')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('err.tsx:1');
  });

  it('FAILS the EARLY-RETURN form, which the `flag ? (` shape never matched (hole 1)', () => {
    const r = runGate('check-notice-announce.mjs', {
      'early.tsx': `export const A = () => {\n  if (timelineFailed) return <Notice variant="warning">{t('f')}</Notice>;\n  return null;\n};\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('early.tsx:2');
  });

  it('FAILS a flag named exactly `failed` — the suffix test is case-insensitive (hole 2)', () => {
    const r = runGate('check-notice-announce.mjs', {
      'lower.tsx': `export const A = () => <>{failed ? <Notice variant="error">{t('f')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('lower.tsx:1');
  });

  it('PASSES the same three once they announce (the fix, not the ban)', () => {
    const r = runGate('check-notice-announce.mjs', {
      'a.tsx': `export const A = () => <>{loadFailed ? <Notice variant="error" announce={t('f')}>{t('f')}</Notice> : null}</>;\n`,
      'b.tsx': `export const B = () => {\n  if (timelineFailed) return <Notice variant="warning" announce={t('f')}>{t('f')}</Notice>;\n  return null;\n};\n`,
      'c.tsx': `export const C = () => <>{failed ? <Notice variant="error" announce={t('f')}>{t('f')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(0);
  });

  // The over-fire control. An error notice that is NOT gated on a failure flag is
  // ordinary conditional chrome; widening to every `variant="error"` would flag
  // correct code and teach people to ignore the gate.
  it('leaves an error notice with no failure gate alone', () => {
    const r = runGate('check-notice-announce.mjs', {
      'plain.tsx': `export const A = () => <>{isOverdue ? <Notice variant="error">{t('late')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(0);
  });

  // `deferred`, `covered`, `filtered` … all end in a letter run that a sloppy
  // suffix test would read as `error`/`failed`. This is the fixture that keeps
  // `isFailedReadFlag` honest.
  it('does not treat a look-alike identifier as a failure flag', () => {
    const r = runGate('check-notice-announce.mjs', {
      'lookalike.tsx': `export const A = () => <>{deferred ? <Notice variant="warning">{t('later')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(0);
  });

  // ── ADR 0598 §Correction 2 — the COMPOUND gate (hole 4) ────────────────────
  //
  // Shapes 0/1 capture the ONE identifier adjacent to the `?`/`&&`, so a gate
  // whose failed-read flag is not the last operand was classified on the wrong
  // name and dropped entirely. This is the shape the PR's OWN new disclosure
  // (`features/strategy/StrategyDetailPage.tsx:926`) was written in, so the
  // extension could not protect the fix it shipped with.
  it('FAILS a compound gate whose failure flag is not the adjacent operand (hole 4)', () => {
    const r = runGate('check-notice-announce.mjs', {
      'compound.tsx': `export const A = () => <>{ctxFailed && hasPriorityLink ? <Notice variant="warning">{t('f')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('compound.tsx:1');
    expect(r.out).toContain('ctxFailed');
  });

  it('FAILS the `&&`-only compound form as well', () => {
    const r = runGate('check-notice-announce.mjs', {
      'compound2.tsx': `export const A = () => <>{loadFailed && ready && (\n  <Notice variant="error">{t('f')}</Notice>\n)}</>;\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('compound2.tsx:2');
  });

  it('PASSES the compound gate once it announces', () => {
    const r = runGate('check-notice-announce.mjs', {
      'compound.tsx': `export const A = () => <>{ctxFailed && hasPriorityLink ? <Notice variant="warning" announce={t('f')}>{t('f')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(0);
  });

  // The over-fire control for hole 4, and it is not hypothetical: the first cut
  // of shape 2 stripped the `!` and tested the bare name, which flagged
  // `features/users/SsoPanel.tsx:118` — static "SSO is not enabled" copy that
  // renders BECAUSE the capabilities read SUCCEEDED. A negated operand is the
  // opposite claim and must not be read as a failure gate.
  // ── ADR 0598 §Correction 10 — a prescribed cure that does not compile ──────
  //
  // `ui/Notice.tsx` makes `announce` and `id` mutually exclusive BY TYPE, so for
  // an `id`-carrying notice the standard "Pass `announce`" remedy is not
  // available. A gate whose cure is impossible reads as actionable and pushes
  // people to the allowlist. Latent today (4 live `id` sites, none
  // failure-gated), which is when it is cheap to close.
  it('tells the TRUE remedy when the notice carries an `id`', () => {
    const r = runGate('check-notice-announce.mjs', {
      'described.tsx': `export const A = () => <>{loadFailed ? <Notice variant="error" id="x-hint">{t('f')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('described.tsx:1');
    expect(r.out).toMatch(/mutually exclusive BY TYPE/);
    expect(r.out).toMatch(/aria-describedby/);
  });

  it('does NOT print the `id` note when no violation carries one', () => {
    const r = runGate('check-notice-announce.mjs', {
      'plainfail.tsx': `export const A = () => <>{loadFailed ? <Notice variant="error">{t('f')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(/mutually exclusive BY TYPE/);
  });

  it('leaves a NEGATED failure flag alone — `!capsFailed &&` is a success gate', () => {
    const r = runGate('check-notice-announce.mjs', {
      'negated.tsx': `export const A = () => <>{!capsFailed && !saml && !scim ? <Notice variant="info">{t('off')}</Notice> : null}</>;\n`,
    });
    expect(r.code).toBe(0);
  });
});

/**
 * ADR 0598 §Correction 3 — the WIRING, not the mechanism.
 *
 * `src/__tests__/gateBaseline.test.ts` proves the resolver refuses a typo. That
 * says nothing about whether any gate CALLS it: the defect was two gates reading
 * `Number(process.env.X ?? '190')` directly, one of them extended in the same
 * commit as the sibling that had already written the lesson down. These drive the
 * REAL scripts with a bad override and require a red.
 */
describe('gate baselines — an unreadable env override cannot silently disable a gate', () => {
  const clean = { 'ok.tsx': `export const A = () => <>{t('x')}</>;\n` };

  it('check-notice-announce REFUSES a typo instead of running with baseline NaN', () => {
    const r = runGate('check-notice-announce.mjs', clean, {
      OPENWOP_SILENT_READ_NOTICE_BASELINE_0598: 'zero',
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not a non-negative integer/);
  });

  it('check-live-regions REFUSES a typo on the IMPLICIT baseline too', () => {
    const r = runGate('check-live-regions.mjs', clean, {
      OPENWOP_IMPLICIT_LIVE_REGION_BASELINE: 'five',
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not a non-negative integer/);
  });

  it('REFUSES an override that LOOSENS the ratchet', () => {
    const r = runGate('check-notice-announce.mjs', clean, {
      OPENWOP_SILENT_SUCCESS_NOTICE_BASELINE: '99',
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/HIGHER/);
  });
});

describe('check-failure-card-announce', () => {
  /**
   * This gate has an ANTI-VACUITY self-check — it refuses to report clean when
   * the walk looks degenerate ("walked N files but src/features alone holds N —
   * the walk is broken, not the code clean"). That is the property I most want
   * in a source-scanning gate, and satisfying it is what makes these fixtures
   * look heavier than the cases need: a tree must have files OUTSIDE `features/`
   * for the walk to be credible.
   */
  const tree = (files: Record<string, string>) => ({
    'features/.keep.tsx': 'export const K = 1;\n',
    'a.tsx': 'export const A = 1;\n',
    'b.tsx': 'export const B = 2;\n',
    'ui/c.tsx': 'export const C = 3;\n',
    // The gate also reads App.tsx (it checks the shared live region is mounted).
    'App.tsx': 'export const App = () => <><GlobalLiveRegion /></>;\n',
    ...files,
  });

  it('passes a NON-failure StateCard (an empty state, not a failed read)', () => {
    const r = runGate('check-failure-card-announce.mjs', tree({
      'features/empty.tsx': `export const A = () => <StateCard title={t('noItems')} body={t('noItemsBody')} />;\n`,
    }));
    expect(r.code).toBe(0);
  });

  /**
   * The second anti-vacuity guard, and my test was wrong by design until I hit
   * it: a tree with ZERO StateCards does not pass — "parsed 0 <StateCard>
   * elements — the parser is broken, not the code clean". A scanner that finds
   * nothing is reporting on its own reach, not on the code.
   */
  it('refuses to report clean when it parsed no elements at all', () => {
    const r = runGate('check-failure-card-announce.mjs', tree({ 'plain.tsx': 'export const A = 1;\n' }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/parser is broken, not the code clean/i);
  });

  it('FAILS a failure StateCard that does not announce', () => {
    const r = runGate('check-failure-card-announce.mjs', tree({
      'features/card.tsx': `export const A = () => <StateCard title={t('loadFailed')} body={t('couldNotLoadBody')} />;\n`,
    }));
    expect(r.code).toBe(1);
  });

  it('passes the same card once it announces', () => {
    const r = runGate('check-failure-card-announce.mjs', tree({
      'features/card.tsx': `export const A = () => <StateCard announce title={t('loadFailed')} body={t('couldNotLoadBody')} />;\n`,
    }));
    expect(r.code).toBe(0);
  });

  /**
   * The property that matters more than any single rule: if the gate cannot
   * find what it is meant to scan, it must FAIL — not scan nothing and report
   * success. A gate that silently passes on an empty read is the same defect
   * these gates exist to catch, one level up.
   */
  it('FAILS LOUDLY when its scan root is missing, rather than passing on nothing', () => {
    const r = runGate('check-failure-card-announce.mjs', { 'no-features-dir.tsx': 'export const A = 1;\n' });
    expect(r.code).not.toBe(0);
  });

  /** The same property from the other side: a degenerate walk is not a clean bill. */
  it('refuses to report clean when the walk looks degenerate', () => {
    const r = runGate('check-failure-card-announce.mjs', { 'features/only.tsx': 'export const A = 1;\n' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/walk is broken, not the code clean/i);
  });
});


describe('check-inline-styles — the DSYS-2 AST classifier', () => {
  it('FAILS a fully static style object (baseline 0)', () => {
    const r = runGate('check-inline-styles.mjs', {
      'bad.tsx': `export const A = () => <div style={{ width: '3rem', height: 12 }} />;\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('1 STATIC');
  });

  it('passes a dynamic object, a var() token forward, and a template literal', () => {
    const r = runGate('check-inline-styles.mjs', {
      'ok.tsx': [
        `export const A = (w: number) => <div style={{ width: w }} />;`,
        `export const B = () => <div style={{ color: 'var(--ink)' }} />;`,
        'export const C = () => <div style={{ width: `3rem` }} />;',
      ].join('\n') + '\n',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 static');
  });

  it('one var() property does NOT exempt the literals beside it (grade-trio finding 7)', () => {
    const r = runGate('check-inline-styles.mjs', {
      'mixed.tsx': `export const A = () => <div style={{ color: 'var(--ink)', marginTop: '12px' }} />;\n`,
    });
    expect(r.code).toBe(1); // the marginTop literal is static; the token beside it changes nothing
  });

  it('is not fooled by commas inside a string value (the gradient class the regex missed)', () => {
    const r = runGate('check-inline-styles.mjs', {
      'grad.tsx': `export const A = () => <span style={{ width: '3rem', background: 'linear-gradient(to right, red, blue)' }} />;\n`,
    });
    expect(r.code).toBe(1); // fully static — commas in the string no longer hide it
  });

  it('is comment-blind-proof: the same object in a comment passes', () => {
    const r = runGate('check-inline-styles.mjs', {
      'prose.tsx': `// e.g. <div style={{ width: '3rem' }} /> is banned\nexport const A = 1;\n`,
    });
    expect(r.code).toBe(0);
  });
});

describe('check-unwrapped-buttons — the DSYS-2 AST counter', () => {
  const env = { OPENWOP_UNWRAPPED_BUTTONS_BASELINE: '0', OPENWOP_VARIANT_BUTTONS_BASELINE: '0' };
  function runButtons(files: Record<string, string>, extraEnv: Record<string, string>) {
    const dir = mkdtempSync(join(root, 'src-'));
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body, 'utf8');
    }
    try {
      const out = execFileSync('node', [join(SCRIPTS, 'check-unwrapped-buttons.mjs')], {
        env: { ...process.env, OPENWOP_GATE_SRC: dir, ...extraEnv },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('counts a real <button> against the baseline', () => {
    const r = runButtons({ 'a.tsx': `export const A = () => <button className="chip">x</button>;\n` }, env);
    expect(r.code).toBe(1);
    expect(r.out).toContain('1 raw <button>');
  });

  it('a <button> inside a comment or prose does NOT count (the 348-line stripper class, retired)', () => {
    const r = runButtons({
      'prose.tsx': `/* the old rule: never a raw <button> */\n// <button className="ghost">no</button>\nexport const A = () => <input accept="audio/*,video/*" />;\n`,
    }, env);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 raw <button>');
  });

  it('classifies variant vocabulary in static, dynamic and template classNames — and bare buttons', () => {
    const r = runButtons({
      'v.tsx': [
        `export const A = () => <button className="ghost">a</button>;`,
        'export const B = (on: boolean) => <button className={`chip ${on ? "btn-sm" : ""}`}>b</button>;',
        `export const C = () => <button>c</button>;`,
      ].join('\n') + '\n',
    }, { OPENWOP_UNWRAPPED_BUTTONS_BASELINE: '3', OPENWOP_VARIANT_BUTTONS_BASELINE: '0' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('3 raw <button> sites still carry the VARIANT');
  });

  it('bespoke classNames pass the variant ratchet', () => {
    const r = runButtons({
      'ok.tsx': `export const A = () => <button className="msgbubble-action-btn">x</button>;\n`,
    }, { OPENWOP_UNWRAPPED_BUTTONS_BASELINE: '1', OPENWOP_VARIANT_BUTTONS_BASELINE: '0' });
    expect(r.code).toBe(0);
  });
});

describe('check-legacy-aliases — the DSYS-2 exact comment exclusion', () => {
  it('FAILS a live reference, and a reference inside a STRING (it resolves to nothing at runtime)', () => {
    const r = runGate('check-legacy-aliases.mjs', {
      'bad.css': `.x { color: var(--color-text); }\n`,
      'bad.ts': `export const s = 'var(--color-bg)';\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('--color-text');
    expect(r.out).toContain('--color-bg');
  });

  it('a retired token in a MULTI-LINE comment interior line does not flag (the old per-line false positive)', () => {
    const r = runGate('check-legacy-aliases.mjs', {
      'ok.ts': `/*\nthe alias --color-text was retired 2026-08-01\n*/\nexport const A = 1;\n`,
      'ok.css': `/*\n--color-surface used to live here\n*/\n.y { color: var(--ink); }\n`,
    });
    expect(r.code).toBe(0);
  });

  it('a trailing // comment deep in a JSX file does not flag (the scanner-desync class)', () => {
    const r = runGate('check-legacy-aliases.mjs', {
      'jsx.tsx': `export const A = () => (<div className="x">{1}</div>);\n// theme-flipping \u0060--color-surface\u0060 went dark-on-dark\nexport const B = 2;\n`,
    });
    expect(r.code).toBe(0);
  });

  it('does not flag the longer token a shorter retired name prefixes', () => {
    const r = runGate('check-legacy-aliases.mjs', {
      'ok2.css': `.z { color: var(--color-text-muted-2); }\n`,
    });
    // --color-text-muted itself IS retired; --color-text-muted-2 is not a retired name.
    expect(r.code).toBe(0);
  });
});

/**
 * ADR 0602 § Correction log, item B (`H1`/`H2`). `check-i18n`'s comment stripper
 * was a regex pair, then a hand-rolled character scanner, and both were wrong in
 * ways that only a real parse can be right about. These three fixtures are one
 * per defect class, and each of them PASSED (or FAILED) the wrong way before the
 * parser-backed stripper landed:
 *
 *   - regex-containing-`//`  → the fatal check went GREEN on two typo'd keys
 *   - apostrophe-in-JSX      → the fatal check went RED on innocent code
 *   - quote-in-char-class    → same, via a different desync trigger
 *
 * They run the REAL script against a fixture tree (`OPENWOP_GATE_SRC`), so a
 * later "simplification" back to a regex reddens here rather than in production.
 */
const EN_CATALOG = "export const messages = {\n  realKey: 'Real',\n} as const;\n";

describe('check-i18n — the ADR 0602 parser-backed comment stripper', () => {
  it('SEES both t() keys on a line whose regex literal ends in // (H2)', () => {
    const r = runGate('check-i18n.mjs', {
      'i18n/locales/en/common.ts': EN_CATALOG,
      'Comp.tsx': "export const C = ({ url }: { url: string }) => (\n"
        + "  <span>{/^[a-z]+:\\/\\//.test(url) ? t('zzzTypoKey') : t('alsoNotReal')}</span>\n"
        + ");\n",
    });
    // The old scanner read the trailing `\/\/` as a line comment and deleted the
    // rest of the line, so BOTH typo'd keys shipped on a FATAL check.
    expect(r.code).toBe(1);
    expect(r.out).toContain('zzzTypoKey');
    expect(r.out).toContain('alsoNotReal');
  });

  it('does NOT mine a doc-comment example after a JSX apostrophe (H1)', () => {
    const r = runGate('check-i18n.mjs', {
      'i18n/locales/en/common.ts': EN_CATALOG,
      'Comp.tsx': "export const C = () => <p>Here's the source list</p>;\n\n"
        + "/**\n * Example: t('notARealKeyInDocs')\n */\nexport const D = 1;\n",
    });
    // The apostrophe is ordinary JSX text to a parser and an opening quote to a
    // character scanner; from there the doc comment was never stripped and its
    // EXAMPLE call was mined as live — EXIT=1 on innocent code.
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('notARealKeyInDocs');
  });

  it('does NOT desync on a quote inside a regex character class', () => {
    const r = runGate('check-i18n.mjs', {
      'i18n/locales/en/common.ts': EN_CATALOG,
      'Comp.tsx': "const QUOTES = /['\"]/g;\n"
        + "export const C = () => <span>{QUOTES.test('x') ? t('realKey') : t('realKey')}</span>;\n\n"
        + "/**\n * Example: t('alsoNotARealKey')\n */\n",
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('alsoNotARealKey');
    // Non-vacuity: the fixture must actually exercise the miner. If the live
    // `t('realKey')` calls were ALSO lost, this file would pass by seeing
    // nothing — which is the failure mode the whole gate is about. A mined
    // reference is what stops `realKey` being reported as an orphan.
    expect(r.out).not.toContain('common:realKey');
  });
});
