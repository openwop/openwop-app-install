/**
 * Small shared UI helpers used by the CRM console surfaces — split out of
 * CrmPage.tsx alongside the CRMGAP-FE-10 tab extraction so each tab file can
 * import them without re-declaring them.
 */
import i18n from '../../i18n/index.js';
import { toast } from '../../ui/toast.js';
import { CrmRequestError } from './crmRequestError.js';

/**
 * CRM-UX-14 — the ONE place a failed CRM write turns into words.
 *
 * Before this, 44 write-path catches did `e instanceof Error ? e.message :
 * t('…Failed')`: the branch that fired in practice was the FIRST one, so the
 * user was handed the transport's own string — `deleteContact returned 403`,
 * or whatever English the server put in `message` — and `toast.error` now
 * announces it assertively, in every locale the app ships. The
 * `PipelinesPage` 409 translation showed the shape that works: the STATUS is
 * a fact the UI can name in the user's language; the wire string is for the
 * developer, so it goes to `console.warn` and nowhere else.
 *
 * Returns a localized sentence: a status-specific one when the status carries
 * meaning to the user (400 / 403 / 404 / 409 / 413 / 422 / 429 / 5xx), else
 * the caller's own fallback (`addFailed`, `deleteFailed`, …). Never the
 * server's prose.
 */
export function crmActionError(e: unknown, fallbackKey: string): string {
  if (e instanceof Error) {
    // The developer still gets the wire truth; the user never does.
    console.warn('[crm] action failed:', e.message);
  }
  return crmActionReason(e) ?? i18n.t(`crm:${fallbackKey}`);
}

/** The status-mapped sentence, or `null` when the status says nothing a user
 *  can act on (a network drop, a 401 the auth layer already owns, an unknown
 *  non-transport error). Exported for `revertedErr`, which prefixes it. */
export function crmActionReason(e: unknown): string | null {
  if (!(e instanceof CrmRequestError)) return null;
  const s = e.status;
  if (s === 400) return i18n.t('crm:httpBadRequest');
  if (s === 403) return i18n.t('crm:httpForbidden');
  if (s === 404) return i18n.t('crm:httpNotFound');
  if (s === 409) return i18n.t('crm:httpConflict');
  if (s === 413) return i18n.t('crm:httpTooLarge');
  if (s === 422) return i18n.t('crm:httpUnprocessable');
  if (s === 429) return i18n.t('crm:httpTooMany');
  if (s >= 500 && s <= 599) return i18n.t('crm:httpServerError');
  return null;
}

/** Surface a failed inline mutation (delete / stage-move / status-change) — the
 *  fetch clients throw on a non-ok response (code-review #3/#4). */
export const crudErr = (e: unknown): void => { toast.error(crmActionError(e, 'actionFailed')); };

/** Surface a failed OPTIMISTIC field change (useOptimisticField already snapped
 *  the local pick back before this fires) — plain crudErr reads as "did it save?"
 *  when the UI already silently reverted (UX audit finding #11). Leads with the
 *  status-mapped reason when there is one, and always ends on the reverted fact. */
export const revertedErr = (e: unknown): void => {
  if (e instanceof Error) console.warn('[crm] optimistic change reverted:', e.message);
  const reason = crmActionReason(e);
  toast.error(reason ? `${reason} — ${i18n.t('crm:changeReverted')}` : i18n.t('crm:changeReverted'));
};

/**
 * CRM-UX-16 — after a destructive action unmounts the control that held
 * focus, move it to the first target that exists. A row delete removes its
 * own Delete button, so without this the browser drops focus to `<body>` and
 * a keyboard / screen-reader user is left with no position and no
 * announcement of where they are.
 *
 * Call it from an effect that runs AFTER the reload has committed, never
 * synchronously before `load()`: the delete can change what is mounted (the
 * last row swaps the table for its empty slot and unmounts the caption; the
 * fourth-to-last contact unmounts the gated search), so a target focused
 * before the re-render is one the re-render can take away. The chain must
 * end on something that is mounted in EVERY state of the surface.
 */
export function focusFirst(...targets: ReadonlyArray<HTMLElement | null | undefined>): void {
  for (const el of targets) {
    if (el) { el.focus(); return; }
  }
}

/**
 * CRM-UX-15 — the create form is `noValidate` (so its field-attached errors
 * are reachable), which also switches off the browser's `type="email"` check.
 * This is that check, in the same loose shape the HTML spec uses: something,
 * an `@`, something with a dot — enough to catch a name typed into the email
 * box, without refusing an address the server would accept.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
