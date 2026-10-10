/**
 * Ask tile (ADR 0844) — the dashboard's front door into the ONE chat.
 *
 * Not a chat of its own (CLAUDE.md "AI chat — reuse, never recreate"): it
 * stages the text with the ADR 0334 composer seed and navigates to `/chat`,
 * where the real composer picks it up as an editable draft. Nothing is sent
 * from here, so a mistyped prompt costs nothing. ZERO data calls.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { stageComposerDraft } from '../../../chat/composerSeed.js';
import { Button } from '../../../ui/Button.js';
import { ArrowRightIcon } from '../../../ui/icons/index.js';
import type { DashboardTileProps } from '../tileTypes.js';

const SUGGESTIONS = ['askSuggestChanged', 'askSuggestAutomate', 'askSuggestFailed'] as const;

export default function AskTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const navigate = useNavigate();
  const [text, setText] = useState('');

  const open = (prompt: string): void => {
    const draft = prompt.trim();
    if (draft) stageComposerDraft(draft);
    navigate('/chat');
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    open(text);
  };

  return (
    <div className="dash-ask">
      <form className="dash-ask__form" onSubmit={submit} role="search" aria-label={t('askLabel')}>
        <label htmlFor="dash-ask-input" className="sr-only">{t('askLabel')}</label>
        <input
          id="dash-ask-input"
          className="dash-ask__input"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('askPlaceholder')}
          autoComplete="off"
        />
        <Button type="submit" variant="accent-solid" className="dash-ask__send" aria-label={t('askSend')} title={t('askSend')}>
          <ArrowRightIcon size={18} aria-hidden />
        </Button>
      </form>
      <div className="dash-ask__foot">
        {SUGGESTIONS.map((key) => (
          <Button key={key} variant="quiet" size="sm" className="dash-ask__chip" onClick={() => open(t(key))}>
            {t(key)}
          </Button>
        ))}
        <Link to="/builder" className="btn-ghost btn-sm dash-ask__chip">{t('askBrowseWorkflows')}</Link>
        <span className="dash-ask__hint muted">{t('askHint')}</span>
      </div>
    </div>
  );
}
