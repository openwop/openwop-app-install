/**
 * Per-run secret context with strip-on-persist.
 *
 * Holds resolved secret values in-memory only — keyed by runId — for
 * the duration of run execution. The storage adapter MUST call
 * `stripSecretsFromPersisted()` before any RunRecord write so secret
 * material never reaches the database.
 *
 * Tested invariant: after `setRunSecrets(runId, {...})` →
 * `stripSecretsFromPersisted(rec)` → the resulting object contains no
 * secret values, only `credentialRef` placeholders.
 */

const ephemeralByRun = new Map<string, Record<string, string>>();

export function setRunSecrets(runId: string, secrets: Record<string, string>): void {
  ephemeralByRun.set(runId, { ...secrets });
}

/**
 * MERGE one freshly-resolved secret into the run's registry (H49).
 *
 * Deliberately distinct from `setRunSecrets`, which REPLACES the whole map —
 * the executor's pre-dispatch seeding (`executor.ts` `setRunSecrets(run.runId,
 * …)`) relies on replace semantics, so reusing it here would silently wipe every
 * declared `credentialRef` the moment a node resolved a secret of its own.
 *
 * WHY THIS EXISTS. The registry was populated at exactly ONE site — the
 * executor, from the run's DECLARED `credentialRefs` / node `requires`. A node
 * that resolves a secret mid-run through `byok/secretResolver.ts` (which
 * `conformance.secret.echo` in `bootstrap/nodes.ts` has always done) left that
 * plaintext invisible to the registry, and therefore invisible to BOTH
 * consumers that exist to contain it:
 *
 *  1. `stripSecretsFromPersisted` — the storage/event-log scrubber. An
 *     undeclared secret was never scrubbed from persisted run records. That
 *     hole predates H49 and is the primary motivation.
 *  2. SR-1 memory-write redaction (`writeMemoryEntryRedacted`) — added in H49,
 *     which reads the same registry.
 *
 * Registering is therefore a containment WIDENING, never a leak: it can only
 * cause more material to be scrubbed. The one real hazard of a wider registry is
 * over-eager SUBSTRING redaction shredding legitimate content, and that is
 * bounded at the redaction site by the spec's 8-character floor
 * (`SR1_MIN_SECRET_LENGTH` in `textRedaction.ts`) rather than here — this
 * function stays a faithful record of what the run actually resolved.
 *
 * Values are process-memory only and die with the run via `clearRunSecrets`,
 * exactly as the seeded ones do. No-ops on an empty ref or an empty value so a
 * failed resolution can never register a sentinel that matches everything.
 */
export function registerRunSecret(runId: string, credentialRef: string, value: string): void {
  if (runId.length === 0 || credentialRef.length === 0 || value.length === 0) return;
  const current = ephemeralByRun.get(runId);
  if (current) current[credentialRef] = value;
  else ephemeralByRun.set(runId, { [credentialRef]: value });
}

export function getRunSecrets(runId: string): Record<string, string> {
  return ephemeralByRun.get(runId) ?? {};
}

export function clearRunSecrets(runId: string): void {
  ephemeralByRun.delete(runId);
}

/**
 * Build a Proxy view over a secrets map that allows direct key
 * lookup (`secrets[ref]`) but throws when code attempts to ENUMERATE
 * the map (`Object.keys`, `Object.entries`, `JSON.stringify`,
 * spread, `for…in`, etc.).
 *
 * Used by the executor to hand pack-loaded node code a non-iterable
 * view of `ctx.secrets` — packs that need to authenticate against a
 * provider can look up a known ref by name, but can't exfiltrate the
 * whole keyring through an `outputs` field. The host-owned adapter
 * (`aiProvidersHost.ts`) receives the RAW map so its convention-
 * based lookup still works.
 *
 * TRUST BOUNDARY (verified 2026-07-03, deferred-work review): the previously
 * hypothesized `Reflect.ownKeys` / `JSON.stringify` bypasses do NOT work —
 * both route through the throwing `ownKeys`/`getOwnPropertyDescriptor` traps
 * (pinned by `test/ephemeral-secrets-view.test.ts`). The Proxy's real job is
 * preventing ACCIDENTAL enumeration/serialization leaks (a pack spreading
 * ctx.secrets into `outputs`, a debug JSON.stringify). It is NOT — and cannot
 * be — a defense against genuinely malicious pack code: in-process JS has
 * `process.env`, `node:fs`, and patchable globals, so no secrets-view design
 * changes that calculus. The actual security boundary for pack code is the
 * SUPPLY CHAIN — packs install through the Ed25519-signed registry pipeline
 * (signature + SRI verification), so arbitrary-malicious-pack-code means a
 * compromised signing key, not a Proxy bypass. Genuinely UNTRUSTED code (user
 * code-exec) already runs in the CPython-WASI sandbox (host/wasiSandbox.ts,
 * ADR 0146) — isolation where the threat is real. Per-node worker/wasm
 * isolation (RFC 0008) for signed pack code is deliberately NOT built: the
 * cost (bridging the whole async ctx surface across a worker boundary) buys
 * nothing against the actual threat model. Revisit ONLY if unsigned
 * third-party packs ever load at runtime.
 */
