/**
 * WorkspaceCreateSection — the "create a workspace" affordance on the
 * Organizations & access page.
 *
 * WHY THIS EXISTS. A **workspace** is the tenant (ADR 0015 B2B tenancy); an
 * **organization** is a grouping INSIDE one. This page only ever managed
 * organizations, but its title and lede ("Organizations & access · Organize your
 * team and control who can do what") read as the entry point for both. Users came
 * here to create a workspace, found only "New organization name", and concluded the
 * app could not do it — while the real affordance sat as the last `<option>` inside
 * the sidebar's workspace `<select>`, whose own label is "Switch workspace".
 *
 * A capability that exists and cannot be found is the same defect class as one that
 * is broken (ADR 0508 was the reachable-vs-working version of this).
 *
 * NOT A SECOND OWNER. This does not re-implement creation — it calls the SHARED
 * `createAndEnterWorkspace`, the same unit the switcher uses, so the two entry
 * points cannot drift on the create-then-enter pair.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { Button } from '../ui/Button.js';
import { BuildingIcon } from '../ui/icons/index.js';
import { createAndEnterWorkspace } from '../client/workspaceClient.js';

export function WorkspaceCreateSection({ onCreated }: { onCreated?: () => void }): JSX.Element {
  const { t } = useTranslation('orgs');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    void createAndEnterWorkspace(trimmed)
      .then(() => {
        setName('');
        // Entering a new workspace changes the tenant every surface reads from, so
        // a full reload is the honest refresh — a partial one would leave stale
        // org/member lists from the PREVIOUS tenant on screen. Same choice the
        // sidebar switcher makes.
        if (onCreated) onCreated();
        else window.location.reload();
      })
      .catch((err: unknown) => {
        // A failed create must SAY so. Reporting nothing here would leave the user
        // unable to tell "not allowed" from "nothing happened" — the failed-read-as-
        // empty family, in its write-path form.
        setError(err instanceof Error ? err.message : t('workspaceCreateFailed'));
        setBusy(false);
      });
  };

  return (
    <section className="u-mb-4" aria-labelledby="orgs-workspace-heading">
      <h2 id="orgs-workspace-heading" className="u-fs-16 u-flex u-gap-1 u-items-center">
        <BuildingIcon size={16} /> {t('workspaceHeading')}
      </h2>
      <p className="u-label-sm muted u-mt-1 u-mb-2">{t('workspaceVsOrgExplainer')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      <form onSubmit={submit} className="action-bar u-mb-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('newWorkspacePlaceholder')}
          aria-label={t('newWorkspaceAriaLabel')}
          disabled={busy}
        />
        <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
          {busy ? t('common:loading') : t('createWorkspace')}
        </Button>
      </form>
    </section>
  );
}
