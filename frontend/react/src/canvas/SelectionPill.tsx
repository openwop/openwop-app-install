/**
 * SelectionPill — §7.4 / CV-7: the near-selection floating toolbar (the
 * Canva/Miro/FigJam pattern). Spatially-local verbs ONLY — duplicate, lock,
 * group/ungroup, delete; formatting never lives here (canon 4 — it morphs
 * the top bar). The SURFACE anchors it above the selection's screen bbox
 * (it owns the geometry); the CHASSIS supplies the verbs (it owns history).
 * Repositions to stay on-viewport: the surface passes a clamped anchor.
 */
import { Button } from '../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { CopyIcon, LockIcon, UnlockIcon, TrashIcon, GroupIcon, UngroupIcon } from '../ui/icons/index.js';
import type { ElementActions } from './types.js';

export function SelectionPill({ actions, style, className }: {
  actions: ElementActions;
  /** Surface-computed anchor (absolute within the surface wrapper) — omit
   *  when a wrapper anchors the pill instead (pass `className="u-static"`). */
  style?: React.CSSProperties;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation('canvas');
  return (
    <div className={className ? `cv-selection-pill ${className}` : 'cv-selection-pill'} role="toolbar" aria-label={t('selectionPill')} {...(style ? { style } : {})}>
      {actions.duplicate ? (
        <Button variant="quiet" size="sm" onClick={actions.duplicate} title={t('shortcutDuplicate')} aria-label={t('shortcutDuplicate')}>
          <CopyIcon size={13} aria-hidden />
        </Button>
      ) : null}
      <Button variant="quiet" size="sm" onClick={actions.toggleLock} title={t(actions.locked ? 'unlockElement' : 'lockElement')} aria-label={t(actions.locked ? 'unlockElement' : 'lockElement')} aria-pressed={actions.locked}>
        {actions.locked ? <UnlockIcon size={13} aria-hidden /> : <LockIcon size={13} aria-hidden />}
      </Button>
      {actions.group ? (
        <Button variant="quiet" size="sm" onClick={actions.group} title={t('groupSelection')} aria-label={t('groupSelection')}>
          <GroupIcon size={13} aria-hidden />
        </Button>
      ) : null}
      {actions.ungroup ? (
        <Button variant="quiet" size="sm" onClick={actions.ungroup} title={t('ungroupSelection')} aria-label={t('ungroupSelection')}>
          <UngroupIcon size={13} aria-hidden />
        </Button>
      ) : null}
      <Button variant="quiet" size="sm" className="cv-selection-pill__danger" onClick={actions.remove} title={t('shortcutDelete')} aria-label={t('shortcutDelete')}>
        <TrashIcon size={13} aria-hidden />
      </Button>
    </div>
  );
}
