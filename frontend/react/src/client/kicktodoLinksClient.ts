/**
 * KickTodo paid-challenge links client (ADR 0420, admin link surface) — React-free.
 * Rides /host/openwop-app/kicktodo/entitlements/links. Manage-gated server-side.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

export interface ChallengeProductLink {
  tenantId: string;
  productId: string;
  challengeId: string;
  challengeVersion: number;
  createdBy: string;
  createdAt: string;
}

const B = () => `${config.baseUrl}/host/openwop-app/kicktodo/entitlements/links`;

async function messageOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return body.message ?? fallback;
}

export async function listChallengeLinks(): Promise<ChallengeProductLink[]> {
  const res = await fetch(B(), { ...fetchOpts({}), headers: authedHeaders({}) });
  if (!res.ok) throw new Error(`links failed: ${res.status}`);
  return ((await res.json()) as { links: ChallengeProductLink[] }).links;
}

/** A 409 is the server refusing a SILENT relink (the product already sells another
 *  version) — thrown with `conflict: true` so the UI can offer an explicit replace. */
export class LinkConflictError extends Error {
  readonly conflict = true;
}

export async function linkChallengeProduct(input: { productId: string; challengeId: string; challengeVersion: number; replace?: boolean }): Promise<ChallengeProductLink> {
  const res = await fetch(B(), {
    ...fetchOpts({}), method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(input),
  });
  if (res.status === 409) throw new LinkConflictError(await messageOf(res, 'This product already sells another challenge version.'));
  if (!res.ok) throw new Error(await messageOf(res, `link failed: ${res.status}`));
  return (await res.json()) as ChallengeProductLink;
}

export async function unlinkChallengeProduct(productId: string): Promise<void> {
  const res = await fetch(`${B()}/${encodeURIComponent(productId)}`, { ...fetchOpts({}), method: 'DELETE', headers: authedHeaders({}) });
  if (!res.ok && res.status !== 404) throw new Error(`unlink failed: ${res.status}`);
}
