/**
 * ADR 1039 D8 (CB82XC-2) — "Ask the Creative Director": opens the ONE chat
 * scoped to the Creative Director, with an editable draft naming this brief (and
 * its org, so a multi-org workspace needs no follow-up), so the agent's first
 * move is `openwop:creative-briefs.get` on it. No second chat surface (CLAUDE.md
 * "AI chat — reuse, never recreate"): a staged composer draft plus the
 * `/?agent=` deep link, the EvalScorecard / CRM precedent.
 *
 * Shown only when the caller's agent catalog lists the agent: `/v1/agents` lists
 * installed packs, and the chat silently ignores an unknown `?agent=` id, so an
 * unconditional button could open an unscoped chat. Ids are compared CANONICALLY
 * (ADR 0763 two spellings). A dirty form saves first, like every other action on
 * the brief (CRB-G1), or the agent would read the version before the edits.
 */
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { SparklesIcon } from '../../ui/icons/index.js';
import { useAgentMentions } from '../../chat/lib/agentMentions.js';
import { stageComposerDraft } from '../../chat/composerSeed.js';
import { canonicalAgentId } from '../../chat/agentIdAliases.js';

/** The canonical id the campaign-studio agent pack registers. */
export const CREATIVE_DIRECTOR_AGENT_ID = 'vendor.openwop-app.campaign-studio.agents.creative-director';

export function AskCreativeDirector({ briefId, orgId, title, dirty, onSaveFirst }: {
  briefId: string; orgId: string; title: string;
  /** The form has unsaved edits: save them first (the label says so). */
  dirty: boolean;
  /** Resolves false when the save failed (it has already said why). */
  onSaveFirst: () => Promise<boolean>;
}): JSX.Element | null {
  const { t } = useTranslation('creative-briefs');
  const navigate = useNavigate();
  const { entries } = useAgentMentions();
  const agent = entries.find((e) => canonicalAgentId(e.agentId) === CREATIVE_DIRECTOR_AGENT_ID);
  if (!agent) return null;
  const ask = async (): Promise<void> => {
    if (dirty && !(await onSaveFirst())) return;
    stageComposerDraft(t('askCreativeDirectorDraft', { title, briefId, orgId }));
    void navigate(`/?agent=${encodeURIComponent(CREATIVE_DIRECTOR_AGENT_ID)}`);
  };
  return (
    <Button variant="quiet" size="sm" onClick={() => void ask()} title={t('askAgentHint')}>
      <SparklesIcon size={14} aria-hidden /> {dirty ? t('saveAndAskAgent', { name: agent.displayName }) : t('askAgent', { name: agent.displayName })}
    </Button>
  );
}
