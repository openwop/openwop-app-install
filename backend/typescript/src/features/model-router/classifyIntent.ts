/**
 * ADR 0130 Phase 4b — the turn-intent classifier that produces `features.intent`
 * for the Phase-4a `intentIs` routing rule. `parseIntentLabel` is PURE + unit-tested
 * (a tiny vocabulary, robust to chatty model output); `classifyTurnIntent` wraps it
 * around a cheap managed dispatch (host-side key). Kept separate from `routeTurn` so
 * the selector stays pure — the classification is a FEATURE computed before routing.
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import { dispatchManagedChat } from '../../providers/managedProvider.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.model-router');
const MANAGED_PROVIDER = 'openwop-free';
/** The closed intent vocabulary an `intentIs` rule can match. */
export const INTENTS = ['code', 'math', 'vision', 'writing', 'research', 'chat'] as const;
export type Intent = (typeof INTENTS)[number];

const PROMPT =
  'Classify the user message into EXACTLY ONE of these intents: ' + INTENTS.join(', ') +
  '. Reply with ONLY the single lowercase word, nothing else. If unsure, reply "chat".';

/** Extract a known intent from (possibly chatty) model output. Defaults to 'chat'
 *  when no known label appears. Pure + deterministic. */
export function parseIntentLabel(raw: string): Intent {
  const text = (raw ?? '').toLowerCase();
  // Prefer an exact single-word reply; else the first known label that appears.
  const trimmed = text.trim();
  if ((INTENTS as readonly string[]).includes(trimmed)) return trimmed as Intent;
  for (const intent of INTENTS) {
    if (new RegExp(`\\b${intent}\\b`).test(text)) return intent;
  }
  return 'chat';
}

export async function classifyTurnIntent(tenantId: string, userMessage: string): Promise<Intent> {
  try {
    const r = await dispatchManagedChat({
      userFacingProvider: MANAGED_PROVIDER,
      tenantId,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: userMessage.slice(0, 4000) },
      ],
      maxTokens: 8,
    });
    return parseIntentLabel(r.completion ?? '');
  } catch (err) {
    // CONV-2: best-effort — a classify failure must not block routing, but surface it.
    log.warn('intent_classify_failed', { error: err instanceof Error ? err.message : String(err) });
    return 'chat';
  }
}
