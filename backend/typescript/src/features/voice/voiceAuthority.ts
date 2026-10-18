/**
 * Voice session authority (ADR 0893) — who may start a voice turn, and whether a
 * live call still holds the authority it was opened with.
 *
 * A typed chat turn gets both from the run machinery: `POST /runs` checks
 * `runs:create`, and every later turn is a fresh authenticated request. A live
 * voice call has no run (ADR 0138 §7) and, on the OpenAI sideband, no request per
 * turn — so voice re-creates both here:
 *
 *  - `requireVoiceTurn(req)` — the route gate (D1): the `voice` toggle, then the
 *    ONE protocol scope gate for `runs:create`.
 *  - `snapshotVoiceAuthority(req)` + `voiceAuthorityHolds(snap)` — the live-call
 *    re-check (D4 + architect H2/M1/M2/M3): captured at connect, re-run before
 *    every sideband tool call, delegation and transcript write.
 *
 * Every predicate is the one the request lane already uses — `resolveOne`
 * (toggle + paywall), `assertSessionSubjectLive` (erased / disabled / signed out),
 * `isWorkspaceMember`, `decideProtocolAuthorization` — never a voice-local copy.
 */
import type { Request } from 'express';
import { requireFeatureEnabled, toggleSubjectOf } from '../featureRoute.js';
import { requireProtocolScope, decideProtocolAuthorization, isAuthorizationEnforced } from '../../host/protocolAuthorization.js';
import { callerSubject, isOwnPersonalWorkspace, personalTenantOf, tenantOf } from '../../host/requestSubject.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { ToggleSubject } from '../../host/featureToggles/types.js';
import { delegationIssuerIsLive, isWorkspaceMember } from '../../host/accessControlService.js';
import { assertBearerSubjectLive, assertSessionSubjectLive, isSessionRefusal } from '../../middleware/auth.js';
import { delegationOf } from '../../host/delegatedSubject.js';
import { tenantKeysDisabled } from '../developer-keys/tenantKeyPolicyCache.js';
import type { SessionPayload } from '../../middleware/cookieSession.js';

/** D1 — the gate on every voice route that mints a session, spends a provider key
 *  or executes a tool. `runs:create` is the scope that opens a chat conversation. */
export async function requireVoiceTurn(req: Request): Promise<void> {
  await requireFeatureEnabled(req, 'voice', 'Voice mode');
  await requireProtocolScope(req, 'runs:create');
}

/** The opener's authority, frozen at connect so a req-less sideband can re-ask it. */
export interface VoiceAuthoritySnapshot {
  tenantId: string;
  toggleSubject: ToggleSubject;
  /** `callerSubject(req)` — the subject the route gates and D2/D5 bind. */
  subject?: string;
  /** How the request authenticated — each lane keeps its OWN presence rule
   *  (grade-code VOX2CD-1: one rule for all lanes hung up every key-opened call). */
  lane: 'session' | 'api-key' | 'env-key' | 'wildcard';
  /** `api-key` lane: the `apikey:<id>` principal whose delegation is re-checked. */
  principalId?: string;
  /** Wildcard bearer / own personal workspace: the escapes `requireProtocolScopeIn` grants. */
  scopeEscape: boolean;
  /** `session` lane: the caller's own personal tenant (`req.personalTenant`), when known. */
  personalTenant?: string;
  /** The verified user-tier cookie, when the identity rides one (liveness re-check). */
  cookieSession?: SessionPayload;
  /** VOX2-F3 — an OIDC bearer with no cookie riding along: what the request lane
   *  checked at connect, so the call re-asks it (disabled / erased / sign out
   *  everywhere). With a cookie, `cookieSession` already carries the check. */
  bearer?: { personalTenant: string; subject: string; userId?: string; epoch?: number };
}

