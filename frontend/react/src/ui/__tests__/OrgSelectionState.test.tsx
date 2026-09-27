/**
 * `OrgSelectionState` — the ONE renderer for `useOrgSelection`'s three states.
 *
 * What actually needs guarding is the branch ORDER, not the copy. Hand-written
 * across 18 features it went wrong repeatedly in two specific ways, and both
 * are asserted here:
 *
 *   1. a FAILED read rendered as the empty state ("you have no organizations")
 *      — a false claim about the account;
 *   2. a genuinely EMPTY read rendered as loading — the org-gated dependent
 *      read never starts, so the skeleton has no terminal condition and the
 *      screen says "loading" while the server has already answered "none".
 *
 * The ambiguous-input cases are the point: each test drives a state where TWO
 * branches could plausibly match and pins which one must win.
 *
 * MEASURED 2026-08-05, and it is the reason this file exists rather than trusting
 * the 24 per-page guards: swap branch 1 and branch 2 in the component and THIS
 * file goes red (2 cases) while a page's guard stays GREEN (analytics: 5/5).
 * Page tests cannot see it, structurally — a real failure leaves `orgs === null`,
 * so the empty branch's `orgs !== null && orgs.length === 0` declines even when
 * placed first, and the failed branch still wins by accident. The ordering
 * defect is only reachable in combination with a null-collapsing guard
 * (`!orgs?.length`), which is one refactor away and is exactly what the seven
 * migrated pages used to write.
 *
 * So: the ordering invariant is guarded HERE and nowhere else. Do not read 24
 * green page suites as covering it. That is why every case below feeds an input
 * where both guards could match — an ambiguity the real hook never produces, and
 * therefore the only thing that can catch the swap.
 *
 * THREE MORE PROPERTIES were added after centralising this component turned out
 * to have centralised three defects along with the branch order — each one now
 * shipping on every adopter at once, which is the whole risk of a shared
 * component and the reason these are pinned rather than reviewed:
 *
 *   3. the FAILED card carries the feature's consequence clause (`failedBody`).
 *      Deleting twelve per-feature `orgsFailedBody` strings for one generic
 *      sentence dropped the only thing a failed read can honestly report — what
 *      did NOT happen because of it;
 *   4. BOTH variants announce the TITLE ONLY and POLITELY (DESIGN.md §4.6
 *      rule 8). `page` always did; `inline` announced the whole sentence,
 *      assertively;
 *   5. the EMPTY card NAMES its next action (§5.1) — but only when the caller
 *      can take it. `/orgs` is admin-tier and creating an org needs
 *      `host:org:manage`, so a CTA for anyone else points at a disabled control.
 *
 * ROUND TWO added three more, and the reason they are worth pinning is that each
 * shipped on THIRTEEN OR FOURTEEN SCREENS AT ONCE — the shared-component risk in
 * its purest form, where "one small copy nit" is never one screen:
 *
 *   6. the EMPTY body carries the REASON only. Adding the CTA (5) did not remove
 *      the narration, so the card stated its action twice for a privileged
 *      caller — and for an unprivileged one instructed ("Create an organization
 *      first") and then retracted ("Ask an administrator to create one.");
 *   7. the noun. The failed card's contrast said "not an empty ACCOUNT" — a
 *      fourth noun for this collection, which es/pt-BR rendered as `una cuenta
 *      vacía` / `uma conta vazia`, i.e. BILLING;
 *   8. the INLINE variant is not a run-on. It concatenated an unpunctuated title
 *      with the body — "No organizations Create an organization first…" on `csm`
 *      and `marketplace`. EVERY assertion below is an EXACT string for that
 *      reason: the regexes this file used to carry matched the run-on happily.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EffectiveAccess } from '../../client/accessClient.js';
import { OrgSelectionState } from '../OrgSelectionState.js';

// The capability read is module-cached and shared app-wide; stubbing the state
// hook (not `fetch`) keeps these cases synchronous and pins the two answers that
// change the card — "can create" and "cannot" — plus the unresolved first paint.
const access: { access: EffectiveAccess; resolved: boolean } = {
  access: { roles: [], scopes: [], basis: 'none' },
  resolved: true,
};
vi.mock('../../client/useEffectiveAccess.js', async (importOriginal) => {
  // Spread the real module: `canManageOrgs` is a pure predicate the component
  // imports from here too, and a bare factory would drop it.
  const real = await importOriginal<typeof import('../../client/useEffectiveAccess.js')>();
  return { ...real, useEffectiveAccessState: () => access };
});

const announced = vi.hoisted(() => ({ calls: [] as Array<[string, { assertive?: boolean } | undefined]> }));
vi.mock('../announce.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../announce.js')>();
  return {
    ...real,
    announce: (msg: string, opts?: { assertive?: boolean }) => { announced.calls.push([msg, opts]); },
  };
});

beforeEach(() => {
  announced.calls.length = 0;
  access.access = { roles: [], scopes: [], basis: 'none' };
  access.resolved = true;
});
afterEach(cleanup);

const view = (props: Partial<React.ComponentProps<typeof OrgSelectionState>> = {}): void => {
  render(
    <MemoryRouter>
      <OrgSelectionState
        orgs={null} orgsFailed={false} retry={() => undefined}
        emptyBody="Business metrics belong to an organization"
        {...props}
      >
        <div data-testid="content">the feature</div>
      </OrgSelectionState>
    </MemoryRouter>,
  );
};

describe('OrgSelectionState — branch order', () => {
  it('FAILED wins over empty, even though orgs is falsy: a failed read is not an empty account', () => {
    // The ambiguous input: orgsFailed AND no orgs. The empty branch must NOT win.
    view({ orgsFailed: true, orgs: [] });
    expect(screen.getByText('Could not load your organizations')).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByTestId('content')).toBeNull();
  });

  it('EMPTY wins over loading: the server answered "none", so nothing may still claim to be loading', () => {
    view({ orgs: [] });
    expect(screen.getByText('No organizations')).toBeTruthy();
    // The feature-specific clause survives inside the shared sentence shape —
    // EXACT, so a frame that reintroduced "Create an organization first — " in
    // front of it goes red rather than still matching.
    expect(screen.getByText('Business metrics belong to an organization.')).toBeTruthy();
    expect(screen.queryByTestId('content')).toBeNull();
  });

  it('reading (orgs === null) renders the feature, not a false empty state', () => {
    view({ orgs: null });
    expect(screen.getByTestId('content')).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('with organizations, the feature owns the screen', () => {
    view({ orgs: [{ orgId: 'o1' }] });
    expect(screen.getByTestId('content')).toBeTruthy();
  });

  it('the failure offers a working retry', () => {
    const retry = vi.fn();
    view({ orgsFailed: true, orgs: null, retry });
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(retry).toHaveBeenCalledTimes(1);
    // …and never the empty state's CTA, which would be an instruction about
    // data the read could not see.
    expect(screen.queryByRole('link', { name: 'Create an organization' })).toBeNull();
  });

  it('inline variant keeps the same order — a panel must not disagree with a page', () => {
    view({ orgsFailed: true, orgs: [], variant: 'inline', failedBody: 'The reviews were never requested' });
    // EXACT, not `/Could not load your organizations/`: the loose form matched
    // the run-on this variant used to ship, so it could never have caught it.
    expect(screen.getByText(
      'Could not load your organizations. The reviews were never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.queryByTestId('content')).toBeNull();
  });
});

/**
 * The clause the twelve deleted `orgsFailedBody` strings carried. A failed read
 * KNOWS NOTHING, so the one honest thing it can add to "could not load" is what
 * did not happen as a result — the metric list was never requested, the domain
 * list could not be read. Without the slot, centralising silently replaced all
 * twelve with a sentence that discloses the failure and withholds its cost.
 */
