/**
 * Autosave-refused banner (ADR 0434 Phase 1).
 *
 * The builder autosaves to localStorage synchronously and write-throughs to the
 * backend on a 1.5s debounce. That backend write used to swallow every failure,
 * so a 401 (session expired) or 429 (the documented per-IP fan-out hazard) left
 * the workflow in THIS browser only while the canvas looked perfectly saved.
 * Users discovered it on another machine, as missing work.
 *
 * This banner is the honest signal. It appears ONLY when the server actively
 * REFUSED the write — never when offline, where the local cache is genuinely
 * authoritative and the next save reconciles. It is not dismissible: the edit
 * really is unsaved, and hiding that is the bug we are fixing.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBuilderStore, overwriteWithCanvas } from './store/builderStore.js';
import { HEAD_MOVED_REASON, loadWorkflowWithHead } from './persistence/backendStore.js';
import { Notice } from '../ui/Notice.js';
import { Button } from '../ui/Button.js';
import { toast } from '../ui/toast.js';

export function SyncFailureBanner(): JSX.Element | null {
  const { t } = useTranslation('builder');
  const syncState = useBuilderStore((s) => s.syncState);
  const status = useBuilderStore((s) => s.syncFailureStatus);
  const reason = useBuilderStore((s) => s.syncFailureReason);
  const workflowId = useBuilderStore((s) => s.workflowId);
  const [busy, setBusy] = useState(false);

  if (syncState !== 'failed') return null;

  // ADR 0770 D5 — a 409 `workflow_head_moved`: another tab, device or person
  // saved this workflow after it was opened here. The old behaviour was to
  // overwrite their version silently. Nothing is lost either way (this
  // browser's cache holds the canvas), so offer the two honest choices.
  if (status === 409 && reason === HEAD_MOVED_REASON) {
    const reload = async (): Promise<void> => {
      if (!workflowId) return;
      setBusy(true);
      try {
        const { workflow: latest, headRevision } = await loadWorkflowWithHead(workflowId);
        if (latest) {
          useBuilderStore.getState().loadFromSaved(latest);
          useBuilderStore.getState().setBaseRevision(headRevision);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };
    const message = `${t('syncConflictTitle')} ${t('syncConflictBody')}`;
    return (
      <Notice variant="warning" announce={message}>
        <strong>{t('syncConflictTitle')}</strong>
        <p className="u-fs-13 u-mt-4">{t('syncConflictBody')}</p>
        <div className="action-bar u-mt-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => { void reload(); }}>
            {t('syncConflictReload')}
          </Button>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => overwriteWithCanvas()}>
            {t('syncConflictKeepMine')}
          </Button>
        </div>
      </Notice>
    );
  }

  // ADR 0481 (ux-H1 + code-M6) — a 409 `workflow_room_live` is a STATE, not a
  // fault: the workflow saves through a live multiplayer session this browser
  // hasn't joined. The warning register (not error) matches that — nothing is
  // broken, and "Go live" is the cure. Joining resets this to 'pending'
  // (adapter attach), so the banner never contradicts the Live chip.
  if (status === 409 && reason === 'workflow_room_live') {
    // WFMU-1 — this banner mounts ALREADY containing its text, and a `warning`
    // Notice is a `role="status"` (polite) region, which announces only later
    // MUTATIONS — so a screen-reader co-editor was never told their solo edits
    // are staying local (the exact failure this banner exists to surface). Route
    // the text through the imperative `announce` primitive (Notice.tsx) so it is
    // spoken on mount; `announce` also drops the mount-time role, so no double-say.
    return (
      <Notice variant="warning" announce={t('syncCollabRoomLive')}>
        <p className="u-fs-13">{t('syncCollabRoomLive')}</p>
      </Notice>
    );
  }

  // Distinct guidance per cause — "try again" is useless advice for an expired
  // session, and "sign in" is wrong for a rate limit.
  // ADR 0770 D1 — a viewer's save is refused `forbidden_scope`: signing in again
  // would not help, and saying so would send them in a loop.
  const detail =
    status === 403 && reason === 'forbidden_scope' ? t('syncFailedReadOnly')
    : status === 401 || status === 403 ? t('syncFailedAuth')
      : status === 429 ? t('syncFailedRateLimited')
        : t('syncFailedServer');

  // WFMU-1 (same class, sibling branch) — this error banner ALSO mounts already
  // containing its text. `variant="error"` is a `role="alert"` region, and while
  // alert-on-insertion is *widely reported* to announce, Notice.tsx is explicit
  // that this is NOT verified and MUST NOT be assumed (the #2615 mistake). This
  // "your work is not being saved" signal is more urgent than the 409 above, so
  // route it through the imperative `announce` (assertive, since `variant="error"`)
  // rather than trusting the unverified alert behaviour. `announce` drops the
  // container role, so there is no double-announce.
  const message = `${t('syncFailedTitle')} ${detail}`;
  return (
    <Notice variant="error" announce={message}>
      <strong>{t('syncFailedTitle')}</strong>
      <p className="u-fs-13 u-mt-4">{detail}</p>
    </Notice>
  );
}
