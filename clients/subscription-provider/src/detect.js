// ADR 0182 — read-only detection of a logged-in vendor coding-agent CLI.
//
// This is the client-side mirror of the backend's file-only detector
// (backend/typescript/src/aiProviders/subscriptionCliDetect.ts). Unlike the
// backend, the shim runs ON the user's machine, so it MAY also consult the CLI
// via a status subprocess where the credential is not in a file (macOS
// Keychain) — but the pure file-check below is the default, side-effect-free
// path, and is what the unit tests cover. Never throws; reads no token
// material — presence only.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function codexAuthPath() {
  const base = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(base, 'auth.json');
}

function readJsonObject(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

function codexLoginDetected() {
  const data = readJsonObject(codexAuthPath());
  if (!data) return false;
  if (nonEmpty(data.OPENAI_API_KEY) || nonEmpty(data.personal_access_token)) return true;
  const t = data.tokens;
  return !!t && typeof t === 'object' && (nonEmpty(t.access_token) || nonEmpty(t.refresh_token));
}

/** The RFC 0121 provider ids this shim can serve, mapped to their CLI. */
export const SUPPORTED_HARNESSES = {
  openai: { harness: 'codex', wire: 'openai-chat' },
};

/** Read-only, never-throws: is a usable local login present for `provider`? */
export function subscriptionLoginDetected(provider) {
  switch (provider) {
    case 'openai':
      return codexLoginDetected();
    default:
      return false;
  }
}
