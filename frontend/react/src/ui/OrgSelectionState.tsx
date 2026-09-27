/**
 * The ONE renderer for `useOrgSelection`'s three states (`HG-4`).
 *
 * 18 features consume that hook and every one of them hand-wrote the same
 * branch, the same five strings, and the same noun. Both halves went wrong:
 *
 *  - **The noun.** 9 of 18 mixed "workspace" and "organization" WITHIN ONE
 *    SCREEN — `funnels` shipped `noOrgs: 'No workspaces'` five lines from
 *    `noOrgsTitle: 'No organizations'`; `cms` had a title, a body, and the
 *    body's own second clause all disagreeing. Three more used a third noun
 *    ("stores"). That is not a typo class: "workspace" and "organization" name
 *    two DIFFERENT server collections here (`listMyWorkspaces` synthesizes a
 *    "Personal sandbox" for anonymous callers; `listOrgs` returns `[]`), so a
 *    page saying "No workspace yet" beside a sidebar showing an active
 *    workspace is a false claim, not merely an inconsistent one.
 *
 *    The noun also has to hold on the CONTROL, not just the card — the split
 *    survived the first cut of this component on five pages, where the shared
 *    card said "No organizations" three lines from a `<select>` labelled
 *    "Workspace" or "Store". `ui:orgPickerLabel` is that label, and it is the
 *    only way this stops drifting: the picker and the card now read one key
 *    family from one namespace.
 *
 *  - **The branch ORDER, which is the worse half.** `orgsFailed` must sit above
 *    the zero-orgs branch (a failed read must not borrow the empty state's
 *    meaning) and zero-orgs must sit above loading (or the org-gated dependent
 *    read never starts and the page renders a skeleton with no terminal
 *    condition — the server answered "none" while the screen says "loading").
 *    That ordering was got wrong on nine surfaces and fixed by hand nine times.
 *    A lint rule can check spelling; only a component can encode an order.
 *
 * The noun and the ordering live here. Each branch keeps a feature-owned CLAUSE
 * via a slot — `emptyBody` ("Analytics belong to an organization") and `failedBody`
 * ("The metric list was never requested") are genuinely feature-specific, and
 * that variation is why the copy was local in the first place.
 *
 * **`failedBody` is not optional decoration.** The first cut of this component
 * gave only the EMPTY branch a slot, so centralising deleted twelve features'
 * causal clause and left one generic sentence in its place. That clause is the
 * honest half: a failed read knows nothing, and the one thing it CAN say is what
 * did not happen because of it (DESIGN.md §4.6 — "state the failure and its
 * consequence"). Without it the card discloses that something failed while
 * withholding what that cost the reader.
 *
 * Shared copy lives in the existing `ui` i18n namespace, which `ui/` components
 * already use (`ColorField`, `ConfirmDialog`); this introduces no new namespace
 * model.
 *
 * Composes `StateCard`/`InlineState` rather than duplicating them (DESIGN.md
 * §5.1): `variant="page"` for a full-page surface, `variant="inline"` for a
 * panel or table body.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { canManageOrgs, useEffectiveAccessState } from '../client/useEffectiveAccess.js';
import { Button } from './Button.js';
import { InlineState } from './InlineState.js';
import { StateCard } from './StateCard.js';

export interface OrgSelectionStateProps {
  /** From `useOrgSelection` — `null` means "not read yet", never "none". */
  orgs: readonly unknown[] | null;
  orgsFailed: boolean;
  /** From `useOrgSelection` — re-runs the read. */
  retry: () => void;
  /**
   * The feature-specific ZERO-ORG clause — the REASON an organization is needed,
   * never the instruction to create one. That instruction is the CTA's, and the
   * card said it twice until this docstring's own example was the narration
   * (§4.6 rule 7).
   *
   * A capitalised sentence WITHOUT its final stop, e.g.
   * `"Business metrics belong to an organization"`. Rendered as `"{{what}}."`,
   * so the frame supplies the stop and nothing else — which is what lets the
   * clause name the noun once. Say "organization", never "org": the frame, the
   * title and the CTA all say organization, and one screen with two spellings of
   * one noun is the drift this component exists to end.
   */
  emptyBody: string;
  /**
   * The feature-specific half of the FAILED body — the downstream read this
   * failure cost the user, as a full clause with no trailing stop, e.g.
   * `"The metric list was never requested"`. Rendered as
   * "{{what}}. This is a failed read, not an empty organization list."
   *
   * Do NOT restate the cause here: the title already says the organizations
   * could not be loaded, so "…because the workspace list failed" is the same
   * sentence twice (§4.6 rule 2 — one clause of consequence, then stop).
   *
   * Optional only because a surface may genuinely have no gated read to name;
   * if yours does, name it.
   */
  failedBody?: string;
  /** Full-page surface vs an embedded panel/table body. */
  variant?: 'page' | 'inline';
  /** Optional icon for the page-variant empty card. */
  icon?: ReactNode;
  /**
   * What to render when there IS at least one organization — i.e. the feature's
   * real content. Taking it as a child is what makes the ordering
   * unskippable: a caller cannot render content above the failure branch.
   */
  children: ReactNode;
}

