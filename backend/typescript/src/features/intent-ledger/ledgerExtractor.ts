/**
 * ADR 0136 Phase 2 — the complexity gate + the LLM ledger extractor.
 *
 * `parseLedgerDraft` is PURE (defensive — never throws on malformed model output) and
 * intersects the proposed allowed/requireApproval with the agent ceiling so a draft can
 * never propose a tool the agent lacks. `isComplexRequest` is the PURE over-friction
 * guard (simple chats skip the ledger entirely). `llmExtractLedger` wraps the pure parser
 * around a cheap managed dispatch (host-side key), exactly like memoryExtractor.
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import { dispatchManagedChat } from '../../providers/managedProvider.js';

const MANAGED_PROVIDER = 'openwop-free';
const MAX_INPUT_CHARS = 4000;
const COMPLEX_LEN = 240;
const WRITE_HINTS = ['send', 'update', 'create', 'delete', 'write', 'exec', 'post', 'publish', 'pay', 'transfer'];

export interface LedgerDraftFields {
  goal: string;
  allowed: string[];
  forbidden: string[];
  requireApproval: string[];
  successCriteria: string[];
  expiresAtRelMs?: number;
}

const intersectCeiling = (proposed: string[], ceiling: string[]): string[] => {
  if (ceiling.length === 0) return [];
  const ok = (name: string): boolean => ceiling.some((c) => c === name || name === c || name.startsWith(`${c}.`) || c.startsWith(`${name}.`));
  return proposed.filter(ok);
};

/** The over-friction guard: only draft a ledger for a complex/high-risk request — a
 *  long ask, OR an agent whose ceiling includes a write/exec-class tool. Pure. */
export function isComplexRequest(userText: string, ceiling: string[]): boolean {
  if (userText.trim().length >= COMPLEX_LEN) return true;
  return ceiling.some((t) => { const n = t.toLowerCase(); return WRITE_HINTS.some((h) => n.includes(h)); });
}

/** Parse the model's structured proposal into ledger fields, intersected with the
 *  agent ceiling. PURE + defensive: any malformed output yields a safe partial (goal
 *  only) rather than throwing. */
export function parseLedgerDraft(rawLLMText: string, ceiling: string[]): LedgerDraftFields {
  let obj: Record<string, unknown> = {};
  try {
    const start = rawLLMText.indexOf('{');
    const end = rawLLMText.lastIndexOf('}');
    if (start >= 0 && end > start) obj = JSON.parse(rawLLMText.slice(start, end + 1)) as Record<string, unknown>;
  } catch { obj = {}; }
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const expiry = typeof obj.expiresAtRelMs === 'number' && obj.expiresAtRelMs > 0 ? obj.expiresAtRelMs : undefined;
  return {
    goal: typeof obj.goal === 'string' ? obj.goal.trim() : '',
    allowed: intersectCeiling(arr(obj.allowed), ceiling),
    forbidden: arr(obj.forbidden), // forbidden need not be in the ceiling
    requireApproval: intersectCeiling(arr(obj.requireApproval), ceiling),
    successCriteria: arr(obj.successCriteria),
    ...(expiry !== undefined ? { expiresAtRelMs: expiry } : {}),
  };
}

const EXTRACT_PROMPT = [
  'You draft a pre-flight "mission contract" for an AI agent from the user\'s request.',
  'Return ONLY a JSON object with keys: goal (string), allowed (string[] tool ids the mission needs),',
  'forbidden (string[] tool ids it must NOT use), requireApproval (string[] tool ids needing human approval),',
  'successCriteria (string[] observable done-conditions), expiresAtRelMs (number, optional, ms from now).',
  'Pick allowed/requireApproval ONLY from the provided tool list. Be conservative: forbid risky writes the goal does not need.',
].join(' ');

/** Managed-LLM ledger draft. Best-effort; returns a goal-only draft on any provider
 *  error (extraction never blocks the turn). */
export async function llmExtractLedger(tenantId: string, userText: string, ceiling: string[]): Promise<LedgerDraftFields> {
  try {
    const r = await dispatchManagedChat({
      userFacingProvider: MANAGED_PROVIDER,
      tenantId,
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `Available tools: ${ceiling.join(', ') || '(none)'}\n\nRequest:\n${userText.slice(0, MAX_INPUT_CHARS)}` },
      ],
      maxTokens: 600,
    });
    return parseLedgerDraft(r.completion ?? '', ceiling);
  } catch {
    return { goal: '', allowed: [], forbidden: [], requireApproval: [], successCriteria: [] };
  }
}