describe('OrgSelectionState — the failed card keeps its consequence clause', () => {
  it('page variant composes the feature clause into the shared sentence', () => {
    view({ orgsFailed: true, failedBody: 'The metric list was never requested' });
    expect(screen.getByText(
      'The metric list was never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
  });

  it('inline variant composes the SAME sentence, after the title, as ONE sentence each', () => {
    // Exact rather than the regex this used to be: the regex asserted only that
    // the body appeared SOMEWHERE in the line, which is exactly as true of
    // "Could not load your organizations The widget list could not be read…".
    view({ orgsFailed: true, variant: 'inline', failedBody: 'The widget list could not be read' });
    expect(screen.getByText(
      'Could not load your organizations. The widget list could not be read. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
  });

  it('without the clause it falls back to the bare sentence, and never renders a stray separator', () => {
    // The failure mode a naive `${what}. ${rest}` concatenation would ship: a
    // card opening with ". This is a failed read".
    view({ orgsFailed: true });
    expect(screen.getByText('This is a failed read, not an empty organization list.')).toBeTruthy();
  });

  it('the shared sentence says it once — §4.6 rule 2, one clause of consequence', () => {
    view({ orgsFailed: true, failedBody: 'The ticket list was never requested' });
    expect(document.body.textContent).not.toContain('it does not mean you have no organizations');
  });

  /**
   * The contrast names THIS collection. "not an empty account" was a fourth
   * noun for it, and the Romance catalogs had translated it literally — `una
   * cuenta vacía`, `uma conta vazia` — which on a product with subscriptions
   * reads as billing, i.e. a failed org read told a user their ACCOUNT was
   * empty. Pinned as an absence because the wrong noun is what regresses.
   */
  it('the contrast names organizations, never an "account"', () => {
    view({ orgsFailed: true, failedBody: 'The domain list could not be read' });
    expect(document.body.textContent).not.toContain('account');
    expect(document.body.textContent).toContain('not an empty organization list');
  });
});

/**
 * DESIGN.md §4.6 rule 8, both halves, on BOTH variants. `page` (via `StateCard`)
 * always obeyed; `inline` announced `${title} ${body}` assertively, so
 * centralising had just spread one wrong answer across every panel adopter.
 *
 * TITLE ONLY because the body is server-shaped detail that changes on retry —
 * noise read aloud, re-announced for nothing. POLITE because the card appears on
 * LOAD, not in response to something the user did.
 */
describe('OrgSelectionState — announcements (§4.6 rule 8)', () => {
  it('inline announces the TITLE only, POLITELY', () => {
    view({ orgsFailed: true, variant: 'inline', failedBody: 'The widget list could not be read' });
    expect(announced.calls).toHaveLength(1);
    const [msg, opts] = announced.calls[0]!;
    expect(msg).toBe('Could not load your organizations');
    expect(opts?.assertive).toBeFalsy();
  });

  it('page announces the TITLE only, POLITELY', () => {
    view({ orgsFailed: true, failedBody: 'The metric list was never requested' });
    expect(announced.calls).toHaveLength(1);
    const [msg, opts] = announced.calls[0]!;
    expect(msg).toBe('Could not load your organizations');
    expect(opts?.assertive).toBeFalsy();
  });

  it('an EMPTY state announces nothing at all — it is not a failure', () => {
    view({ orgs: [] });
    expect(announced.calls).toHaveLength(0);
  });
});

/**
 * §5.1 — "Every empty state MUST name its single next action." This branch
 * NARRATED one ("Create an organization first") while the failure branch beside
 * it OFFERED one, which is backwards: empty is the state where the user can act.
 *
 * Gated, because `/orgs` is admin-tier and its create form is disabled without
 * `host:org:manage` (`orgs/OrgsListPanel.tsx`). A CTA for anyone else is a link
 * to a control that will refuse them.
 */
describe('OrgSelectionState — the empty card names its next action, when there is one', () => {
  it('a caller who can create organizations gets the CTA and no "ask an administrator"', () => {
    access.access = { roles: [], scopes: ['host:org:manage'], basis: 'member' };
    view({ orgs: [] });
    const cta = screen.getByRole('link', { name: 'Create an organization' });
    expect(cta.getAttribute('href')).toBe('/orgs');
    expect(document.body.textContent).not.toContain('Ask an administrator');
    // …and the body does NOT also narrate it. Adding the CTA without deleting
    // the narration is the exact half-fix that shipped: "Create an organization
    // first — …" beside a link reading "Create an organization" (§4.6 rule 7,
    // "offer the recovery, don't narrate it").
    expect(screen.getByText('Business metrics belong to an organization.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Create an organization first');
  });

  it('the workspace owner gets it too — basis, not a scope, is their authority', () => {
    access.access = { roles: [], scopes: [], basis: 'tenant-owner' };
    view({ orgs: [] });
    expect(screen.getByRole('link', { name: 'Create an organization' })).toBeTruthy();
  });

  it('a caller who cannot gets the "ask an administrator" clause and NO CTA', () => {
    access.access = { roles: ['member'], scopes: [], basis: 'member' };
    view({ orgs: [] });
    expect(screen.getByText('Ask an administrator to create one.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Create an organization' })).toBeNull();
  });

  /**
   * INSTRUCT-THEN-RETRACT — the worst shape this card had, and the one nothing
   * could see while the body was asserted with a regex. A caller with no
   * `host:org:manage` read "Create an organization first — …" and then, one
   * line down, "Ask an administrator to create one.": told to do a thing, then
   * told they may not do it. The body must now END on the ask.
   */
  it('an unprivileged caller is never instructed and then retracted', () => {
    access.access = { roles: ['member'], scopes: [], basis: 'member' };
    view({ orgs: [] });
    expect(screen.getByText('Business metrics belong to an organization.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Create an organization first');
    // The reason, then the ask, and nothing between them.
    expect(document.body.textContent).toContain(
      'Business metrics belong to an organization.Ask an administrator to create one.',
    );
  });

  it('admin-tier reach is NOT enough — the create form wants host:org:manage specifically', () => {
    // `isAdminCaller` admits any `host:*:manage`, so this caller reaches /orgs
    // and finds the create button disabled. Offering the CTA would route them to
    // a refusal; naming no action is the honest answer.
    access.access = { roles: [], scopes: ['host:teams:manage'], basis: 'member' };
    view({ orgs: [] });
    expect(screen.queryByRole('link', { name: 'Create an organization' })).toBeNull();
    expect(screen.getByText('Ask an administrator to create one.')).toBeTruthy();
  });

  it('while the capability read is in flight it claims NEITHER', () => {
    // Guessing would mean telling an administrator to go ask an administrator.
    access.resolved = false;
    view({ orgs: [] });
    expect(screen.getByText('No organizations')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Create an organization' })).toBeNull();
    expect(document.body.textContent).not.toContain('Ask an administrator');
  });

  it('the inline variant gates the same way — a panel must not offer what a page withholds', () => {
    access.access = { roles: ['admin'], scopes: [], basis: 'member' };
    view({ orgs: [], variant: 'inline' });
    expect(screen.getByRole('link', { name: 'Create an organization' })).toBeTruthy();

    cleanup();
    access.access = { roles: [], scopes: [], basis: 'member' };
    view({ orgs: [], variant: 'inline' });
    expect(screen.queryByRole('link', { name: 'Create an organization' })).toBeNull();
    expect(screen.getByText('Ask an administrator to create one.')).toBeTruthy();
  });
});

/**
 * THE RUN-ON, pinned as an exact string on both branches.
 *
 * `InlineState` is one line, so the component composed `{title} {body}` — and
 * the title has no terminal stop. `csm` and `marketplace` therefore shipped
 * "No organizations Create an organization first — CRM links belong to an org."
 * Every assertion in this file used `getByText(/…/)` at the time, and a regex
 * over a fragment of the line matches the run-on exactly as well as the fix, so
 * nothing here could have gone red. These are whole-string, deliberately.
 */
describe('OrgSelectionState — the inline variant reads as sentences, not a run-on', () => {
  it('empty: the title is a sentence and the reason is the next one', () => {
    access.access = { roles: [], scopes: ['host:org:manage'], basis: 'member' };
    view({ orgs: [], variant: 'inline' });
    expect(screen.getByText(
      'No organizations. Business metrics belong to an organization.',
    )).toBeTruthy();
    expect(document.body.textContent).not.toContain('No organizations Business');
  });

  it('empty + unprivileged: the ask is its own sentence after the reason', () => {
    access.access = { roles: [], scopes: [], basis: 'member' };
    view({ orgs: [], variant: 'inline' });
    expect(screen.getByText(
      'No organizations. Business metrics belong to an organization.',
    )).toBeTruthy();
    expect(screen.getByText('Ask an administrator to create one.')).toBeTruthy();
  });

  it('failed: same join, so a panel and a page differ only in chrome', () => {
    view({ orgsFailed: true, variant: 'inline', failedBody: 'The company list was never requested' });
    expect(screen.getByText(
      'Could not load your organizations. The company list was never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(document.body.textContent).not.toContain('organizations The company list');
  });
});