export function snapshotVoiceAuthority(req: Request): VoiceAuthoritySnapshot {
  const subject = callerSubject(req);
  const auth = req.principal?.auth;
  const wildcard = Boolean(req.principal?.tenants?.includes('*'));
  const lane: VoiceAuthoritySnapshot['lane'] = wildcard ? 'wildcard'
    : auth?.kind === 'api-key' ? 'api-key'
      : auth?.kind === 'env-key' ? 'env-key'
        : 'session';
  const personalTenant = personalTenantOf(req);
  return {
    tenantId: tenantOf(req),
    toggleSubject: toggleSubjectOf(req),
    lane,
    ...(subject ? { subject } : {}),
    ...(lane === 'api-key' && req.principal?.principalId ? { principalId: req.principal.principalId } : {}),
    scopeEscape: wildcard || isOwnPersonalWorkspace(req),
    ...(personalTenant ? { personalTenant } : {}),
    ...(req.cookieSession ? { cookieSession: req.cookieSession } : {}),
    ...(lane === 'session' && auth?.kind === 'subject' && req.principal?.token && !req.cookieSession && personalTenant && req.principal.principalId
      ? { bearer: {
        personalTenant,
        subject: req.principal.principalId,
        ...(req.userId ? { userId: req.userId } : {}),
        ...(req.sessionEpoch !== undefined ? { epoch: req.sessionEpoch } : {}),
      } }
      : {}),
  };
}

/** Is the opener still PRESENT in the tenant, by the rule its own lane uses at
 *  authentication? `api-key`: the ADR 0795 D6 delegation check (issuer live and
 *  still a member where membership defines presence). `session`: the auth
 *  middleware's shared-workspace rule (active tenant ≠ own personal tenant ⇒ must
 *  be a member). `env-key` / wildcard: operator credentials, no membership. */
async function stillPresent(snap: VoiceAuthoritySnapshot): Promise<boolean> {
  if (snap.lane === 'api-key') return snap.principalId ? delegationIssuerIsLive(snap.tenantId, snap.principalId) : false;
  if (snap.lane !== 'session') return true;
  if (!snap.subject || !snap.personalTenant || snap.tenantId === snap.personalTenant) return true;
  return isWorkspaceMember(snap.subject, snap.tenantId);
}

/** `credential_revoked` (VOX2-F3) — the `owk_` key that opened the call was
 *  revoked or expired, or the workspace turned API keys off. */
export type VoiceAuthorityLapse = 'toggle_off' | 'session_not_live' | 'credential_revoked' | 'not_a_member' | 'missing_scope';
/** `authority_unavailable` — a store error while re-checking (grade-code VOX2CD-3).
 *  It refuses the CURRENT event (fail-closed) but is not a lapse: the call is not
 *  ended for a transient fault. */
export type VoiceAuthorityVerdict = { ok: true } | { ok: false; reason: VoiceAuthorityLapse | 'authority_unavailable' };

/** D4 — does the live call still hold the authority it was opened with? Fail-closed:
 *  any predicate that throws counts as a lapse. */
export async function voiceAuthorityHolds(snap: VoiceAuthoritySnapshot): Promise<VoiceAuthorityVerdict> {
  try {
    const assignment = await resolveOne('voice', snap.toggleSubject);
    if (!assignment?.enabled) return { ok: false, reason: 'toggle_off' };
    // A definitive refusal ends the call; a store fault (503) refuses only this
    // event, through the outer catch (VOX2CD-3).
    if (snap.cookieSession) {
      try { await assertSessionSubjectLive(snap.cookieSession); } catch (err) {
        if (isSessionRefusal(err)) return { ok: false, reason: 'session_not_live' };
        throw err;
      }
    }
    if (snap.bearer) {
      try { await assertBearerSubjectLive(snap.bearer); } catch (err) {
        if (isSessionRefusal(err)) return { ok: false, reason: 'session_not_live' };
        throw err;
      }
    }
    // VOX2-F3 — the key itself, the request lane's own checks: revoked or expired
    // (the delegation lookup answers null), or keys turned off for the workspace.
    if (snap.lane === 'api-key') {
      if (!snap.principalId || !(await delegationOf(snap.principalId))) return { ok: false, reason: 'credential_revoked' };
      if (await tenantKeysDisabled(snap.tenantId)) return { ok: false, reason: 'credential_revoked' };
    }
    if (!(await stillPresent(snap))) return { ok: false, reason: 'not_a_member' };
    if (isAuthorizationEnforced() && !snap.scopeEscape) {
      const decision = await decideProtocolAuthorization(snap.tenantId, snap.subject, 'runs:create');
      if (!decision.allowed) return { ok: false, reason: 'missing_scope' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'authority_unavailable' };
  }
}
