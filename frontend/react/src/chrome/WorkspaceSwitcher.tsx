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
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { brand } from '../brand/brand.js';
import { BuildingIcon, ChevronRightIcon, SettingsIcon } from '../ui/icons/index.js';
import { listMyWorkspaces, switchWorkspace, createWorkspace, type WorkspaceSummary } from '../client/workspaceClient.js';

const NEW = '__new__';

export function WorkspaceSwitcher(): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [active, setActive] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    let alive = true;
    listMyWorkspaces()
      .then((r) => { if (alive) { setWorkspaces(r.workspaces); setActive(r.active); } })
      .catch(() => { /* unauthenticated / endpoint unavailable — keep the static fallback */ });
    return () => { alive = false; };
  }, []);

  const reloadInto = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      window.location.reload();
    } catch {
      setBusy(false); // surface stays usable; the failed call already logged
    }
  };

  const onChange = (value: string): void => {
    if (busy) return;
    if (value === NEW) { setCreating(true); return; }
    if (value !== active) void reloadInto(() => switchWorkspace(value));
  };

  const submitCreate = (): void => {
    const name = newName.trim();
    if (!name || busy) return;
    void reloadInto(async () => {
      const ws = await createWorkspace({ name });
      await switchWorkspace(ws.workspaceId);
    });
  };
  const cancelCreate = (): void => { if (!busy) { setCreating(false); setNewName(''); } };

  // Until workspaces load (or for an anonymous visitor), keep the original
  // static affordance so the chrome never looks broken.
  if (workspaces.length === 0) {
    return (
      <Link to="/orgs" className="app-workspace-switcher" title="Workspace + organizations">
        <span className="app-workspace-icon" aria-hidden><BuildingIcon size={16} /></span>
        <span className="app-workspace-meta">
          <span className="app-workspace-eyebrow">Workspace</span>
          <span className="app-workspace-name">{brand.instanceName}</span>
        </span>
        <span className="app-workspace-caret" aria-hidden><ChevronRightIcon size={14} /></span>
      </Link>
    );
  }

  return (
    <div className="app-workspace-block">
      <div className="app-workspace-switcher" title="Switch workspace">
        <span className="app-workspace-icon" aria-hidden><BuildingIcon size={16} /></span>
        <span className="app-workspace-meta">
          <span className="app-workspace-eyebrow">Workspace</span>
          <select
            className="app-workspace-select"
            aria-label="Active workspace"
            value={active}
            disabled={busy}
            onChange={(e) => onChange(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.workspaceId} value={w.workspaceId}>
                {w.name}{w.kind === 'personal' ? ' · personal' : ''}
              </option>
            ))}
            <option value={NEW}>+ New workspace…</option>
          </select>
        </span>
        <Link
          to="/orgs"
          className="app-workspace-manage"
          aria-label="Manage workspace members and roles"
          title="Members & roles"
        >
          <SettingsIcon size={14} />
        </Link>
      </div>
      {creating && (
        <input
          className="app-workspace-create"
          aria-label="New workspace name"
          placeholder="New workspace — Enter to create, Esc to cancel"
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
  );
}
