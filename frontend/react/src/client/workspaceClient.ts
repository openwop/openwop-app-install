/**
 * Workspace (tenancy) host-extension client — ADR 0015. Wraps
 * /host/openwop-app/{me/workspaces,workspaces,workspaces/:id/switch}: the B2B
 * "workspace = tenant" surface. A user lists the workspaces they can act in,
 * creates a shared one (becoming its owner), and switches the ACTIVE workspace
 * (re-binding the session — the RFC 0048 §D one-active-workspace model).
 *
 * @see ../../../backend/typescript/src/routes/workspaces.ts
 */
import { authedHeaders, config, fetchOpts } from './config.js';
import { rememberWireTenant } from './v2Wire.js';
import { ApiError } from './requestJson.js';

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  slug: string;
  roles: string[];
  kind: 'personal' | 'shared';
  active: boolean;
}

export interface MyWorkspaces {
  workspaces: WorkspaceSummary[];
  /** The active workspace tenant. */
  active: string;
  /** The caller's intrinsic personal workspace tenant. */
  personal: string;
}

const base = `${config.baseUrl}/host/openwop-app`;
const headers = (): Record<string, string> => authedHeaders();
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string }; message?: string };
      detail = body?.error?.message ?? body?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: detail || `${ctx} returned ${res.status}` });
  }
  return (await res.json()) as T;
}

/** The workspaces the caller can act in, plus the active + personal tenants. */
export async function listMyWorkspaces(): Promise<MyWorkspaces> {
  const res = await fetch(`${base}/me/workspaces`, fetchOpts({ headers: headers() }));
  return asJson<MyWorkspaces>(res, 'listMyWorkspaces');
}

/** Create a shared workspace; the caller becomes its owner. */
export async function createWorkspace(input: { name: string; description?: string }): Promise<WorkspaceSummary> {
  const res = await fetch(`${base}/workspaces`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<WorkspaceSummary>(res, 'createWorkspace');
}

/** Switch the active workspace (re-binds the session cookie; membership-gated). */
export async function switchWorkspace(workspaceId: string): Promise<{ ok: boolean; active: string }> {
  const res = await fetch(
    `${base}/workspaces/${encodeURIComponent(workspaceId)}/switch`,
    fetchOpts({ method: 'POST', headers: jsonHeaders() }),
  );
  const out = await asJson<{ ok: boolean; active: string }>(res, 'switchWorkspace');
  rememberWireTenant(out.active); // the session is re-bound; so is every run id we send
  return out;
}

/**
 * Create a shared workspace AND enter it — the ONE behaviour, so the two entry
 * points that offer it cannot drift.
 *
 * Creating without switching leaves the user looking at their old workspace
 * wondering whether it worked, so the two calls are a single unit. The sidebar
 * switcher and the Organizations page both call this rather than re-implementing
 * the pair; a second copy is how one of them would quietly stop switching.
 *
 * The caller becomes the workspace's owner (`routes/workspaces.ts` seeds the
 * owner member), so the switch that follows is always membership-valid.
 */
export async function createAndEnterWorkspace(name: string): Promise<WorkspaceSummary> {
  const ws = await createWorkspace({ name });
  await switchWorkspace(ws.workspaceId);
  return ws;
}
