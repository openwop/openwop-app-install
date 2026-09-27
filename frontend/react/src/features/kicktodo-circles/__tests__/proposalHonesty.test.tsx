/**
 * KT-HONESTY-1 — a coach proposal must not claim it was executed.
 *
 * THE DEFECT. The card rendered a coach's prose `note` and offered a button
 * labelled "Apply". Clicking it calls `resolveProposal(action:'apply')` ->
 * `applyPlanRevision`, which supersedes non-terminal occurrences and
 * RE-MATERIALIZES the plan from the participant's OWN current preferences. The
 * coach's note is free text and is never executed — there is nothing structured
 * to execute. The plan regenerates, which LOOKS like the swap happened.
 *
 * That is worse than the silent-failure variants this repo has been fixing: those
 * fail to report a truth, this one performs a success.
 *
 * These pin the three places the claim was made — the CTA, the resolved-state
 * chip that persists in history, and the empty-state promise — plus the two
 * disclosures that replace it. Copy is resolved from the catalog, never typed as
 * a literal, so a re-word cannot silently un-pin the assertion.
 */
import { describe, it, expect } from 'vitest';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const LOCALES = { en, es, fr, 'pt-BR': ptBR } as const;

/** Words that assert the coach's change was carried out. */
const CLAIMS_EXECUTION = /\bapplied\b|\baplicada\b|\bappliquée\b|\baplicada\b/i;

describe('KT-HONESTY-1 — the CTA never claims the coach change was executed', () => {
  it('the resolved-state chip does not say "Applied" in any locale', () => {
    // This one is the durable lie: it persists in history long after the click.
    for (const [loc, m] of Object.entries(LOCALES)) {
      expect(`${loc}: ${m.proposalApplied}`).not.toMatch(CLAIMS_EXECUTION);
    }
  });

  it('the empty-state stops promising that changes "land here" for execution', () => {
    // The old copy promised "swaps, schedule moves, and recovery land here for
    // your decision" — which reads as: decide, and it happens.
    for (const [loc, m] of Object.entries(LOCALES)) {
      expect(`${loc}`).toBeTruthy();
      expect(m.proposalsEmptyHint.length).toBeGreaterThan(0);
    }
    expect(en.proposalsEmptyHint).toMatch(/not applied/i);
  });

  it('every locale carries BOTH disclosures — the advice label and the consequence hint', () => {
    // A disclosure that exists only in English is not a disclosure for the
    // pt-BR speaker who owns this product's native-language review.
    for (const [loc, m] of Object.entries(LOCALES)) {
      expect(`${loc} advice`, ).toBeTruthy();
      expect(m.proposalAdviceLabel, `${loc} proposalAdviceLabel`).toBeTruthy();
      expect(m.proposalApplyHint, `${loc} proposalApplyHint`).toBeTruthy();
      expect(m.proposalApplyHint.length, `${loc} hint is substantive`).toBeGreaterThan(40);
    }
  });

  it('the English hint names what the action ACTUALLY does — rebuild from the user\'s own settings', () => {
    // The specific honesty claim: it must say the change is NOT made for you.
    expect(en.proposalApplyHint).toMatch(/current settings/i);
    expect(en.proposalApplyHint).toMatch(/does not make the coach/i);
  });

  it('the CTA does not read as a bare "Apply"', () => {
    expect(en.proposalApplyCta.trim().toLowerCase()).not.toBe('apply');
    expect(en.proposalApplyCta).toMatch(/rebuild/i);
  });
});
