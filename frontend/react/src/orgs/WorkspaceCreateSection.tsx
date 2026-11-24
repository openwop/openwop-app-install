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
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { reloadIntoSession } from '../auth/reloadIntoSession.js';
import { Button } from '../ui/Button.js';
import { BuildingIcon } from '../ui/icons/index.js';
import { createAndEnterWorkspace, completeWorkspaceTransition, reloadIfTransitionStranded, getWorkspaceTransitionSnapshot, WorkspaceLifecycleError } from '../client/workspaceClient.js';
import { getCurrentAuthChangeEvent } from '../client/config.js';
import { ApiError } from '../client/requestJson.js';

interface CallerLife { alive: boolean }
interface CallerConfiguration { readonly handler: (() => void) | undefined }
function captureWorkspaceStamp() {
  const state = getWorkspaceTransitionSnapshot();
  return { event: getCurrentAuthChangeEvent(), auth: state.authRevision, revision: state.revision };
}
function currentWorkspaceStamp(stamp: ReturnType<typeof captureWorkspaceStamp>): boolean {
  const state = getWorkspaceTransitionSnapshot();
  return getCurrentAuthChangeEvent() === stamp.event
    && state.authRevision === stamp.auth && state.revision === stamp.revision;
}

export function WorkspaceCreateSection({ onCreated }: { onCreated?: () => void }): JSX.Element {
  const { t } = useTranslation('orgs');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifeRef = useRef<CallerLife | null>(null);
  const configurationRef = useRef<Readonly<CallerConfiguration> | null>(null);
  const requestRef = useRef<object | null>(null);
  const busyRef = useRef<object | null>(null);

  useLayoutEffect(() => {
    const life: CallerLife = { alive: true };
    lifeRef.current = life;
    return () => {
      life.alive = false;
      if (lifeRef.current === life) {
        lifeRef.current = null;
        requestRef.current = null;
        busyRef.current = null;
      }
    };
  }, []);
  // A committed change issues a fresh configuration identity. A→B→same A must
  // never re-arm A's earlier request; abandoned renders publish no authority.
  useLayoutEffect(() => {
    const previous = configurationRef.current;
    if (!previous || previous.handler !== onCreated) {
      configurationRef.current = Object.freeze({ handler: onCreated });
    }
  }, [onCreated]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    const life = lifeRef.current;
    const configuration = configurationRef.current;
    if (!trimmed || busy || busyRef.current || !life?.alive || !configuration) return;
    const ticket = Object.freeze({});
    requestRef.current = ticket;
    busyRef.current = ticket;
    const handler = configuration.handler;
    const requestOwned = (): boolean => life.alive && lifeRef.current === life && requestRef.current === ticket;
    const actionCurrent = (): boolean => requestOwned() && configurationRef.current === configuration;
    const startEvent = getCurrentAuthChangeEvent();
    const notice = t('common:workspaceChangeNeedsRefresh');
    const showError = (message: string): void => {
      if (!actionCurrent()) return;
      const stamp = captureWorkspaceStamp();
      setError((prior) => actionCurrent() && currentWorkspaceStamp(stamp) ? message : prior);
    };
    setBusy(true);
    setError((prior) => actionCurrent() ? null : prior);
    let completing = false;
    void createAndEnterWorkspace(trimmed)
      .then((result) => {
        completing = true;
        reloadIfTransitionStranded(completeWorkspaceTransition(result, {
          isCallerCurrent: actionCurrent,
          beforeAction: () => {
            const stamp = captureWorkspaceStamp();
            setName((prior) => actionCurrent() && currentWorkspaceStamp(stamp) ? '' : prior);
          },
          action: handler ?? reloadIntoSession,
          failed: () => { showError(notice); },
        }), reloadIntoSession);
      })
      .catch((err: unknown) => {
        if (!completing && actionCurrent() && getCurrentAuthChangeEvent() === startEvent) {
          if (err instanceof WorkspaceLifecycleError) {
            if (err.code === 'workspace_transition_uncertain') showError(t('common:workspaceChangeCouldNotFinish'));
          } else {
            // Status classifies a refusal; arbitrary server/internal text is not UI copy.
            const key = err instanceof ApiError && (err.status === 401 || err.status === 403)
              ? 'common:workspaceChangeNotAllowed' : 'common:workspaceChangeCouldNotFinish';
            showError(t(key));
          }
        }
      })
      .finally(() => {
        if (requestOwned()) {
          busyRef.current = null;
          setBusy((prior) => requestOwned() ? false : prior);
        }
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
