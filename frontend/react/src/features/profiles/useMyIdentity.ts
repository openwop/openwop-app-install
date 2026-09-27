/**
 * ADR 0492 — the viewer's identity as a DISCRIMINATED UNION, so "we don't know
 * who you are" cannot be silently spent as an answer.
 *
 * The defect this exists to prevent (found three times in one day, in three
 * files, each fixed independently and slightly differently):
 *
 *   const [myId, setMyId] = useState<string | null>(null);
 *   getMyProfile().then(p => setMyId(p.userId)).catch(() => setMyId(null));
 *   ...
 *   const isMine = row.userId === myId;   // ← null compares unequal to everything
 *
 * A failed identity read leaves `myId === null`, and `null` is unequal to every
 * real id — so EVERY ownership test silently answers "not yours". That is the
 * PERMISSIVE answer for "is this mine?" (own-row guards stop firing: `/team`
 * enabled your own skill chips, which the server then 403s) and the RESTRICTIVE
 * answer for "may I manage it?" (owner-only controls vanish: the agent
 * "Allow recall" grant panel disappeared for a twin that *was* yours). Both are
 * wrong, neither throws, and nothing in the type system objects.
 *
 * The union makes the unknown arm unignorable: there is no bare `myId` to
 * compare against, so a new call site cannot reintroduce the bug by writing
 * `row.userId === myId` — that does not typecheck. `isMine()` returns
 * `boolean | 'unknown'`, which forces the caller to decide what unknown means
 * for THEIR surface rather than inheriting `false` by accident.
 *
 * WHERE THIS LIVES, and why it is not in core: ADR 0446 found that moving
 * cross-feature coupling to core is almost always the wrong instinct (the
 * god-core trap) — its genuine primitive-extraction yield across a whole audit
 * was ONE. `features/twin` already imports `getMyProfile` from
 * `features/profiles`; this hook rides that EXISTING edge rather than creating a
 * new core module for two consumers. If a third feature outside that edge needs
 * it, that is the moment to reconsider — not before.
 */
import { useEffect, useState } from 'react';
import { getMyProfile, type Profile } from './profilesClient.js';

export type MyIdentity =
  | { status: 'loading' }
  /** The read landed. `userId` is the viewer's own id. */
  | { status: 'known'; userId: string; profile: Profile }
  /**
   * The read did NOT land. Deliberately carries no `userId` — a caller that
   * wants one must handle this arm first, which is the whole point.
   */
  | { status: 'unknown'; error: string };

/**
 * Compare a row's owner against the viewer.
 *
 * Returns `'unknown'` — NOT `false` — when identity could not be read, so the
 * caller must decide. The two correct answers, both in use:
 *   - a control that ACTS on your own row → treat unknown as "don't offer it"
 *     (fail closed; `/team` disables the endorse chip and says why).
 *   - a claim ABOUT ownership → say you don't know, never assert the negative
 *     (the twin panel stops announcing "Twin of <someone else>").
 */
export function isMine(identity: MyIdentity, ownerId: string | null | undefined): boolean | 'unknown' {
  if (identity.status !== 'known') return 'unknown';
  if (!ownerId) return false;
  return ownerId === identity.userId;
}

/**
 * Read the viewer's identity once on mount.
 *
 * `getMyProfile` coalesces concurrent reads itself (`cachedRead('profiles.me', 0)`),
 * so several components calling this on the same paint share one request — no
 * caching layer is added here.
 */
export function useMyIdentity(): MyIdentity {
  const [identity, setIdentity] = useState<MyIdentity>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void getMyProfile()
      .then((p) => { if (!cancelled) setIdentity({ status: 'known', userId: p.userId, profile: p }); })
      .catch((e) => {
        if (!cancelled) setIdentity({ status: 'unknown', error: e instanceof Error ? e.message : String(e) });
      });
    return () => { cancelled = true; };
  }, []);

  return identity;
}