/**
 * The zero-org card, split out so the capability read below happens ONLY in the
 * branch that needs it — a hook on the parent would fire an access read on every
 * org-scoped page load, including the overwhelmingly common case where the
 * tenant has organizations and this card never renders.
 *
 * DESIGN.md §5.1: "Every empty state MUST name its single next action." This one
 * did not — it NARRATED the action ("Create an organization first") while the
 * failure branch beside it OFFERED one, which is the wrong way round: empty is
 * the branch where the user can actually act.
 *
 * But only when they can. `/orgs` is admin-tier and the create form there is
 * gated on `host:org:manage`, so for everyone else a CTA is a link to a control
 * that will be disabled on arrival. They get the house "ask an administrator"
 * clause instead, and no button — an unreachable next action is worse than none.
 * While the access read is still in flight the card shows neither: guessing
 * would mean telling an admin to go ask an administrator.
 *
 * CORRECTION (§4.6 rule 7, second pass). Adding the CTA did not REMOVE the
 * narration, so for a privileged caller the card then stated its action twice —
 * body "Create an organization first — …" beside a link reading "Create an
 * organization". For an unprivileged caller it was worse than redundant: the
 * instruction was followed immediately by "Ask an administrator to create one.",
 * i.e. told to do a thing and then told they may not. The body now carries only
 * the CLAUSE (why an organization is needed); the CTA carries the instruction;
 * and the unprivileged card ends on the ask, with no instruction to retract.
 */
function OrgEmptyState({
  emptyBody, variant, icon,
}: Pick<OrgSelectionStateProps, 'emptyBody' | 'variant' | 'icon'>): JSX.Element {
  const { t } = useTranslation('ui');
  const { access, resolved } = useEffectiveAccessState();
  const mayCreate = resolved && canManageOrgs(access);
  const askAdmin = resolved && !mayCreate;

  const title = t('orgStateEmptyTitle');
  const reason = t('orgStateEmptyBody', { what: emptyBody });
  const ask = askAdmin ? <span className="u-block">{t('orgStateEmptyAskAdmin')}</span> : null;

  if (variant === 'inline') {
    // ONE line, so the title needs a sentence break the card gets for free from
    // two elements — `{title} {body}` rendered the run-on "No organizations
    // Create an organization first…" on `csm` and `marketplace`. The join is a
    // locale string, not a `${}`: sentence punctuation is a translator's call.
    return (
      <InlineState
        kind="empty"
        message={<><span>{t('orgStateInlineSentence', { title, body: reason })}</span>{ask}</>}
        {...(mayCreate ? { action: <Link className="btn btn-sm" to="/orgs">{t('orgStateEmptyAction')}</Link> } : {})}
      />
    );
  }
  return (
    <StateCard
      icon={icon}
      title={title}
      body={<><span>{reason}</span>{ask}</>}
      {...(mayCreate ? { action: <Link className="btn" to="/orgs">{t('orgStateEmptyAction')}</Link> } : {})}
    />
  );
}

/**
 * @returns the failure state, the zero-org state, or `children` — in that
 * order, always.
 */
export function OrgSelectionState({
  orgs, orgsFailed, retry, emptyBody, failedBody, variant = 'page', icon, children,
}: OrgSelectionStateProps): JSX.Element {
  const { t } = useTranslation('ui');

  // 1. FAILED — first, and never collapsed into "none". `orgs` stays null here.
  if (orgsFailed) {
    const title = t('orgStateFailedTitle');
    const body = failedBody
      ? t('orgStateFailedBodyWith', { what: failedBody })
      : t('orgStateFailedBody');
    const action = <Button variant="secondary" onClick={retry}>{t('orgStateRetry')}</Button>;
    // Both variants announce the TITLE ONLY and POLITELY (DESIGN.md §4.6 rule 8).
    // The body carries the server-shaped detail — noise read aloud, and it changes
    // on retry, so it would re-announce for nothing. Polite because this card
    // appears on LOAD: interrupting someone mid-sentence for something they did
    // not do is the wrong trade. The inline variant used to do neither, and
    // centralising had spread that one wrong answer across every panel adopter.
    // The inline join is the shared locale sentence, not a `${title} ${body}`:
    // that concatenation ran an unpunctuated title straight into the body.
    return variant === 'inline'
      ? <InlineState kind="failed" message={t('orgStateInlineSentence', { title, body })} announce={title} announcePolite action={action} />
      : <StateCard announce title={title} body={body} action={action} />;
  }

  // 2. GENUINELY EMPTY — the server answered "none". Above loading, because the
  //    org-gated read never starts, so a loading branch here never terminates.
  //    No `announce`: an empty state is not a failure (DESIGN.md §4.6 rule 8).
  if (orgs !== null && orgs.length === 0) {
    return <OrgEmptyState emptyBody={emptyBody} variant={variant} icon={icon} />;
  }

  // 3. Reading, or we have organizations — the feature owns the screen.
  return <>{children}</>;
}
