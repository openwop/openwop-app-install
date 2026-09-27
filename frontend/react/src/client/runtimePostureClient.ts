/**
 * Runtime posture client (ADR 0742, host-extension, superadmin only).
 *
 * GET  /host/openwop-app/runtime-posture                 → live posture read back from Cloud Run
 * POST /host/openwop-app/runtime-posture/change-requests → { warm } ONLY → audited change request
 *
 * The backend is the authority and holds no write credential: a change request
 * returns the commands to run, it never applies them.
 *
 * @see ../../../backend/typescript/src/features/runtime-posture/routes.ts
 */
import { authedHeaders, config, fetchOpts } from './config.js';
import { readErrorMessage } from './errorEnvelope.js';

export interface ServingPosture {
  minInstances: number;
  cpuThrottled: boolean;
  posture: 'warm' | 'cold' | 'custom';
  cpu: number;
  memoryGiB: number;
}

export type RuntimePosture =
  | {
      available: true;
      service: string;
      project: string;
      region: string;
      servingRevision: string | null;
      serving: ServingPosture | null;
      pendingRevision: string | null;
      rollout: 'settled' | 'not-live';
      monthlyCostUsd: { warm: number; cold: number };
      readAt: string;
    }
  | { available: false; reason: string };

export interface PostureChangeRequest {
  from: string;
  to: 'warm' | 'cold';
  servingRevision: string | null;
  noop: boolean;
  commands: string[];
  note: string;
}

const base = `${config.baseUrl}/host/openwop-app/runtime-posture`;

/** Carries the STATUS, because the page must distinguish "not signed in yet"
 *  (401, or a 403 while the session is still anonymous — the identity binds a
 *  couple of seconds after first paint) from "signed in and not allowed" and
 *  from a genuine failed read. Without the status all three rendered as the same
 *  terminal error, which is what a superadmin saw on a working system. */
export class RuntimePostureRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RuntimePostureRequestError';
  }
}

async function readOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    throw new RuntimePostureRequestError(readErrorMessage(body) ?? `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export async function getRuntimePosture(): Promise<RuntimePosture> {
  return readOrThrow<RuntimePosture>(await fetch(base, fetchOpts({ headers: authedHeaders() })));
}

export async function requestPostureChange(warm: boolean): Promise<PostureChangeRequest> {
  return readOrThrow<PostureChangeRequest>(
    await fetch(`${base}/change-requests`, fetchOpts({
      method: 'POST',
      headers: authedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ warm }),
    })),
  );
}
