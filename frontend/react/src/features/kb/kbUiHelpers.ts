/**
 * Knowledge Base UI helpers — the one place a failed KB write turns into words,
 * plus the post-destructive focus chain.
 *
 * `KBX-4`. Copied in SHAPE (not by import) from `features/crm/crmUiHelpers.ts`,
 * which closed the identical family in `CRM-UX-14`; this is the sixth feature in
 * the 2026-09 loop to carry it (`CSM-UX-3`, `FORM-UX`, …). The rule the shape
 * encodes: **the STATUS is a fact the UI can state in the user's language; the
 * server's prose is for the developer.**
 *
 * The KB adds one status the CRM does not have to explain — `409`, which on this
 * surface has exactly one cause worth naming. `assertNoLiveReindex`
 * (`backend/typescript/src/features/kb/kbService.ts`) is the only writer of a
 * 409 on the collection's document routes, and it fires from `ingestDocument`,
 * `deleteDocument` and `upsertDocument` while a reindex is `running` or
 * `paused`. So `httpConflict` names the reindex and the control that resolves
 * it, rather than the generic "something conflicts" the CRM has to fall back on.
 */
import i18n from '../../i18n/index.js';
import { KbRequestError } from './kbRequestError.js';

/**
 * A localized sentence for a failed KB write: a status-specific one when the
 * status carries meaning to the user, else the caller's own fallback key
 * (`ingestFailed`, `deleteFailed`, …). Never the server's prose.
 */
export function kbActionError(e: unknown, fallbackKey: string): string {
  if (e instanceof Error) {
    // The developer still gets the wire truth; the user never does.
    console.warn('[kb] action failed:', e.message);
  }
  return kbActionReason(e) ?? i18n.t(`kb:${fallbackKey}`);
}

/** The status-mapped sentence, or `null` when the status says nothing the user
 *  can act on (a network drop, a 401 the auth layer already owns, a non-transport
 *  error). Exported so a caller that needs to prefix or suffix it can. */
function kbActionReason(e: unknown): string | null {
  if (!(e instanceof KbRequestError)) return null;
  const s = e.status;
  if (s === 400) return i18n.t('kb:httpBadRequest');
  if (s === 403) return i18n.t('kb:httpForbidden');
  if (s === 404) return i18n.t('kb:httpNotFound');
  if (s === 409) return i18n.t('kb:httpConflict');
  if (s === 413) return i18n.t('kb:httpTooLarge');
  if (s === 422) return i18n.t('kb:httpUnprocessable');
  if (s === 429) return i18n.t('kb:httpTooMany');
  if (s >= 500 && s <= 599) return i18n.t('kb:httpServerError');
  return null;
}

/**
 * `KBX-12` — after a destructive action unmounts the control that held focus,
 * move focus to the first target that still exists.
 *
 * Deleting a document unmounts the row (and with it the Delete button that had
 * focus), so without this the browser drops focus to `<body>`: a keyboard user
 * loses their position and a screen-reader user is told nothing at all. Same for
 * deleting a collection, and for closing the reader (its "Back to documents"
 * button unmounts itself).
 *
 * Call it from an effect that runs AFTER the reload has committed, never
 * synchronously before it: the delete can change what is mounted (the last
 * document swaps the list for the empty StateCard and unmounts the filter; the
 * fourth-to-last unmounts the gated search box), so a target focused before the
 * re-render is one the re-render can take away. Every chain here therefore ends
 * on a node mounted in EVERY state of the surface — a heading with
 * `tabIndex={-1}`.
 */
export function focusFirst(...targets: ReadonlyArray<HTMLElement | null | undefined>): void {
  for (const el of targets) {
    if (el) { el.focus(); return; }
  }
}
