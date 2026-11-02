/**
 * ADR 1001 D7 — answer an agent's chat question card. The answer is the NEXT
 * exchange, so this is an ordinary send carrying `clarificationAnswer`: it
 * skips the composer's command and mention parsing (the turn is the person's
 * answers, not something they typed) and the host addresses it to the agent
 * that asked. One hook so every surface that renders the card sends the same.
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';
import { clarificationAnswerSummary } from '../../interrupts/clarificationModel.js';
import type { SendOptions } from '../types.js';

export function useClarificationAnswer(input: {
  send: (text: string, config: BYOKActiveConfig, opts?: SendOptions) => Promise<void>;
  config: BYOKActiveConfig;
  baseSendOptions?: () => SendOptions;
}): (askId: string, data: unknown, answers: unknown) => Promise<void> {
  const { send, config, baseSendOptions } = input;
  const { t } = useTranslation('chat');
  return useCallback(async (askId, data, answers) => {
    const text = clarificationAnswerSummary(data, answers, t('clarifySkippedTurn'));
    await send(text, config, { ...(baseSendOptions ? baseSendOptions() : {}), clarificationAnswer: { askId, answers } });
  }, [send, config, baseSendOptions, t]);
}
