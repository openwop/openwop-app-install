/**
 * ADR 0151 Phase 1 — the LLM title generator. `sanitizeTitle` is PURE + unit-tested
 * (OQ-5: a misbehaving free model degrades to the placeholder, never worse);
 * `generateTitle` wraps it around a managed-provider dispatch (host-side key, never
 * on the wire), mirroring `memory-auto-extract/memoryExtractor.ts`.
 *
 * Method `completion` (plain text out), NOT structured/tool-calling — the free
 * MiniMax tier's tool output is unreliable (the code-exec saga, ADR 0146) and a
 * title needs no schema.
 *
 * @see docs/adr/0151-conversation-auto-titling.md
 */
import { dispatchManagedChat } from '../../providers/managedProvider.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.chat-autotitle');
const MANAGED_PROVIDER = 'openwop-free';

/** ATC-2 — a FEATURE-OWNED wall-clock bound on the fire-and-forget title dispatch.
 *  Passing no signal did NOT hang forever: `dispatchChat` applies a coarse default
 *  floor (`AbortSignal.timeout`, `OPENWOP_PROVIDER_DISPATCH_TIMEOUT_MS`, default
 *  120s) to an unguarded caller. But 120s is far too long for a detached,
 *  best-effort background title, and a title timeout was indistinguishable from any
 *  other provider error in the log. This passes our OWN signal — which the dispatch
 *  layer then leaves untouched, so 15s REPLACES the 120s floor — and the catch
 *  labels the abort (`timedOut`) so the "silently never lands" mode is legible.
 *  Mirrors the chat-responder bound (`nodes.ts` MANAGED_CHAT_TIMEOUT_MS) but is
 *  tighter (background work, not an interactive turn). Override per-deploy via
 *  `OPENWOP_AUTOTITLE_TIMEOUT_MS`; `let` (not `const`) so the `_setTitleTimeoutMs`
 *  test affordance can shrink it for a fast, deterministic witness. */
let TITLE_TIMEOUT_MS = (() => {
  const n = Number(process.env.OPENWOP_AUTOTITLE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

/** TEST-ONLY — override the title dispatch timeout so a witness need not wait the
 *  full production window. Mirrors `_setManagedChatTimeoutMs` in `nodes.ts`. */
export function _setTitleTimeoutMs(ms: number): void {
  TITLE_TIMEOUT_MS = ms;
}
/** Per the data model (≈ ≤ 30 output tokens/chat); headroom for multi-byte scripts. */
const MAX_OUTPUT_TOKENS = 24;
const MAX_INPUT_CHARS = 1000;
/** Hard display cap (OQ-5) — matches the FE substring placeholder length band. */
const MAX_TITLE_CHARS = 60;

/** LibreChat-derived default, localized BY the model (it titles in the conversation's
 *  own language, so no app-string leakage / no i18n key for the title text). */
const TITLE_PROMPT =
  "Detect the conversation's language and return a concise title in THAT language — " +
  'five words or fewer, no punctuation, no quotation marks, no preamble. Output only the title.';

/** Clean the model's raw output into a safe display title, or `null` to fall back to
 *  the placeholder. PURE + deterministic. Strips wrapping quotes, a leading "Title:"
 *  preamble, collapses whitespace/newlines, drops empty/sentinel garbage, hard-caps
 *  the length (on a word boundary where possible). */
export function sanitizeTitle(raw: string): string | null {
  let t = (raw ?? '').replace(/\r?\n/g, ' ').trim();
  if (!t) return null;
  // Drop a leading "Title:" / "Title -" preamble a chatty model may prepend.
  t = t.replace(/^\s*title\s*[:\-—]\s*/i, '').trim();
  // Strip a single layer of wrapping quotes (straight or smart) / backticks.
  t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
  // Collapse internal whitespace runs.
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length < 2) return null;
  if (/^(none|n\/?a|untitled|new chat|conversation)\.?$/i.test(t)) return null;
  if (t.length > MAX_TITLE_CHARS) {
    const clipped = t.slice(0, MAX_TITLE_CHARS);
    const lastSpace = clipped.lastIndexOf(' ');
    t = (lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trim();
  }
  return t || null;
}

/** Managed-LLM title from the first exchange. The key is resolved host-side; the
 *  transcript is capped. Returns `null` on any provider error or unusable output —
 *  titling is best-effort, never blocks the turn, and degrades to the placeholder. */
export async function generateTitle(
  tenantId: string,
  userText: string,
  replyText: string,
): Promise<string | null> {
  const transcript = `User: ${userText}\nAI: ${replyText}`.slice(0, MAX_INPUT_CHARS);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS);
  try {
    const r = await dispatchManagedChat({
      userFacingProvider: MANAGED_PROVIDER,
      tenantId,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: transcript },
      ],
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: abort.signal,
    });
    return sanitizeTitle(r.completion ?? '');
  } catch (err) {
    // Fail-soft (no title), but surface the failure (provider error only — no PII).
    // Distinguish a wall-clock abort so the "silently never lands" mode is legible.
    const timedOut = abort.signal.aborted;
    log.warn('autotitle_generate_failed', {
      error: err instanceof Error ? err.message : String(err),
      ...(timedOut ? { timedOut: true, timeoutMs: TITLE_TIMEOUT_MS } : {}),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
