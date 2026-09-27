/**
 * ADR 0555 P2 — the IPC framing between the host and a forked pack worker.
 *
 * P1's `packWorkerContract.ts` owns the four SEMANTIC messages (envelope,
 * host-call request, host-call response, result). This module owns only their
 * ENVELOPE ON THE WIRE for the child-process transport: a discriminated `k` tag
 * and a `seq` used to correlate a host-call response with its request. A second
 * transport (a `MessagePort`, a socket) would bring its own framing and reuse
 * the same semantic messages, which is the point of keeping the two apart.
 *
 * ── THE SERIALIZATION TRAP THIS FILE EXISTS TO PIN ────────────────────────
 *
 * `child_process.fork()` serializes IPC as **JSON by default**, not structured
 * clone. MEASURED on Node 22.13.1 with a payload of `{Date, Map, Set, Buffer}`:
 *
 *   serialization: 'json'      → Date becomes a String, Map and Set and Buffer
 *                                all become `{}` — silently, no error
 *   serialization: 'advanced'  → all four survive with their types intact
 *
 * P1's entire contract is defined by `structuredClone` (`assertStructuredCloneSafe`
 * exists precisely because it "is the exact predicate `postMessage` applies").
 * Running this transport on the default would therefore have quietly corrupted
 * every host-call value whose type carries meaning — a `Date` from a storage
 * read arriving as a string, a `Map` arriving empty — with no failure anywhere
 * to notice. `ADVANCED_SERIALIZATION` is not a tuning knob; it is what makes
 * this transport implement the contract rather than approximate it, and
 * `pack-isolation-child-adapter.test.ts` pins it by round-tripping those four
 * types through a real fork.
 */

import type { DispatchEnvelope, DispatchResult, HostCallRequest, HostCallResponse } from '../packWorkerContract.js';

/** The ONLY value `fork()`'s `serialization` option may take here. See above. */
export const ADVANCED_SERIALIZATION = 'advanced' as const;

/** host → worker */
export type ParentMessage =
  | { readonly k: 'envelope'; readonly envelope: DispatchEnvelope }
  | { readonly k: 'host-call-response'; readonly seq: number; readonly res: HostCallResponse };

/** worker → host */
export type ChildMessage =
  /** Sent once, after the realm is hardened and before the envelope is read, so
   *  the host can distinguish "the worker never booted" from "the pack hung". */
  | { readonly k: 'ready' }
  | { readonly k: 'host-call'; readonly seq: number; readonly req: HostCallRequest }
  | { readonly k: 'result'; readonly result: DispatchResult };

export function isChildMessage(value: unknown): value is ChildMessage {
  if (!value || typeof value !== 'object') return false;
  const k = (value as { k?: unknown }).k;
  return k === 'ready' || k === 'host-call' || k === 'result';
}
