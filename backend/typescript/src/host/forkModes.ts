/**
 * The fork modes this host serves — ONE array, read by both the validator that
 * accepts them and the advert that claims them.
 *
 * `capabilities.replay.modes` is a closed enum of `replay | branch`, and a host
 * may honestly serve either or both. Writing the advert by hand would make it a
 * promise; reading it from the same constant `POST /runs/{id}:fork` validates
 * against makes it a description. If this host ever stops serving a mode, the
 * validator and the advert lose it together and cannot disagree — the same move
 * as `INTERRUPT_TOKEN_ALGS` for the interrupt family.
 *
 * It lives in its own module rather than in `routes/runs.ts` so that
 * `routes/discovery.ts` can read it without a route module importing another
 * route module.
 */
export const FORK_MODES = ['replay', 'branch'] as const;

export type ForkMode = (typeof FORK_MODES)[number];

export function isForkMode(v: unknown): v is ForkMode {
  return typeof v === 'string' && (FORK_MODES as readonly string[]).includes(v);
}
