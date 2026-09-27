/**
 * ADR 0546 D5 / 0543 P4 — outreach is DRAFTED, never sent.
 *
 * "Discovery and drafting are the automation. Sending is the human's." That split
 * is not a compromise: writing a credible, specific intro is where the effort
 * actually is, and sending it takes five seconds. Automating the five seconds
 * would buy nothing and risk everything — outreach to a person is Tier C by
 * construction, and the platforms where most of it happens are the ones whose
 * automation gets accounts restricted.
 *
 * ## How "cannot send" is guaranteed
 *
 * By having no way to. This module imports no mail transport, no HTTP client and
 * no connection broker; it returns a string. `job-search-outreach.test.ts`
 * asserts that structurally, because "we did not call send" is a property of
 * today's code and "there is nothing here that could" is a property of the
 * module.
 *
 * Pure: no I/O.
 */
import { guardRewrite, type TailorViolation } from '../domain/tailorGuard.js';

export interface OutreachContext {
  /** Who is being written to. */
  recipientName: string;
  /** Where the connection comes from — the PROVENANCE the user can check. */
  sharedContext: string;
  companyName: string;
  roleTitle: string;
  /** The applicant's own words about their background. The draft may reword
   *  these; it may not add to them. */
  applicantSummary: string;
  /**
   * A MODEL-generated body to use instead of the deterministic template.
   *
   * This is why the guard exists at all. The template below can only emit text
   * it was handed, so it cannot fabricate — running a guard over it would be
   * theatre. A model asked to write a warm intro absolutely can, and this is
   * exactly where it is tempted to ("we worked closely for three years"), with
   * the recipient the one person able to notice.
   */
  modelDraft?: string;
}

export interface OutreachDraft {
  /** The drafted message. Never sent by anything in this module. */
  body: string;
  /** Why this person is a warm path at all, shown to the user with the draft.
   *  ADR 0546 OQ-4: the provenance of every suggested path is shown, so a user
   *  can tell a real connection from an inferred one. */
  provenance: string;
  /** Non-empty when the draft would have introduced a fact the applicant's own
   *  summary does not support. The draft is withheld in that case. */
  violations: TailorViolation[];
}

/**
 * Draft a warm intro.
 *
 * Runs the ADR 0540 D4 guard over its own output. That is not belt-and-braces:
 * an intro is exactly where a generator is tempted to embellish ("we worked
 * closely for three years") and the recipient is the one person able to notice.
 * A draft that fails the guard is WITHHELD rather than shown with a warning,
 * because a warned-about draft still gets copied and sent.
 */
export function draftWarmIntro(ctx: OutreachContext): OutreachDraft {
  const provenance = ctx.sharedContext.trim();
  const template = [
    `Hi ${ctx.recipientName.trim()},`,
    '',
    `${provenance} — which is why I wanted to reach out directly rather than only applying.`,
    '',
    `${ctx.applicantSummary.trim()}`,
    '',
    `I've applied for the ${ctx.roleTitle.trim()} role at ${ctx.companyName.trim()}. If you think it's a reasonable fit, would you be open to passing my name along? Happy to send anything that would make that easy — and no problem at all if not.`,
  ].join('\n');
  const body = ctx.modelDraft?.trim() ? ctx.modelDraft.trim() : template;

  // The guard's SOURCE is the applicant's summary PLUS the facts the caller
  // supplied (recipient, company, role, provenance).
  //
  // A first draft compared against the summary alone, and correctly rejected its
  // own output: the company and role are legitimately GIVEN, not claimed, so
  // treating them as unsupported made every honest draft unusable. The
  // distinction that matters is claims ABOUT THE APPLICANT — those must trace to
  // the summary, and adding to them is what the guard exists to stop.
  const source = [ctx.applicantSummary, provenance, ctx.companyName, ctx.roleTitle, ctx.recipientName].join('\n');
  const verdict = guardRewrite(source, body, { allowedEmployers: [ctx.companyName] });
  return {
    body: verdict.ok ? body : '',
    provenance,
    violations: verdict.violations,
  };
}
