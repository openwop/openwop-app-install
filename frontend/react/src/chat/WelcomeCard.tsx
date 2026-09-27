/**
 * Empty-state welcome card (inner-content redesign 2026-06-05). Pivots from
 * "ask the LLM about OpenWOP" to the actual differentiator: run a multi-step
 * workflow with `/`, or hand a task to a named agent with `@`.
 *
 * All four cards are REAL slash invocations of the zero-config pack templates
 * the first-visit preload instantiates (ADR 0163) — clicking pre-fills the
 * composer with `/slug` + a representative input so Send dispatches a real run.
 * Below them, the agent pills hand the chat to a named roster persona
 * (`@nora `). No fabricated badges: there is no usage telemetry, so nothing
 * claims "most used".
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ClockIcon, ColumnsIcon, SparklesIcon, ZapIcon } from '../ui/icons/index.js';
import { Skeleton } from '../ui/Skeleton.js';
import { useAuth } from '../auth/useAuth.js';
import { isFirstRunDismissed, dismissFirstRun } from '../onboarding/firstRunFlag.js';
import { listWorkflowMentions, refreshWorkflowMentionCache } from './lib/workflowMentions.js';
import { useAgentMentions, type AgentMentionEntry } from './lib/agentMentions.js';
import { getMyProfile } from '../features/profiles/profilesClient.js';
import { listRoster, type RosterEntry } from '../agents/rosterClient.js';

/** Retired legacy demo personas (ADR 0032) — excluded from the welcome-row
 *  smart default so a not-yet-pruned tenant never shows a stale name. */
const RETIRED_PERSONAS = new Set(['sally', 'marcus', 'priya', 'devon', 'nora']);
/** The workspace assistant persona — surfaced FIRST in the smart default. */
const ASSISTANT_PERSONA = 'iris';

/** The agents shown in the "hand it to an agent" row: the user's PINNED-to-chat
 *  agents when set, else a curated smart default (assistant first, retired legacy
 *  personas excluded). Pins are rosterIds; the chips come from the agent
 *  inventory (keyed by agentId), so map rosterId → agentRef.agentId → entry. */
/** Collapse entries that share a display persona (case-insensitive) — two roster
 *  registrations of the same named agent (e.g. a second "Iris") otherwise render
 *  as duplicate @-pills. Keeps the first occurrence. */