export function nonEnumerableSecretsView(secrets: Record<string, string>): Record<string, string> {
  return new Proxy(secrets, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      return target[prop];
    },
    has(target, prop) {
      return typeof prop === 'string' && prop in target;
    },
    ownKeys() {
      throw new Error('secrets_view_not_enumerable: ctx.secrets is non-enumerable in pack code; look up known refs by name (e.g., secrets["anthropic"]).');
    },
    getOwnPropertyDescriptor() {
      throw new Error('secrets_view_not_enumerable: ctx.secrets is non-enumerable in pack code; look up known refs by name (e.g., secrets["anthropic"]).');
    },
  }) as Record<string, string>;
}

/**
 * Returns a deep-copy of `payload` with any string value matching a
 * known secret replaced by `"<<redacted:${credentialRef}>>"`. Walks
 * nested objects + arrays.
 *
 * Called by the storage adapter immediately before persistence and by
 * the event-log adapter immediately before append.
 */
/**
 * Vendor-pattern detector for credential-shaped strings the host
 * SHOULD scrub from event payloads even without an explicit BYOK
 * registration. Per `capabilities.md §"Secrets" + NFR-7`: arbitrary
 * credential-shaped inputs MUST NOT leak verbatim into observable
 * surfaces (event log, OTel spans, debug bundle, etc.).
 *
 * Patterns: prefix + 20+ allowed chars (covers OpenAI `sk-`,
 * Anthropic `sk-ant-`, OpenAI project keys `sk-proj-`, generic
 * Bearer tokens, GitHub `ghp_`/`gho_`). Conservative — these prefixes
 * rarely false-positive against normal text. Plus the conformance
 * suite's `CANARY-openwop-CONFORMANCE-NEVER-SECRET` marker for
 * explicit-canary test fixtures.
 *
 * Returns the redaction marker for matching substrings.
 */
// Negative lookbehind/lookahead boundaries instead of `\b` because the
// token classes include `_` and `-`, which `\b` treats inconsistently
// (`_` is a word char; `-` isn't). A `_`/`-` adjacent to a credential
// shape would skip detection via `\b`. The lookarounds anchor to
// alphanumerics + underscore explicitly, so a token followed by `_xyz`
// (snake_case context) still matches.
const CREDENTIAL_SHAPE_RE = /(?<![A-Za-z0-9_])(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,})(?![A-Za-z0-9])|CANARY-openwop-CONFORMANCE-NEVER-SECRET[A-Za-z0-9_-]*/g;

function scrubCredentialShapes(s: string): string {
  return s.replace(CREDENTIAL_SHAPE_RE, '<<redacted:credential-shape>>');
}

export function stripSecretsFromPersisted<T>(payload: T): T {
  const allSecrets = new Map<string, string>();
  for (const [_runId, perRun] of ephemeralByRun) {
    for (const [ref, val] of Object.entries(perRun)) {
      if (val) allSecrets.set(val, ref);
    }
  }

  function walk(value: unknown): unknown {
    if (typeof value === 'string') {
      // Tier 1: known BYOK-resolved secrets get a labeled redaction
      // (preserves credentialRef → marker mapping for audit trails).
      const ref = allSecrets.get(value);
      if (ref) return `<<redacted:${ref}>>`;
      // Tier 2: credential-shaped strings AND conformance canaries
      // get a generic shape-based scrub. Defense-in-depth against
      // canaries the BYOK layer never saw.
      return scrubCredentialShapes(value);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  }

  return walk(payload) as T;
}
