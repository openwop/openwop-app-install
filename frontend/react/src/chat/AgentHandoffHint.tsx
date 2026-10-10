/**
 * ADR 0768 follow-up D1 — one line under the composer saying what an `@agent`
 * mention will ACTUALLY do, before you send.
 *
 * The design drew "Kai joins this thread for the reply". That is not this
 * app's behaviour, so it is not the copy: `activateAgent` (chat/lib/chatSubmit.ts)
 * adds the agent to the lineup and SWITCHES routing — later replies come from
 * that agent until you switch. And the submit path skips `@` activation when
 * files are attached (`if (!attachments && …)`), so the mention would go out as
 * plain text; the hint says that instead of letting it fail silently.
 *
 * Silent where `@` means something else or another path wins: channels (members,
 * ADR 0192 D8), slash commands / workflows, and `@@` board summons.
 */
import { useTranslation } from 'react-i18next';
import { detectAgentMention, type AgentMentionEntry } from './lib/agentMentions.js';

export function AgentHandoffHint({ text, hasAttachments, inChannel, entries }: {
  text: string;
  hasAttachments: boolean;
  inChannel: boolean;
  /** The SAME entries the shell's submit routes against (`runCoreSubmit`'s
   *  `agentEntries`), so the hint and the behaviour agree by construction — and
   *  no second fetch of the agent list. Absent ⇒ no hint. */
  entries: readonly AgentMentionEntry[] | undefined;
}): JSX.Element | null {
  const { t } = useTranslation('chat');
  if (inChannel || !entries || entries.length === 0) return null;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('/') || /(^|\s)\/[a-z0-9]/i.test(trimmed) || text.includes('@@')) return null;
  const match = detectAgentMention(text, entries);
  if (!match) return null;
  const name = match.entry.displayName;
  return (
    <p className={`agent-handoff-hint${hasAttachments ? ' is-warn' : ''}`}>
      {hasAttachments ? t('handoffIgnoredWithFiles', { name }) : t('handoffHint', { name })}
    </p>
  );
}
