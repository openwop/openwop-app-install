/**
 * Flat-string secret-redaction primitive.
 *
 * `stripSecretsFromPersisted` (in `ephemeralRunSecrets.ts`) handles
 * structured payloads — it walks objects and arrays, replacing values
 * that match the BYOK ephemeral-secret reference shape (`__secret:*`).
 * It does NOT scan free-text strings for accidentally-pasted API key
 * material.
 *
 * This module adds the complementary scrubber for **flat strings** —
 * the kind that flow into notification messages, HITL approval
 * comments ("Visible in audit trail" free-text), workflow names, and
 * any other user-typed text that gets persisted in the event log.
 *
 * Conservative regex set — covers the high-frequency leak shapes seen
 * in upstream provider 401/403 responses + accidental user paste:
 *   - `sk-*`     — OpenAI + Anthropic
 *   - `xai-*`    — xAI
 *   - `Bearer *` — generic OAuth-style bearer tokens
 *   - 32+ char hex — anthropic + miniMax sometimes echo the rejected
 *                    key as a hex digest in error payloads
 *
 * Intentionally NOT exhaustive: this is defense-in-depth, not a
 * substitute for the executor's `stripSecretsFromPersisted` at every
 * structured-payload write site. Combine both at every persistence
 * boundary.
 *
 * Behavior on non-string inputs is undefined — callers MUST guard
 * `typeof v === 'string'` themselves. The helper assumes string input
 * to stay zero-overhead in the common case.
 */

export function sanitizeFreeText(s: string): string {
  return s
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/\bxai-[A-Za-z0-9_-]{16,}/g, 'xai-***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/g, 'Bearer ***')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '***');
}

/**
 * Recursively walk a payload and apply `sanitizeFreeText` to every
 * string leaf. Used to harden the executor's resume-time event-log
 * write so a HITL `comment` field carrying a pasted key gets scrubbed
 * before it lands in the `node.completed` event payload.
 *
 * Signature is `unknown → unknown` — callers know the shape they're
 * passing and re-narrow at the use site. A generic `<T>(value: T): T`
 * version would require `as unknown as T` escapes on every return
 * branch (string-replace, map, fresh object) which the project's
 * code-review skill bans across production code. Keeping the
 * signature honest at the price of one narrowing per call site is
 * the right trade.
 *
 * Preserves shape: arrays stay arrays, objects keep their keys, numbers
 * + booleans + nulls pass through unchanged. Cycles aren't handled —
 * call sites pass JSON-shaped payloads, not arbitrary graph values.
 */
export function sanitizeFreeTextDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeFreeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeFreeTextDeep(v));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeFreeTextDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * RFC 0012 §D — SR-1 carry-forward redaction for compaction-derived
 * content. When many short-lived MemoryEntry rows collapse into one
 * distilled entry, source-side leak signatures MUST be re-substituted with
 * the canonical `[REDACTED:<id>]` placeholder — never echoed verbatim, never
 * silently stripped (stripping loses audit signal). This converts the two
 * non-canonical source forms seen in practice plus the standard flat-string
 * key shapes:
 *   - `[BYOK:<id>]`        → `[REDACTED:byok]`        (BYOK ephemeral ref echo)
 *   - `<REDACTED:<id>>`    → `[REDACTED:<id>]`        (upstream non-canonical marker)
 *   - `sk-*` / `xai-*` / `Bearer *` / 32+hex via `sanitizeFreeText`.
 *
 * @see SECURITY/invariants.yaml `memory-compaction-sr-1-carry-forward`
 */
export function redactForCompaction(content: string): string {
  const remarked = content
    .replace(/\[BYOK:[^\]]*\]/g, '[REDACTED:byok]')
    .replace(/<REDACTED:([^>]*)>/g, (_m, id: string) => `[REDACTED:${id.length > 0 ? id : 'source'}]`);
  return sanitizeFreeText(remarked);
}

/**
 * SR-1 minimum secret length. Values shorter than this do NOT redact.
 *
 * `agent-memory.md` §SR-1 reference-impl notes: *"8-character minimum-length
 * floor — values shorter than 8 chars don't redact (gitleaks / TruffleHog
 * convention)."* The floor is not cosmetic: SR-1 redaction is SUBSTRING
 * replacement, so without it a 2-character secret would shred every unrelated
 * occurrence of those characters out of the persisted content.
 */
export const SR1_MIN_SECRET_LENGTH = 8;

/**
 * SR-1 (`agent-memory.md` §SR-1, normative) — redact BYOK-resolved plaintext out
 * of content that is about to be PERSISTED as a memory entry.
 *
 * > **SR-1.** When a memory write would persist content containing a value the
 * > run's BYOK vault resolved during the run, the persisted entry MUST carry
 * > `[REDACTED:<secretId>]` in place of the plaintext.
 *
 * `secrets` is the run's resolved keyring — `credentialRef → plaintext`, i.e.
 * exactly the shape `byok/ephemeralRunSecrets.ts#getRunSecrets` returns. That
 * module IS this host's per-run registry (the spec's `MemorySecretRegistry`:
 * *"in-process map keyed by `runId`"*); there is deliberately no second one.
 *
 * All three reference-impl rules from the spec are implemented literally, and
 * each is load-bearing:
 *
 *  - **Substring, not regex** (`split`/`join`) — a secret containing regex
 *    metacharacters can neither trigger ReDoS nor partially match.
 *  - **Descending value length** — a longer secret that CONTAINS a shorter one
 *    must redact whole; processing the short one first would leave a mangled
 *    tail of the long one in the persisted content.
 *  - **8-char floor** (`SR1_MIN_SECRET_LENGTH`) — see above.
 *
 * Idempotent: content already carrying `[REDACTED:…]` markers is unaffected,
 * because a marker cannot contain the plaintext it replaced.
 *
 * SCOPE (spec §SR-1): SR-1 binds to BYOK-resolved **non-platform** plaintext.
 * Platform-scope env-var fallbacks and host-internal service-account
 * credentials never enter the per-run registry, so they never reach this
 * function — the scope boundary is enforced by what gets registered, not here.
 *
 * @see spec/v1/agent-memory.md §"SR-1 — Secret-Redaction Invariant (normative)"
 */
export function redactRunSecretsForMemory(content: string, secrets: Readonly<Record<string, string>>): string {
  // Sort by DESCENDING plaintext length so a longer secret containing a shorter
  // one is substituted first and redacts whole.
  const canaries = Object.entries(secrets)
    .filter(([, value]) => typeof value === 'string' && value.length >= SR1_MIN_SECRET_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  let out = content;
  for (const [secretId, value] of canaries) {
    if (!out.includes(value)) continue;
    out = out.split(value).join(`[REDACTED:${secretId}]`);
  }
  return out;
}

/**
 * Local type guard — narrows `unknown` to `Record<string, unknown>`.
 *
 * Without this, the recursive walk above needs an `as Record<string,
 * unknown>` at the `Object.entries` call to get a typed iteration —
 * which the project's code-review skill bans. The guard's predicate
 * `v is Record<string, unknown>` flows the type through naturally.
 */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
