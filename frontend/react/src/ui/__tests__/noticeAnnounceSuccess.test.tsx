/**
 * Notice announce — tranche 2, the `success` variant.
 *
 * `Notice` sets `assertive` from `variant === 'error'` alone (`Notice.tsx:77`),
 * so `success` renders `role="status"`. A status region that MOUNTS ALREADY
 * CONTAINING its text announces nothing — the same defect `StateCard` had
 * (#2615/#2616). So every success Notice was a completed action the user was
 * never told about.
 *
 * These tests are BEHAVIOURAL on purpose. An attribute-level assertion
 * (`toHaveAttribute('role', 'status')`) passes against the broken version,
 * which is exactly how the original defect survived review.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Notice } from '../Notice.js';
import { GlobalLiveRegion, currentAnnouncements } from '../announce.js';

const SRC = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** Accepts both legal idioms — the plain prop and the conditional spread. */
const announced = (p: string): number => (read(p).match(/<Notice[^>]*\bannounce\s*[:=]/g) ?? []).length;
// SUCCESS-variant announcements only. `announced()` counts every variant, which
// stopped matching this suite's intent on 2026-08-11: failed-read disclosures
// across the app were wired to announce, so `InvitesSection` gained a SECOND
// announcing notice that is not a success notice at all, and an assertion named
// "exactly one SUCCESS notice" began failing for a reason it was never about.
// Measure the thing the name claims.
//
// The one-polite-slot worry below is still real and was checked, not waved
// through: a sent-invite success and a failed list refresh CAN land together.
// They contend, and the failed read is allowed to win — the user has already
// seen the success visually (it answers their own action), whereas "the list
// could not be re-read" is new information they have no other way to learn.
const announcedSuccess = (p: string): number =>
  (read(p).match(/<Notice[^>]*variant\s*=\s*"success"[^>]*\bannounce\s*[:=]/g) ?? []).length;

/** Sites that report a completed user action. Each announces exactly one notice. */
const WIRED = [
  // Phase 1 — render shape alone identifies them: `{notice ? <Notice …>{notice}</Notice> : null}`.
  'agents/AgentBoardPanel.tsx',
  'agents/AgentDashboardPage.tsx',
  'agents/AgentGuardrailsPanel.tsx',
  'agents/AgentInstructionsPanel.tsx',
  'agents/AgentIntegrationsPanel.tsx',
  'agents/AgentVoicePanel.tsx',
  'agents/AgentWorkspacePage.tsx',
  'features/agent-knowledge/AgentKnowledgePanel.tsx',
  'kanban/KanbanPage.tsx',
  'knowledge/SubjectKnowledgePanel.tsx',
  // Phase 2 — judged individually. Children are JSX, so each passes explicit
  // announcement text; that is what the prop is for.
  'agents/AgentWorkflowPortfolioPanel.tsx',
  'byok/RealtimeVoiceSettings.tsx',
  'byok/SubscriptionCredentialCard.tsx',
  'features/commerce/StorefrontPage.tsx',
  'features/forms/render/PublicFormRenderer.tsx',
  'features/kicktodo-studio/CandidateWorkspacePage.tsx',
  'features/profiles/ProfileWorkflowsTab.tsx',
  'features/projects/ProjectWorkflowsTab.tsx',
  'features/sharing/SharedQuoteView.tsx',
  'orgs/InvitesSection.tsx',
];

/**
 * Deliberately SILENT, with the reason — because the skip is the part a later
 * well-meaning edit would undo. Each renders from a STATE, not from an action,
 * so announcing would fire on every mount and every route back to the page.
 */
const NOT_ANNOUNCED: ReadonlyArray<readonly [string, string]> = [
  ['a11y/A11yIssuesPanel.tsx', 'empty-issues state display, not the act of checking'],
  ['agents/AgentConnectionStatusPanel.tsx', '`allConfigured` is standing status'],
  ['features/kicktodo/ProgressPage.tsx', '`completed` celebration re-renders on every visit'],
  ['settings/HeartbeatSettingsPage.tsx', 'banner describing current settings'],
  ['workforces/WorkforcesGalleryPage.tsx', '`allClear` is standing status'],
];

