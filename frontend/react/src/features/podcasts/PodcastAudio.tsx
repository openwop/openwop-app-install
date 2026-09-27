/**
 * R2 SP-6 (UX_UPGRADE-podcasts) — the feature's ONE audio element.
 *
 * A native `<audio>` whose load failure was SILENT at all four render sites:
 * an expired/cross-tenant media ref left a dead player and told the listener
 * nothing. This wrapper adds the missing `onError` witness — a visible,
 * announced notice under the player — and resets it when the source changes
 * (the Studio clip player advances `src` clip by clip).
 */
import { useEffect, useState, type Ref, type AudioHTMLAttributes, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';

export function PodcastAudio({ audioRef, onError, src, ...rest }: AudioHTMLAttributes<HTMLAudioElement> & {
  audioRef?: Ref<HTMLAudioElement>;
}): JSX.Element {
  const { t } = useTranslation('podcasts');
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  return (
    <div className="u-grid u-gap-1">
      <audio
        ref={audioRef}
        src={src}
        {...rest}
        onError={(e: SyntheticEvent<HTMLAudioElement>) => { setFailed(true); onError?.(e); }}
      />
      {failed ? <Notice variant="warning" announce={t('audioLoadFailed')}>{t('audioLoadFailed')}</Notice> : null}
    </div>
  );
}
