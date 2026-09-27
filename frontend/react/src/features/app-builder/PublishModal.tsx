/**
 * GitHub publish modal (ADR 0306 / ADR 0305 Phase G). Collects the repo name,
 * visibility, and framework target, then calls the governed publish route — the
 * PAT never reaches the browser; a missing connection surfaces the route's
 * actionable 424 message. Create-only pushes: per-file skips come back as
 * warnings and are surfaced, never silent.
 */
import { Button } from '../../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { Notice } from '../../ui/index.js';
import { toast } from '../../ui/toast.js';
import { publishCanvas, EXPORT_TARGETS, type ExportTarget } from './canvasEditorClient.js';

const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function PublishModal({ orgId, canvasId, defaultName, onClose }: {
  orgId: string;
  canvasId: string;
  defaultName: string;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('app-builder');
  const [repo, setRepo] = useState(defaultName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100));
  const [isPrivate, setIsPrivate] = useState(true);
  const [target, setTarget] = useState<ExportTarget>('react-tailwind');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const valid = REPO_RE.test(repo);

  const onSubmit = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true); setError(null); setWarnings([]);
    try {
      const res = await publishCanvas(orgId, canvasId, { target, repo, private: isPrivate });
      if (res.partial) toast.warning(t('publishPartial', { n: res.filesPushed, url: res.repoUrl }));
      else toast.success(t(res.repo === 'reused' ? 'publishSuccessReused' : 'publishSuccess', { url: res.repoUrl, n: res.filesPushed }));
      if (res.warnings.length) setWarnings(res.warnings);
      else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('publishFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={t('publishTitle')} showClose>
      <h2 className="cv-editor__panel-title">{t('publishTitle')}</h2>
      <p className="cv-editor__empty">{t('publishHint')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {warnings.length ? <Notice variant="warning">{warnings.join(' ')}</Notice> : null}
      <form className="cv-editor__prop-form" onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}>
        <div className="cv-editor__field">
          <label htmlFor="pub-repo" className="cv-editor__field-label">{t('publishRepoLabel')}</label>
          <input id="pub-repo" type="text" className="cv-editor__input" value={repo} aria-invalid={!valid && repo.length > 0} aria-describedby="pub-repo-err" onChange={(e) => setRepo(e.target.value)} />
          {/* Grade pass UX F6: associated, announced, and error-TONED (was a muted eyebrow). */}
          <span id="pub-repo-err" role="alert" className="cv-editor__field-error">{!valid && repo ? t('publishRepoInvalid') : ''}</span>
        </div>
        <div className="cv-editor__field">
          <label htmlFor="pub-target" className="cv-editor__field-label">{t('exportTarget')}</label>
          <select id="pub-target" className="cv-editor__input" value={target} onChange={(e) => setTarget(e.target.value as ExportTarget)}>
            {EXPORT_TARGETS.map((tg) => <option key={tg} value={tg}>{t(`target_${tg}`)}</option>)}
          </select>
        </div>
        <label className="cv-editor__field-label">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> {t('publishPrivate')}
        </label>
        <span className="action-bar">
          <Button type="submit" variant="primary" size="sm" disabled={busy || !valid}>
            {busy ? t('publishing') : t('publishSubmit')}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>{t('publishClose')}</Button>
        </span>
      </form>
    </Modal>
  );
}
