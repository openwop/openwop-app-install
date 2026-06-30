/**
 * Empty-state welcome card (inner-content redesign 2026-06-05). Pivots from
 * "ask the LLM about OpenWOP" to the actual differentiator: run a multi-step
 * workflow with `/`, or hand a task to a named agent with `@`.
 *
 * All four cards are REAL slash invocations of the seeded premade templates —
 * clicking pre-fills the composer with `/slug` + a representative input so
 * Send dispatches a real run. Below them, the agent pills hand the chat to a
 * named roster persona (`@nora `). No fabricated badges: there is no usage
 * telemetry, so nothing claims "most used".
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ClockIcon, ColumnsIcon, SparklesIcon, ZapIcon } from '../ui/icons/index.js';
import { Skeleton } from '../ui/Skeleton.js';
import { listWorkflowMentions } from './lib/workflowMentions.js';
import { useAgentMentions, type AgentMentionEntry } from './lib/agentMentions.js';
import { topUpSeededWorkflows } from '../builder/persistence/localStore.js';
import { PREMADE_WORKFLOWS, cloneTemplateToUserWorkflow } from '../builder/templates/premadeWorkflows.js';
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

const WORKFLOW_CARD_SPECS: readonly WorkflowCardSpec[] = [
  {
    glyph: <ColumnsIcon size={16} />,
    titleKey: 'exampleContentReviewTitle',
    templateName: 'Multi-channel content review',
    descKey: 'exampleContentReviewDesc',
    promptKey: 'exampleContentReviewPrompt',
  },
  {
    glyph: <ClockIcon size={16} />,
    titleKey: 'exampleApprovalTitle',
    templateName: 'Approval escalation with timeout fallback',
    descKey: 'exampleApprovalDesc',
    promptKey: 'exampleApprovalPrompt',
  },
  {
    glyph: <SparklesIcon size={16} />,
    titleKey: 'exampleReviewBoardTitle',
    // Match the EXACT premadeWorkflows.ts template name (hyphenated).
    // Welcome-card resolution does a case-insensitive prefix match
    // against listWorkflowMentions(); the hyphen has to be present
    // for the match to fire.
    templateName: 'Triple-AI review board',
    descKey: 'exampleReviewBoardDesc',
    // The three critic system prompts say "Read the text below" — so
    // the prompt MUST be real prose, not a meta-instruction. Earlier
    // versions sent "Critique this paragraph for clarity and concision"
    // which the LLM correctly identified as an instruction with no
    // actual paragraph attached.
    promptKey: 'exampleReviewBoardPrompt',
  },
  {
    glyph: <ZapIcon size={16} />,
    titleKey: 'exampleRaceTitle',
    templateName: 'Race-to-respond with audit trail',
    descKey: 'exampleRaceDesc',
    promptKey: 'exampleRacePrompt',
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

  // Resolve each card's live slug once per render. This binds the
  // welcome card to the user's actual workflow inventory rather than
  // hard-coded slugs that go stale when slugify rules / template
  // names change. Cards whose template isn't in the user's saved
  // workflows render disabled with a tooltip explaining why.
  const resolvedCards = useMemo(
    () => {
      // PRE-SEED: chat is most visitors' FIRST page, but the premade
      // templates these cards point at were only seeded on the workflow
      // dashboard's first visit — so the cards rendered "(not available)"
      // until the user happened to open /builder. Run the SAME first-visit
      // seed here (same persisted flag → first surface visited wins, and a
      // user who deleted their workflows is still never re-seeded).
      topUpSeededWorkflows(
        PREMADE_WORKFLOWS
          .filter((tpl) => !tpl.requiresTypeIds)
          .map((tpl) => cloneTemplateToUserWorkflow(tpl)),
      );
      return WORKFLOW_CARD_SPECS.map((spec) => ({
        ...spec,
        slug: resolveSlug(spec.templateName),
      }));
    },
    // listWorkflowMentions reads localStorage synchronously; we
    // intentionally don't subscribe to it here because the welcome
    // card only renders when no chat messages exist yet, and the
    // user can't have mutated saved workflows mid-session without a
    // full page reload (no live cross-tab sync for the builder).
    [],
  );

  return (
    <div className="welcome-root">
      <div className="welcome-icon-circle" aria-hidden>
        <SparklesIcon size={28} />
      </div>
      <h2 className="welcome-title">
        {t('welcomeHeading')}
      </h2>
      <p className="muted welcome-lede">
        {t('welcomeIntroPrefix')}<code className="welcome-key">/</code>{t('welcomeIntroMid')}<code className="welcome-key">@</code>{t('welcomeIntroSuffix')}
      </p>
      <div className="page-enter welcome-grid">
        {resolvedCards.map((c) => {
          const available = c.slug !== null;
          return (
            <button
              key={c.templateName}
              type="button"
              className="welcome-card"
              disabled={!available}
              onClick={() => {
                if (c.slug) onPickSuggestion(`/${c.slug} ${t(c.promptKey)}`);
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
                onClick={() => onPickSuggestion(`@${a.slug} `)}
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
