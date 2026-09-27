/**
 * Personal note tile (ADR 0377 Wave-3 deferral closed 2026-07-16) — the
 * Monday-style sticky note. The ONE tile with dashboard-owned content, stored in
 * its own subject-scoped row (`dashboard/note` — deliberately NOT a field on the
 * layout rows, which would race DashboardPage's whole-set debounced PUT).
 * Plain text only, rendered as a text node (no markup surface); saved debounced
 * with a quiet saved-tick. Caller-scoped.
 */
import { toast } from '../../../ui/toast.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getNote, putNote } from '../dashboardClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import type { DashboardTileProps } from '../tileTypes.js';

const SAVE_DEBOUNCE_MS = 800;
const MAX_CHARS = 4000; // mirrors the backend cap

export default function PersonalNoteTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [text, setText] = useState<string | null>(null); // null = loading
  /** The READ failed — there is nothing to edit, so the tile says so. */
  const [error, setError] = useState(false);
  /**
   * A SAVE failed. Deliberately NOT the same flag: the first cut reused
   * `error`, and because `error` swaps the whole tile for a one-line message,
   * a failed save REPLACED the textarea and took the user's unsaved text off
   * screen with no way back. Losing sight of unsaved work is worse than the
   * silence this fix set out to remove.
   */
  const [saveFailed, setSaveFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null); // text awaiting the debounced save
  // `t` is language-bound at capture (react-i18next getFixedT), so a []-dep
  // cleanup would toast in whatever language was active at FIRST MOUNT — the app
  // has an in-app language switcher. Keep a live handle instead of widening the
  // deps, which would re-arm the flush on every language change.
  const tRef = useRef(t);
  tRef.current = t;
  /**
   * Monotonic save sequence. Without it, a SLOW SUCCESS settling after a FAST
   * FAILURE clears the failure and reports "Saved" for an edit the server never
   * took — the exact lie this file exists to remove, wearing a green affirmative
   * (grade-code WRITE-1). Only the newest save may write the status.
   */
  const seqRef = useRef(0);

  useEffect(() => {
    let live = true;
    getNote()
      .then((n) => { if (live) setText(n?.text ?? ''); })
      .catch(() => { if (live) { setText(''); setError(true); } });
    return () => { live = false; };
  }, []);
  // Flush on unmount — a pending edit must never be dropped by quick navigation
  // (grade-code HOME-C1).
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    // The tile is unmounting, but <Toaster/> lives at the app shell
    // (App.tsx), so this still reaches the user — the flush is not the
    // special case it looks like.
    if (pending.current !== null) {
      // A DIFFERENT message: on this path the tile is gone, nothing caches the
      // text locally (dashboardClient PUTs straight through), so "your text is
      // still here / try again" would be false and unactionable. Say what is
      // true — the edit did not land.
      void putNote(pending.current).catch(() => toast.error(tRef.current('noteSaveFailedOnLeave')));
    }
  }, []);

  const onChange = (next: string): void => {
    setText(next);
    setSaved(false);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      const seq = (seqRef.current += 1);
      void putNote(next)
        .then(() => { if (seq !== seqRef.current) return; setSaved(true); setSaveFailed(false); })
        .catch(() => {
          if (seq !== seqRef.current) return; // superseded — a newer save owns the status
          // One notice per failure EPISODE (typing re-fires the debounce), and
          // the guard lives in a REF, not inside the updater: React double-
          // invokes updaters under StrictMode, so a toast in there fires TWICE.
          // The repo states that rule in three places; /code-review proved this
          // instance. DashboardPage already used a ref — same shape here.
          // Inline only. The status line below is a long-mounted region whose
          // text change announces politely on its own; adding an assertive
          // toast made one failure speak twice (grade-ux DASHW-14).
          setSaved(false);
          setSaveFailed(true);
        });
    }, SAVE_DEBOUNCE_MS);
  };

  if (text === null) return <SkeletonRows rows={compact ? 3 : 5} columns={['90%']} />;
  if (error) return <p className="dash-tile__state muted">{t('tileError')}</p>;

  return (
    <div className="dash-tile__note">
      <textarea
        className="dash-tile__note-input"
        value={text}
        maxLength={MAX_CHARS}
        rows={compact ? 4 : 8}
        placeholder={t('notePlaceholder')}
        aria-label={t('tileNote')}
        onChange={(e) => onChange(e.target.value)}
      />
      {/* The textarea above STAYS MOUNTED on a save failure — the first cut
          reused the read-error flag, which swaps the whole tile for a one-line
          message and would have taken the user's unsaved text off screen. */}
      {/* role stays "status" — it does NOT flip to "alert". The toast node is
          already role="alert", and toast.tsx's own docblock names a container
          region plus a per-item alert as the DS-8 double-announce. A mounted
          region's content change announces politely on its own; swapping the
          role of a long-lived element buys nothing the spec guarantees. */}
      <span
        className={saveFailed ? 'dash-tile__note-status u-text-danger' : 'dash-tile__note-status muted'}
        role="status"
      >
        {saveFailed ? t('noteSaveFailedInline') : saved ? t('noteSaved') : ' '}
      </span>
    </div>
  );
}
