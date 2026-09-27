/**
 * The bound-id path projection (`spec/v2/core/identity.md` §5, RFC 0184 §A.1).
 *
 * A tenant-bound id is TWO segments joined by `/`; a URL path parameter is ONE.
 * The corpus used to say `%2F` carries the separator across. THIS HOST is the
 * measurement that killed that spelling: on 2026-09-05, at `app.openwop.dev`,
 * the hosting layer decoded `%2F` back to `/` before forwarding, the backend
 * correctly had no route for a literal slash, and every bound id was
 * unreachable through our own front door while the direct `*.run.app` URL
 * answered 200. RFC 0184 §Motivation cites that outage by name.
 *
 * So the escape marker is `~`: RFC 3986 §2.3 lists it as UNRESERVED, and an
 * intermediary has no license to rewrite an unreserved character in either
 * direction. `%2F` has no such protection, because handling it correctly means
 * distinguishing a percent-encoded RESERVED octet (§6.2.2.2: a normalizer MUST
 * NOT decode it) from an unreserved one (it SHOULD) — and deployed front doors
 * do not.
 *
 * WHY THIS IS A COPY RATHER THAN AN IMPORT. The canonical codec lives at
 * `@openwop/openwop-conformance` `src/lib/bound-id.ts`, which is a
 * devDependency — the certifying suite, not a runtime dependency, and making
 * production import the thing that grades production is the wrong direction.
 * A copy is therefore a MIRROR, and a mirror that nothing pins drifts silently.
 * `test/bound-id-projection-parity.test.ts` imports the corpus copy and asserts
 * byte equality with this one over a vector set; it is the ratchet, and it
 * fails the moment the corpus moves.
 *
 * The codec is TOTAL over bytes rather than conditional on the current id
 * grammar — a conditional encoding is unambiguous only while the grammar holds
 * still, and this grammar has already moved once (the `anon:` tenant prefix).
 */

/** RFC 3986 unreserved MINUS `~`, which is reserved here as the escape marker. */
const PASSTHROUGH = /^[A-Za-z0-9._-]$/;

/**
 * Encode a bound id into exactly one path segment. Identity on already-safe
 * input, so calling it on an unbound id is harmless — but see `MUST apply
 * exactly once` below: it is NOT idempotent on input that contains `~`.
 */
export function projectBoundId(id: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(id)) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && PASSTHROUGH.test(ch) ? ch : `~${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Thrown for a `~` that does not introduce two hex digits, or a non-UTF-8 decode. */
export class BoundIdProjectionError extends Error {}

/**
 * Decode one path segment back to the bound id.
 *
 * Throws on a `~` that does not introduce two hex digits — the wire rule is
 * `400 validation_error` (RFC 0184 §A.1), and a decoder that silently passed a
 * lone `~` through would make the codec non-injective in exactly the direction
 * that matters: a DOUBLE-projected segment would then resolve, and a host that
 * projects twice would strand its own links without ever failing.
 */
export function unprojectBoundId(segment: string): string {
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] !== '~') continue;
    if (!/^[0-9A-Fa-f]{2}$/.test(segment.slice(i + 1, i + 3))) {
      throw new BoundIdProjectionError(`bound-id projection: '~' at index ${i} is not followed by two hex digits`);
    }
    i += 2;
  }
  const bytes: number[] = [];
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === '~') { bytes.push(parseInt(segment.slice(i + 1, i + 3), 16)); i += 3; }
    else { bytes.push(...new TextEncoder().encode(segment[i]!)); i += 1; }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new BoundIdProjectionError('bound-id projection: the decoded bytes are not valid UTF-8');
  }
}

/** True when a segment carries the projection's escape marker at all. */
export function looksProjected(segment: string): boolean {
  return segment.includes('~');
}
