/**
 * The `?` keyboard-shortcut cheatsheet (ADR 0333 Phase 2) — generated from the
 * live registry, grouped, localized. Excalidraw's `?` overlay / Figma's
 * shortcut panel are the conventions (research doc §1.12); ours renders through
 * the shared ui/Modal (scrim + Escape + focus trap for free).
 */
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { comboLabel, type ShortcutDef } from './shortcuts.js';

const GROUP_ORDER: ShortcutDef['group'][] = ['general', 'arrange', 'view', 'type'];

export function ShortcutsOverlay({
  shortcuts,
  typeT,
  onClose,
}: {
  shortcuts: readonly ShortcutDef[];
  /** The TYPE-namespace t for `group: 'type'` entries; chassis groups use the
   *  canvas ns. */
  typeT: (k: string) => string;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('canvas');
  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
  const groups = GROUP_ORDER
    .map((g) => ({ g, items: shortcuts.filter((s) => s.group === g) }))
    .filter(({ items }) => items.length > 0);
  return (
    <Modal onClose={onClose} label={t('shortcutsTitle')} className="surface-card cv-shortcuts" showClose>
      <h2 className="cv-shortcuts__title">{t('shortcutsTitle')}</h2>
      {groups.map(({ g, items }) => (
        <section key={g} className="cv-shortcuts__group">
          <h3 className="cv-shortcuts__group-title">{t(`shortcutGroup_${g}`)}</h3>
          <dl className="cv-shortcuts__list">
            {items.map((s) => (
              <div key={`${s.combo}:${s.labelKey}`} className="cv-shortcuts__row">
                <dt className="cv-shortcuts__label">{s.group === 'type' ? typeT(s.labelKey) : t(s.labelKey)}</dt>
                <dd className="cv-shortcuts__keys"><kbd>{comboLabel(s.combo, isMac)}</kbd></dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Modal>
  );
}
