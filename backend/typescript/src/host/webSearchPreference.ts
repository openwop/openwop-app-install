/**
 * Resolve whether provider-native web-search/grounding is ON for a single turn
 * (ADR 0101). A per-exchange override (the `webSearch` field on the exchange
 * request / agent-tool-turn params) BEATS the run-input open-time default
 * (`run.inputs.webSearch`). When no override is present, the run-input default
 * applies (only the strict boolean `true` enables it — any other shape is off).
 *
 * Extracted to ONE pure helper so the single-completion reply path
 * (`conversationExchange`) and the agent tool loop (`conversationToolLoop`) can't
 * drift on precedence (WSRCH-4 testability + WSRCH-7 de-duplication).
 */
export function resolveWebSearchPreference(override: boolean | undefined, runInputWebSearch: unknown): boolean {
  return override ?? (runInputWebSearch === true);
}
