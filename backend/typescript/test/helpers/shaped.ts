/**
 * TST-OAS-5 — a checked accessor for `unknown` surface and node returns.
 *
 * `FeatureSurface` methods and pack node delegates return `unknown`. Tests used to
 * retype those values with `JSON.parse(JSON.stringify(v))` behind a generic, which
 * is a cast in all but syntax: a renamed or dropped field still read as typed and
 * failed later, as `undefined`, far from the cause.
 *
 * `shaped` checks that the value is an object carrying every key the caller is
 * about to read, and names the missing one when it is not. The single `as T` below
 * is the only place the declared shape meets the value, and it is guarded.
 */
export function shaped<T extends object>(keys: ReadonlyArray<keyof T & string>, v: unknown): T {
  if (typeof v !== 'object' || v === null) {
    throw new Error(`shaped: expected an object with ${keys.join(', ')}; got ${v === null ? 'null' : typeof v}`);
  }
  const missing = keys.filter((k) => !(k in v));
  if (missing.length > 0) {
    throw new Error(`shaped: missing ${missing.join(', ')} (has ${Object.keys(v).join(', ') || 'no keys'})`);
  }
  return v as T;
}
