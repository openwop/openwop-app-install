/**
 * ADR 1001 D7 (P2), ADR 1006 — `openwop:ask-user` in a CHAT conversation: the
 * agent ends its turn with structured questions instead of burying an ask in
 * prose.
 *
 * Pack-allowlisted, never in the ADR 0315 default-on baseline. It acts only
 * through the turn's `onClarificationAsk` sink, which only the conversation
 * transport supplies and only while the tenant's chat toggle is on, so on
 * voice or with the toggle off it refuses. On the run lane the tool loop
 * handles the call itself (`runChatToolLoop`), because a run's tool results are
 * served from the replay log and an ask must come from the recorded model round.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { ASK_USER_TOOL, askUserContract, liftClarification } from '../../host/clarificationLift.js';
import { renderAskText } from '../../host/clarificationChat.js';

export function registerAskUserTool(): void {
  registerFeatureAgentTool({
    // TRUSTED: the result is a host-authored acknowledgement; the questions it
    // carries are the model's OWN input, echoed nowhere else.
    contentTrust: 'trusted',
    effect: 'read',
    def: { name: ASK_USER_TOOL, ...askUserContract() },
    async run(input, scope) {
      if (!scope.onClarificationAsk) {
        return { content: JSON.stringify({ ok: false, error: 'chat_ask_unavailable', message: 'This tool only works in a chat conversation.' }), isError: true };
      }
      const lifted = liftClarification(input);
      if (!lifted.ok) {
        return { content: JSON.stringify({ ok: false, error: 'ask_invalid', message: lifted.reason }), isError: true };
      }
      const recorded = scope.onClarificationAsk.record({ questions: lifted.questions, data: lifted.data, resumeSchema: lifted.resumeSchema });
      if (recorded === 'already_asked') {
        return { content: JSON.stringify({ ok: false, error: 'already_asked', message: 'You already asked this turn.' }), isError: true };
      }
      return { content: JSON.stringify({ ok: true, asked: lifted.questions.length }), endTurn: { text: renderAskText(lifted.questions) } };
    },
  });
}
