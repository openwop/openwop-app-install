/**
 * Copy text, and tell the user the truth about whether it worked.
 *
 * The app had 31 `writeText` call sites and no shared helper, so the same two
 * silent-failure shapes had been written independently in ten files:
 *
 *   navigator.clipboard?.writeText(text)          // ← (1)
 *     .then(() => toast.success(msg))
 *     .catch(() => { /* clipboard blocked *\/ });  // ← (2)
 *
 * (1) Optional chaining short-circuits the WHOLE chain, not just the call. When
 *     `navigator.clipboard` is undefined — any non-secure context, which
 *     includes plain HTTP and some embedded webviews — the expression evaluates
 *     to `undefined` and `.then`/`.catch` never run. No throw, no toast, no
 *     error. Verified against the runtime rather than assumed.
 *
 * (2) An empty catch swallows a REJECTED write (permission denied, focus lost).
 *
 * Both land the user in the same place: they press Copy, nothing whatsoever
 * happens, and they paste something stale believing it is the command they
 * asked for. On a page whose entire job is handing out shell commands, that is
 * not a missing nicety — it is the app lying about an action it did not do.
 *
 * So this never resolves "copied" unless the write actually resolved, and it
 * always says something when it did not. `document.execCommand('copy')` is
 * deliberately NOT used as a fallback: it is deprecated, requires a live
 * selection, and would reintroduce the same "looks like it worked" ambiguity.
 * Telling the user to copy manually is honest; a fallback that silently might
 * not have worked is not.
 */
import i18n from '../i18n/index.js';
import { toast } from './toast.js';

export interface CopyResult {
  ok: boolean;
  /** Why it failed — 'unavailable' when there is no clipboard API at all. */
  reason?: 'unavailable' | 'rejected';
}

/**
 * Copy `text`, reporting the outcome via toast.
 *
 * Returns the outcome too, so a caller that wants richer UI (inline notice,
 * revealing a select-and-copy fallback) can react without re-deriving it.
 */
/**
 * `successMessage: null` suppresses the success toast — for callers that already
 * show their own "Copied ✓" affordance inline (chat code blocks, the blog share
 * button). **Failure is never suppressible.** That asymmetry is the whole point:
 * a caller can own how success looks, but "it didn't copy" must always reach the
 * user, because the alternative is the silence this helper exists to remove.
 */
export async function copyToClipboard(
  text: string,
  successMessage?: string | null,
): Promise<CopyResult> {
  const ok = successMessage === null ? null : (successMessage ?? i18n.t('chrome:cliCommandCopied'));
  const failed = i18n.t('chrome:copyFailedManual');

  const clip = navigator.clipboard;
  if (!clip?.writeText) {
    toast.error(failed);
    return { ok: false, reason: 'unavailable' };
  }

  try {
    await clip.writeText(text);
    if (ok !== null) toast.success(ok);
    return { ok: true };
  } catch {
    // Deliberately not surfacing the raw DOMException — it is untranslated and
    // says nothing a user can act on. The actionable part is "copy it yourself".
    toast.error(failed);
    return { ok: false, reason: 'rejected' };
  }
}
