/**
 * Whitespace-tolerant reads for secret-bearing env vars.
 *
 * WHY THIS EXISTS. The documented way to seed a secret is a pipe:
 *
 *     openssl rand -hex 32 | gcloud secrets create openwop-admin-token --data-file=-
 *
 * `openssl` terminates its output with a newline, and `--data-file=-` stores the
 * bytes verbatim — so the secret is 65 bytes, not 64, and every consumer sees a
 * trailing `\n`. The same happens with `kubectl create secret --from-file`, a
 * heredoc, and most editors saving a one-line file.
 *
 * The failure is silent and expensive. `OPENWOP_BYOK_ENCRYPTION_KEY` is
 * validated `^[0-9a-f]{64}$`, so it rejects loudly and names itself. The admin
 * token is compared with a length check plus `timingSafeEqual`, so a stray
 * newline just makes every request 401 — with no log line connecting the refusal
 * to the secret's shape. MEASURED on a real first deploy: all three secrets
 * seeded that way carried the newline; only the validated one said so.
 *
 * Trimming is the right default: a secret whose value depends on surrounding
 * whitespace is indistinguishable from one that was stored wrong, and no
 * generator emits one deliberately. The warning fires once per variable so the
 * operator can fix the stored value rather than rely on this shim forever.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.secretEnv');
const warned = new Set<string>();

/**
 * Read `name` from the environment with surrounding whitespace removed.
 * Returns `undefined` when unset, and — unlike a bare `?.trim()` — logs once
 * when trimming actually changed the value, so the stored secret gets fixed.
 */
export function readSecretEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed !== raw && !warned.has(name)) {
    warned.add(name);
    log.warn('secret env var had surrounding whitespace; trimmed for this process', {
      envVar: name,
      storedBytes: Buffer.byteLength(raw, 'utf8'),
      trimmedBytes: Buffer.byteLength(trimmed, 'utf8'),
      hint:
        'Almost always a trailing newline from `openssl … | gcloud secrets create --data-file=-`. ' +
        "Re-store with `printf '%s' \"$VALUE\"` so the secret is exactly its own bytes.",
    });
  }
  return trimmed;
}

/** Test seam: forget which variables have already been warned about. */
export function resetSecretEnvWarnings(): void {
  warned.clear();
}
