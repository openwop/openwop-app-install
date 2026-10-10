/**
 * ADR 0779 D2 — the credentialRef namespaces a lifecycle OTHER than the Keys
 * page owns. One tenant secret store holds every kind of secret, so without this
 * list the Keys lane (`routes/byok.ts`) could overwrite a member's OAuth token
 * JSON, paste a user-scoped subscription token into a shared workspace (ADR 0757
 * forbids it), or delete a connection's token behind the connection's back.
 *
 * Each owner builds its refs FROM its prefix here, so the list and the refs it
 * describes cannot disagree. A new owner registers here AND in the writer
 * ratchet (`test/adr0779-byok-ref-namespaces.test.ts`), which fails when a new
 * file starts writing secrets through `setSecret`.
 *
 * `auth:` is deliberately absent: ADR 0556 §D makes "write the ref" the tenant
 * admin's rotation of `auth:workload-identity-subject-salt`.
 */

export const OWNED_REF_PREFIXES = {
  connection: 'connection:',
  connectionInbound: 'connection-inbound:',
  subscription: 'subscription:',
  compatKey: 'compat-key:',
  pmPeer: 'pm-peer:',
  emailWebhook: 'email-webhook:',
  managed: 'managed:',
} as const;

/** The owning lifecycle, named for the refusal message (never a value). */
const OWNERS: Record<keyof typeof OWNED_REF_PREFIXES, string> = {
  connection: 'connections',
  connectionInbound: 'connections (inbound webhooks)',
  subscription: 'subscription credentials',
  compatKey: 'compatible endpoints',
  pmPeer: 'priority-matrix federation',
  emailWebhook: 'email bounce webhooks',
  managed: 'the managed AI tier',
};

/** The lifecycle that owns `ref`, or null when the Keys lane may write it.
 *  Longest prefix first, so `connection-inbound:` is never read as `connection:`
 *  (it is not today — the colon differs — but the order keeps it true). */
export function systemOwnedRefOwner(ref: string): string | null {
  const entries = (Object.keys(OWNED_REF_PREFIXES) as Array<keyof typeof OWNED_REF_PREFIXES>)
    .sort((a, b) => OWNED_REF_PREFIXES[b].length - OWNED_REF_PREFIXES[a].length);
  for (const key of entries) {
    if (ref.startsWith(OWNED_REF_PREFIXES[key])) return OWNERS[key];
  }
  return null;
}