describe('success Notice reaches the live region', () => {
  beforeEach(() => {
    render(<GlobalLiveRegion />);
  });

  it('speaks the message when a success notice mounts', () => {
    render(<Notice variant="success" announce="Saved alpha">Saved alpha</Notice>);
    expect(currentAnnouncements().polite).toBe('Saved alpha');
  });

  // The reversibility check. Without `announce` the notice still RENDERS
  // correctly and still carries role="status" — and says nothing. This is the
  // assertion that fails if someone drops the prop as redundant.
  //
  // Asserted against THIS test's own string rather than `toBe('')`, because
  // `politeMsg` is a module global with no reset seam: it still holds the
  // previous test's message here. `toBe('')` would have failed for a reason
  // that has nothing to do with the behaviour under test — and scoping the
  // text query to this render avoids matching the live region's copy of it.
  it('says NOTHING without announce, though it renders identically', () => {
    const { container } = render(<Notice variant="success">Quiet beta</Notice>);
    expect(container.textContent).toContain('Quiet beta');
    expect(currentAnnouncements().polite).not.toBe('Quiet beta');
  });

  it('stays polite — a success must not preempt like an error', () => {
    render(<Notice variant="success" announce="Polite gamma">Polite gamma</Notice>);
    expect(currentAnnouncements().assertive).not.toBe('Polite gamma');
  });

  // Delegating AND carrying a role would be two regions for one message (DS-8).
  it('drops its own live region when it delegates', () => {
    const { container } = render(<Notice variant="success" announce="Saved">Saved</Notice>);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

/**
 * The single-slot constraint, pinned because it nearly caught me out.
 *
 * `announce()` keeps ONE polite string (`announce.tsx:18`), so two calls in the
 * same render pass leave only the last. I wired `AgentInstructionsPanel` and
 * `AgentVoicePanel`, which `AgentWorkspacePage.tsx:388-389` renders TOGETHER.
 *
 * That is safe here for a reason worth stating rather than assuming: success
 * notices are SEQUENTIAL by construction — each is set by its own action
 * handler, one user action at a time — whereas the failure notices of tranche 1
 * co-occur on a single page load. This test pins the distinction: simultaneous
 * announcements really do clobber, so the safety comes from the sequencing, not
 * from the slot.
 */
describe('the single polite slot', () => {
  beforeEach(() => {
    render(<GlobalLiveRegion />);
  });

  it('keeps only the last of two announcements in one pass', () => {
    render(
      <>
        <Notice variant="success" announce="Instructions saved">Instructions saved</Notice>
        <Notice variant="success" announce="Voice saved">Voice saved</Notice>
      </>,
    );
    expect(currentAnnouncements().polite).toBe('Voice saved');
  });

  it('announces each in turn when they are sequential', () => {
    const first = render(<Notice variant="success" announce="Instructions saved">Instructions saved</Notice>);
    expect(currentAnnouncements().polite).toBe('Instructions saved');
    first.unmount();
    render(<Notice variant="success" announce="Voice saved">Voice saved</Notice>);
    expect(currentAnnouncements().polite).toBe('Voice saved');
  });
});

/**
 * EXACTLY one, not "at least one" — matching the tranche-1 discipline
 * (`noticeSweepTranche.test.tsx:48`) rather than relaxing it.
 *
 * I first wrote `toBeGreaterThanOrEqual(1)`, which is weaker than both the
 * precedent AND the truth: every one of these files has exactly one wired
 * notice. A lower bound would have let a second announcement appear in any of
 * them without a word — and a second one is precisely what the single polite
 * slot cannot carry if the two ever coincide.
 */
describe('tranche 2 wiring stays wired', () => {
  it.each(WIRED)('%s announces exactly one success notice', (p) => {
    expect(announcedSuccess(p)).toBe(1);
  });

  it.each(NOT_ANNOUNCED)('%s stays silent — %s', (p) => {
    expect(announced(p)).toBe(0);
  });

  /**
   * `StorefrontPage` is in BOTH lists in spirit and so appears in neither
   * cleanly: `:206` announces the demo order the user just placed, while the
   * `?paid` landing banner does not — it renders from a URL parameter, so a
   * refresh or a back-navigation would re-announce a purchase that already
   * happened. `toBe(1)` above pins exactly that split.
   */
  it('StorefrontPage announces the placed order but not the paid-landing banner', () => {
    const s = read('features/commerce/StorefrontPage.tsx');
    expect(s).toContain("announce={t('demoPlacedTitle')}");
    expect(s).not.toMatch(/paidBanner[^\n]*announce/);
  });
});
