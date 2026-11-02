/**
 * ADR 0363 P4 — the Sidebar footer's accessibility-preferences button (beside
 * ThemeToggle/LanguageSwitcher). The button is on the entry path; the form it
 * opens (`ui/A11yPrefsControl`'s `A11yPrefsFields`) loads when the modal first
 * opens, which keeps it out of the entry chunk.
 */
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../ui/IconButton.js';
import { Modal } from '../ui/Modal.js';
import { EyeIcon } from '../ui/icons/index.js';

const A11yPrefsFields = lazy(() => import('../ui/A11yPrefsControl.js').then((m) => ({ default: m.A11yPrefsFields })));

export function A11yPrefsButton(): JSX.Element {
  const { t } = useTranslation('a11y');
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label={t('prefsButton')} icon={<EyeIcon />} className="btn-ghost" onClick={() => setOpen(true)} />
      {open ? (
        <Modal onClose={() => setOpen(false)} label={t('prefsTitle')} showClose>
          <Suspense fallback={null}>
            <A11yPrefsFields />
          </Suspense>
        </Modal>
      ) : null}
    </>
  );
}
