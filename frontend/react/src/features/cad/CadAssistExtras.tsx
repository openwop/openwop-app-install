/**
 * The cad type's ToolbarExtras slot (ADR 0515) — the chassis's existing
 * per-type extension point ("self-gates and owns its own modals/i18n",
 * canvas/types.ts). A toggle button + the assist drawer; gated on the `cad`
 * feature toggle, matching the CAD Modeler tools' own per-call re-check.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolbarExtrasProps } from '../../canvas/types.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Button } from '../../ui/Button.js';
import { SparklesIcon } from '../../ui/icons/index.js';
import { CadAssistPanel } from './CadAssistPanel.js';

export function CadAssistExtras({ canvasId }: ToolbarExtrasProps): JSX.Element | null {
  const { t } = useTranslation('cad');
  const cad = useFeatureAccess('cad');
  const [open, setOpen] = useState(false);
  if (!cad.enabled) return null;
  return (
    <>
      <Button variant="quiet" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SparklesIcon size={13} /> {t('assistOpen')}
      </Button>
      {open ? <CadAssistPanel canvasId={canvasId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
