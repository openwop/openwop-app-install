/**
 * ADR 0958 P2 — the collaborator's client. Every read is derived server-side from
 * a grant the signed-in person is bound to; nothing here names an agency id.
 * A failed read throws (never an empty list), so pages can say "couldn't load".
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { resolveSharedPublic } from '../sharing/sharingClient.js';

export interface SharedItem { grantId: string; resourceKind: string; title: string; clientName?: string; actions: string[]; expiresAt: string }
export interface GrantView {
  grant: { grantId: string; resourceKind: string; actions: string[]; expiresAt: string };
  title: string;
  clientName?: string;
  resource: Record<string, unknown>;
}
export interface InviteView { collaboratorKind: string; displayName: string; clientName?: string }

/** A failed call: status plus the server's `details.reason`. */
export class CollabError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
    this.name = 'CollabError';
  }
}

const base = `${config.baseUrl}/host/openwop-app/collab`;
async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = ''; let reason: string | undefined;
    try { const b = (await res.json()) as { message?: string; details?: { reason?: string } }; message = b?.message ?? ''; reason = b?.details?.reason; } catch { /* non-JSON */ }
    throw new CollabError(message, res.status, reason);
  }
  return (await res.json()) as T;
}

export async function listShared(): Promise<SharedItem[]> {
  return (await asJson<{ items: SharedItem[] }>(await fetch(`${base}/shared`, fetchOpts({ headers: authedHeaders() })))).items;
}
export async function getGrant(grantId: string): Promise<GrantView> {
  return asJson<GrantView>(await fetch(`${base}/grants/${encodeURIComponent(grantId)}`, fetchOpts({ headers: authedHeaders() })));
}
export async function acceptInvite(token: string): Promise<void> {
  await asJson<unknown>(await fetch(`${base}/invites/accept`, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ token }) })));
}
/** Who the invite is for: the public `collab_invite` projection (never the email). */
export async function readInvite(token: string): Promise<InviteView> {
  const shared = await resolveSharedPublic(token);
  const r = shared.resource;
  return {
    collaboratorKind: typeof r.collaboratorKind === 'string' ? r.collaboratorKind : 'vendor',
    displayName: typeof r.displayName === 'string' ? r.displayName : '',
    ...(typeof r.clientName === 'string' ? { clientName: r.clientName } : {}),
  };
}

// ── ADR 0958 P3 — sending files (vendor asset intake) ──

/** The file types an agency accepts from collaborators (the server proves each by its bytes). */
export const INTAKE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,video/mp4,video/webm';
/** Per upload, in total (the server's own cap). */
export const INTAKE_MAX_BYTES = 8 * 1024 * 1024;
export const INTAKE_MAX_FILES = 5;
export const INTAKE_LICENSES = ['work-for-hire', 'licensed-perpetual', 'licensed-term', 'client-owned', 'stock'] as const;
export type IntakeLicense = (typeof INTAKE_LICENSES)[number];

export interface IntakeRightsInput { license: IntakeLicense; termEndsAt?: string; credit?: string; modelReleases: boolean; attest: true }
export interface IntakeView {
  intakeId: string;
  status: 'submitted' | 'accepted' | 'rejected' | 'withdrawn';
  submittedAt: string;
  reviewedAt?: string;
  reason?: string;
  files: Array<{ fileId: string; name: string; contentType: string; bytes: number }>;
  rights: { license: IntakeLicense; termEndsAt?: string; credit?: string; modelReleases: boolean };
  note?: string;
}

/** Base64 of a picked file (no data-URL prefix). */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function sendIntake(grantId: string, files: File[], rights: IntakeRightsInput, note?: string): Promise<IntakeView> {
  const payload = {
    files: await Promise.all(files.map(async (f) => ({ name: f.name, contentType: f.type, contentBase64: await fileToBase64(f) }))),
    rights,
    ...(note ? { note } : {}),
  };
  const r = await asJson<{ intake: IntakeView }>(await fetch(`${base}/grants/${encodeURIComponent(grantId)}/intakes`, fetchOpts({
    method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(payload),
  })));
  return r.intake;
}
export async function listIntakes(grantId: string): Promise<IntakeView[]> {
  return (await asJson<{ intakes: IntakeView[] }>(await fetch(`${base}/grants/${encodeURIComponent(grantId)}/intakes`, fetchOpts({ headers: authedHeaders() })))).intakes;
}
export async function withdrawIntake(grantId: string, intakeId: string): Promise<IntakeView> {
  return (await asJson<{ intake: IntakeView }>(await fetch(`${base}/grants/${encodeURIComponent(grantId)}/intakes/${encodeURIComponent(intakeId)}/withdraw`, fetchOpts({
    method: 'POST', headers: authedHeaders(),
  })))).intake;
}
