/**
 * A looping visual's pause button (WCAG 2.2.2, the ADR 1029 marquee's pattern):
 * shown only on the motion path (CSS), it says what it will do. Hover and
 * keyboard focus inside the figure pause it too (CSS). Shared by the hero art
 * loops (heroArt.tsx) and the ADR 1064 P3c flow rail, so there is one control.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PauseIcon, PlayIcon } from '../../ui/icons/index.js';

export function useLoopToggle(): { paused: boolean; toggle: JSX.Element } {
  const { t } = useTranslation('cms');
  const [paused, setPaused] = useState(false);
  return {
    paused,
    toggle: (
      <Button variant="quiet" size="sm" className="fp-art__toggle" onClick={() => setPaused((p) => !p)}>
        {paused ? <PlayIcon size={14} aria-hidden /> : <PauseIcon size={14} aria-hidden />}
        {paused ? t('artMotionPlay') : t('artMotionPause')}
      </Button>
    ),
  };
}
