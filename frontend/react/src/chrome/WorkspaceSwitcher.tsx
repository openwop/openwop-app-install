/**
 * Workspace switcher (ADR 0015 — workspace-as-tenant). Replaces the static
 * workspace-context slot in the sidebar with a live switcher: it lists the
 * workspaces the caller can act in, switches the ACTIVE workspace (re-binding
 * the session), and creates a new shared workspace via an inline name input
 * (Enter to create, Esc/blur to cancel).
 *
 * Switching the active workspace changes the tenant every surface reads from,
 * so we hard-reload after a switch — the simplest correct way to re-fetch the
 * whole app under the new tenant without threading a global workspace context
 * through every cache. (A future refinement can swap the reload for a
 * context-level invalidation.)
 *
 * @see ../client/workspaceClient.ts, ../../../backend/typescript/src/routes/workspaces.ts
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCurrentAuthChangeEvent, onAuthChange } from '../client/config.js';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { BuildingIcon, SettingsIcon } from '../ui/icons/index.js';
import { listMyWorkspaces, switchWorkspace, createAndEnterWorkspace, completeWorkspaceTransition, reloadIfTransitionStranded, getWorkspaceTransitionSnapshot, WorkspaceLifecycleError, type WorkspaceSummary, type WorkspaceMutationResult } from '../client/workspaceClient.js';
import { Notice } from '../ui/Notice.js';
import { WorkspaceSwitcherLink } from './WorkspaceSwitcherLink.js';
import { reloadIntoSession } from '../auth/reloadIntoSession.js';
import { ApiError } from '../client/requestJson.js';

interface CallerLife { alive: boolean }
function captureWorkspaceStamp() {
  const state = getWorkspaceTransitionSnapshot();
  return { event: getCurrentAuthChangeEvent(), auth: state.authRevision, revision: state.revision };
}
function currentWorkspaceStamp(stamp: ReturnType<typeof captureWorkspaceStamp>): boolean {
  const state = getWorkspaceTransitionSnapshot();
  return getCurrentAuthChangeEvent() === stamp.event
    && state.authRevision === stamp.auth && state.revision === stamp.revision;
}

const NEW = '__new__';

export function WorkspaceSwitcher(): JSX.Element {
  const { t } = useTranslation('chrome');
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [active, setActive] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const lifeRef = useRef<CallerLife | null>(null);
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

  useEffect(() => {
    let alive = true;
    let readTicket: object | null = null;
    const load = (): void => {
      const ticket = Object.freeze({});
      readTicket = ticket;
      const event = getCurrentAuthChangeEvent();
      const current = (): boolean => alive && readTicket === ticket
        && lifeRef.current?.alive === true && getCurrentAuthChangeEvent() === event;
      void listMyWorkspaces()
        .then((result) => {
          if (!current()) return;
          setWorkspaces((prior) => current() ? result.workspaces : prior);
          setActive((prior) => current() ? result.active : prior);
        })
        .catch(() => { /* endpoint unavailable: retain the existing static fallback */ });
    };
    load();
    const unsubscribe = onAuthChange(() => { load(); });
    return () => { alive = false; readTicket = null; unsubscribe(); };
  }, []);

  const reloadInto = async (fn: () => Promise<WorkspaceMutationResult>): Promise<void> => {
    const life = lifeRef.current;
    if (!life?.alive || busyRef.current) return;
    const ticket = Object.freeze({});
    requestRef.current = ticket;
    busyRef.current = ticket;
    const current = (): boolean => life.alive && lifeRef.current === life && requestRef.current === ticket;
    const startEvent = getCurrentAuthChangeEvent();
    const notice = t('common:workspaceChangeNeedsRefresh');
    const showError = (message: string): void => {
      if (!current()) return;
      const stamp = captureWorkspaceStamp();
      setError((prior) => current() && currentWorkspaceStamp(stamp) ? message : prior);
    };
    setBusy(true);
    setError((prior) => current() ? null : prior);
    let completing = false;
    try {
      const result = await fn();
      completing = true;
      reloadIfTransitionStranded(completeWorkspaceTransition(result, {
        isCallerCurrent: current,
        action: reloadIntoSession,
        failed: () => { showError(notice); },
      }), reloadIntoSession);
    } catch (err: unknown) {
      if (!completing && current() && getCurrentAuthChangeEvent() === startEvent) {
        if (err instanceof WorkspaceLifecycleError) {
          if (err.code === 'workspace_transition_uncertain') showError(t('common:workspaceChangeCouldNotFinish'));
        } else {
          // Status classifies a refusal; arbitrary server/internal text is not UI copy.
          const key = err instanceof ApiError && (err.status === 401 || err.status === 403)
            ? 'common:workspaceChangeNotAllowed' : 'common:workspaceChangeCouldNotFinish';
          showError(t(key));
        }
      }
    } finally {
      if (current()) {
        busyRef.current = null;
        setBusy((prior) => current() ? false : prior);
      }
    }
  };

  const onChange = (value: string): void => {
    if (busy || busyRef.current) return;
    if (value === NEW) { setCreating(true); return; }
    if (value !== active) void reloadInto(() => switchWorkspace(value));
  };
  const submitCreate = (): void => {
    const name = newName.trim();
    if (!name || busy || busyRef.current) return;
    // Return the actual issued result; completion identity cannot be discarded.
    void reloadInto(() => createAndEnterWorkspace(name));
  };
  const cancelCreate = (): void => {
    if (!busy && !busyRef.current) { setCreating(false); setNewName(''); }
  };

  // Until workspaces load (or for an anonymous visitor), keep the original
  // static affordance so the chrome never looks broken.
  if (workspaces.length === 0) {
    return (
      <>
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      <WorkspaceSwitcherLink />
      </>
    );
  }

  return (
    <>
    {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
    <div className="app-workspace-block">
      <div className="app-workspace-switcher" title={t('switchWorkspace')}>
        <span className="app-workspace-icon" aria-hidden><BuildingIcon size={16} /></span>
        <span className="app-workspace-meta">
          <span className="app-workspace-eyebrow">{t('workspace')}</span>
          <select
            className="app-workspace-select"
            aria-label={t('activeWorkspace')}
            value={active}
            disabled={busy}
            onChange={(e) => onChange(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.workspaceId} value={w.workspaceId}>
                {w.name}
              </option>
            ))}
            <option value={NEW}>{t('newWorkspaceOption')}</option>
          </select>
        </span>
        <Link
          to="/orgs"
          className="app-workspace-manage"
          aria-label={t('manageMembersRoles')}
          title={t('membersAndRoles')}
        >
          <SettingsIcon size={14} />
        </Link>
      </div>
      {creating && (
        <input
          className="app-workspace-create"
          aria-label={t('newWorkspaceName')}
          placeholder={t('newWorkspacePlaceholder')}
          autoFocus
          value={newName}
          disabled={busy}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitCreate();
            else if (e.key === 'Escape') cancelCreate();
          }}
          // Cancel on blur only when empty — a half-typed name survives an
          // accidental focus loss (commit with Enter, abandon with Esc).
          onBlur={() => { if (!busy && !newName.trim()) cancelCreate(); }}
        />
      )}
    </div>
    </>
  );
}