function dedupeByPersona(list: readonly AgentMentionEntry[]): AgentMentionEntry[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const key = e.persona.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function welcomePersonas(
  entries: readonly AgentMentionEntry[],
  pinnedChatRosterIds: readonly string[],
  roster: readonly RosterEntry[],
): AgentMentionEntry[] {
  const byAgentId = new Map(entries.map((e) => [e.agentId, e]));
  if (pinnedChatRosterIds.length > 0) {
    const agentIdByRoster = new Map(roster.map((r) => [r.rosterId, r.agentRef?.agentId]));
    const out: AgentMentionEntry[] = [];
    for (const rosterId of pinnedChatRosterIds) {
      const agentId = agentIdByRoster.get(rosterId);
      const entry = agentId ? byAgentId.get(agentId) : undefined;
      if (entry) out.push(entry);
    }
    if (out.length > 0) return dedupeByPersona(out);
  }
  // Smart default: user-roster agents, retired legacy personas excluded, the
  // assistant (Iris) first, deduped by persona, capped at five.
  return dedupeByPersona(
    entries
      .filter((e) => e.agentId.startsWith('user.') && !RETIRED_PERSONAS.has(e.persona.toLowerCase()))
      .sort((a, b) => (a.persona.toLowerCase() === ASSISTANT_PERSONA ? 0 : 1) - (b.persona.toLowerCase() === ASSISTANT_PERSONA ? 0 : 1)),
  ).slice(0, 5);
}

interface Props {
  onPickSuggestion: (text: string) => void;
}

interface WorkflowCardSpec {
  /** Small visual anchor — an icon component, or an emoji (for glyphs
   *  with no icon-set equivalent, e.g. the traffic light). */
  glyph: ReactNode;
  /** `chat`-namespace catalog key for the card headline (display only),
   *  resolved via `t()` at the render site. */
  titleKey: string;
  /** Template display-name pattern. Matched (case-insensitive, prefix)
   *  against `listWorkflowMentions()` entries to resolve the live slug
   *  at render time. Avoids the prior bug where hard-coded slugs went
   *  stale when the slugify rules changed. */
  templateName: string;
  /** `chat`-namespace catalog key for the one-line description of what
   *  the workflow does, resolved via `t()` at the render site. */
  descKey: string;
  /** `chat`-namespace catalog key for the trailing text appended after
   *  the resolved @-mention. Becomes `inputs.<firstKey>` via the
   *  workflowMentions trailing-text fix. Resolved via `t()` at dispatch. */
  promptKey: string;
}

// The four cards point at the ZERO-CONFIG pack templates that the first-visit
// preload instantiates (ADR 0163) — real, runnable workflows, not the retired
// toy examples. `templateName` must be a case-insensitive prefix of the
// instantiated workflow's display name (its chain label), which is how
// `resolveSlug` matches against listWorkflowMentions(). A card whose pack isn't
// installed on this host degrades to a disabled "(not available)" tile.
const WORKFLOW_CARD_SPECS: readonly WorkflowCardSpec[] = [
  {
    glyph: <ZapIcon size={16} />,
    titleKey: 'exampleLeadTriageTitle',
    templateName: 'Inbound Lead Triage & Routing',
    descKey: 'exampleLeadTriageDesc',
    promptKey: 'exampleLeadTriagePrompt',
  },
  {
    glyph: <ClockIcon size={16} />,
    titleKey: 'exampleRenewalTitle',
    templateName: 'Renewal & Churn-Risk Digest',
    descKey: 'exampleRenewalDesc',
    promptKey: 'exampleRenewalPrompt',
  },
  {
    glyph: <ColumnsIcon size={16} />,
    titleKey: 'exampleBriefingTitle',
    templateName: 'Daily Executive Briefing',
    descKey: 'exampleBriefingDesc',
    promptKey: 'exampleBriefingPrompt',
  },
  {
    glyph: <SparklesIcon size={16} />,
    titleKey: 'exampleAdOptTitle',
    templateName: 'Ad Performance Optimization Loop',
    descKey: 'exampleAdOptDesc',
    promptKey: 'exampleAdOptPrompt',
  },
];

/** Resolve a card's live slug from the user's saved workflows.
 *  Matches displayName by case-insensitive prefix so " (from template)"
 *  suffixes match correctly. Returns null when the seeded template
 *  isn't in the user's localStorage (e.g., they cleared it). */
function resolveSlug(templateName: string): string | null {
  const lower = templateName.toLowerCase();
  const entry = listWorkflowMentions().find((e) =>
    e.displayName.toLowerCase().startsWith(lower),
  );
  return entry?.slug ?? null;
}

export function WelcomeCard({ onPickSuggestion }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const { user } = useAuth();
  const uid = user?.uid;
  // SHELL-4 — the first-run "getting started" layer. Shown ONLY to a signed-in
  // user who hasn't dismissed it (or already engaged); a returning user opening a
  // new empty thread keeps the steady WelcomeCard. Reuses the ADR 0188 per-uid
  // localStorage flag via the shared `onboarding/firstRunFlag` helper so the two
  // first-run surfaces (this + VendorSetupPrompt) share one key scheme. Starts
  // hidden and reveals after the storage check → no flash for returning users.
  const [firstRun, setFirstRun] = useState(false);
  useEffect(() => {
    setFirstRun(!!uid && !isFirstRunDismissed('getStarted', uid));
  }, [uid]);
  const gridRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const eyebrowId = useId();
  const dismissFirstRunStrip = useCallback(() => {
    dismissFirstRun('getStarted', uid);
    setFirstRun(false);
    // Keyboard users: the focused Skip button is about to unmount — don't drop
    // focus to page top. Land on the first runnable workflow card (the primary
    // action); if none is enabled (templates not preloaded), fall back to the
    // heading so focus stays in the welcome region.
    requestAnimationFrame(() => {
      const target = gridRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? headingRef.current;
      target?.focus();
    });
  }, [uid]);
  // Engaging with any card/pill also retires the first-run strip (they've
  // started) — the flag is set so it won't reappear on their next empty thread.
  // The strip is left in place for THIS render (no jarring mid-view collapse);
  // it disappears naturally when the user sends and WelcomeCard unmounts.
  const handlePick = useCallback((text: string) => {
    if (firstRun) dismissFirstRun('getStarted', uid); // uid is set whenever firstRun is
    onPickSuggestion(text);
  }, [firstRun, uid, onPickSuggestion]);
  // The named roster personas — the `@` hand-off pills under the cards: the
  // user's pinned-to-chat agents when set, else a curated smart default.
  const { entries: agentEntries } = useAgentMentions();
  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  // The agent row loads async; track it so we can render a skeleton placeholder
  // instead of popping the pills in after first paint (designed loading state).
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void Promise.all([
        getMyProfile().then((p) => p.pinnedChatAgentIds ?? []).catch(() => [] as string[]),
        listRoster().catch(() => [] as RosterEntry[]),
      ]).then(([ids, r]) => { if (!cancelled) { setPinnedChatIds(ids); setRoster(r); setAgentsLoaded(true); } });
    };
    load();
    const onChange = (): void => load();
    window.addEventListener('openwop:pinned-chat-agents-changed', onChange);
    return () => { cancelled = true; window.removeEventListener('openwop:pinned-chat-agents-changed', onChange); };
  }, []);
  const personas = useMemo(
    () => welcomePersonas(agentEntries, pinnedChatIds, roster),
    [agentEntries, pinnedChatIds, roster],
  );

  // Resolve each card's live slug against the user's actual workflow inventory
  // (rather than hard-coded slugs that go stale). Cards whose template isn't
  // installed/owned render disabled with a tooltip explaining why.
  //
  // Chat is most visitors' FIRST page, but the pack templates these cards point
  // at are instantiated by the shared first-visit preload (ADR 0163) — so we
  // run it here too (idempotent + once-flag-guarded → first surface visited
  // wins), then warm the backend-owned workflow cache and re-resolve so the
  // freshly-preloaded workflows resolve without a page reload.
  const [resolvedCards, setResolvedCards] = useState(
    () => WORKFLOW_CARD_SPECS.map((spec) => ({ ...spec, slug: resolveSlug(spec.templateName) })),
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Workflow seeding is owned by the demo seeder (POST /example-data/seed),
      // never a silent client effect — the old preload here duplicated workflows
      // on every fresh client (removed 2026-07-16). This effect now only warms
      // the @-mention cache for the welcome cards.
      await refreshWorkflowMentionCache().catch(() => undefined);
      if (cancelled) return;
      setResolvedCards(WORKFLOW_CARD_SPECS.map((spec) => ({ ...spec, slug: resolveSlug(spec.templateName) })));
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="welcome-root">
      <div className="welcome-icon-circle" aria-hidden>
        <SparklesIcon size={28} />
      </div>
      <h2 ref={headingRef} tabIndex={-1} className="welcome-title">
        {firstRun ? t('firstRunHeading') : t('welcomeHeading')}
      </h2>
      <p className="muted welcome-lede">
        {t('welcomeIntroPrefix')}<code className="welcome-key">/</code>{t('welcomeIntroMid')}<code className="welcome-key">@</code>{t('welcomeIntroSuffix')}
      </p>
      {firstRun && (
        <section className="welcome-firstrun page-enter" aria-labelledby={eyebrowId}>
          <div className="welcome-firstrun-head">
            <span id={eyebrowId} className="welcome-firstrun-eyebrow">{t('firstRunEyebrow')}</span>
            {/* No aria-label: the visible "Skip intro" is the accessible name
                (WCAG 2.5.3 Label in Name) — the "Getting started" region label
                supplies the context an over-descriptive aria-label would add. */}
            <button
              type="button"
              className="welcome-firstrun-skip"
              onClick={dismissFirstRunStrip}
            >
              {t('firstRunSkip')}
            </button>
          </div>
          <ul className="welcome-firstrun-steps">
            <li className="welcome-firstrun-step">
              <span className="welcome-firstrun-marker" aria-hidden>{t('firstRunMarkerChat')}</span>
              <span className="welcome-firstrun-step-text">
                <span className="welcome-firstrun-step-title">{t('firstRunStepChatTitle')}</span>
                <span className="welcome-firstrun-step-desc">{t('firstRunStepChatDesc')}</span>
              </span>
            </li>
            <li className="welcome-firstrun-step">
              <span className="welcome-firstrun-marker" aria-hidden>/</span>
              <span className="welcome-firstrun-step-text">
                <span className="welcome-firstrun-step-title">{t('firstRunStepRunTitle')}</span>
                <span className="welcome-firstrun-step-desc">{t('firstRunStepRunDesc')}</span>
              </span>
            </li>
            <li className="welcome-firstrun-step">
              <span className="welcome-firstrun-marker" aria-hidden>{t('firstRunMarkerApps')}</span>
              <span className="welcome-firstrun-step-text">
                <span className="welcome-firstrun-step-title">{t('firstRunStepConnectTitle')}</span>
                <span className="welcome-firstrun-step-desc">
                  {t('firstRunStepConnectDesc')}{' '}
                  <Link className="welcome-firstrun-link" to="/access?tab=connections">{t('firstRunStepConnectLink')}</Link>
                </span>
              </span>
            </li>
          </ul>
        </section>
      )}
      <div ref={gridRef} className="page-enter welcome-grid">
        {resolvedCards.map((c) => {
          const available = c.slug !== null;
          return (
            <button
              key={c.templateName}
              type="button"
              className="welcome-card"
              disabled={!available}
              onClick={() => {
                if (c.slug) handlePick(`/${c.slug} ${t(c.promptKey)}`);
              }}
              title={available
                ? t('prefillComposer', { slug: c.slug })
                : t('workflowNotSaved', { title: t(c.titleKey) })}
              aria-label={available
                ? t('runWorkflowAria', { title: t(c.titleKey), slug: c.slug })
                : t('workflowNotAvailableAria', { title: t(c.titleKey) })}
            >
              <span className="welcome-card-head">
                <span className="welcome-card-icon" aria-hidden>{c.glyph}</span>
                <span className="welcome-card-title">{t(c.titleKey)}</span>
              </span>
              <span className="welcome-card-desc">{t(c.descKey)}</span>
              <code className="welcome-slug">{c.slug ? `/${c.slug}` : t('notAvailable')}</code>
            </button>
          );
        })}
      </div>

      {!agentsLoaded ? (
        // Loading: reserve the row with skeleton pills so the real pills don't
        // pop in / shift the layout after the profile+roster fetch resolves.
        <>
          <div className="welcome-agents-label">{t('orHandToAgent')}</div>
          <div className="welcome-agents" role="status" aria-label={t('common:loading')}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} width={92} height={30} radius={999} />
            ))}
          </div>
        </>
      ) : personas.length > 0 ? (
        <>
          <div className="welcome-agents-label">{t('orHandToAgent')}</div>
          <div className="welcome-agents">
            {personas.map((a) => (
              <button
                key={a.agentId}
                type="button"
                className="welcome-agent-pill"
                onClick={() => handlePick(`@${a.slug} `)}
                title={a.displayName !== a.persona
                  ? t('handTaskToAgentNamed', { persona: a.persona, displayName: a.displayName, slug: a.slug })
                  : t('handTaskToAgent', { persona: a.persona, slug: a.slug })}
              >
                <span className="welcome-agent-avatar" aria-hidden>{a.persona.slice(0, 1).toUpperCase()}</span>
                <span className="welcome-agent-at" aria-hidden>@</span> {a.persona}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <p className="muted welcome-footnote">
        {t('justChatFooter')}
      </p>
    </div>
  );
}
