/**
 * Google Workspace connection pack (day-1 UX P10 / C3 — registry parity).
 * The pack exists for packs.openwop.dev + other hosts (the reference app's
 * builtin `google` provider already covers Workspace here — the pack uses
 * the distinct id `google-workspace` precisely so it never shadows it).
 * Pins: the example pack LOADS through the real RFC 0095 loader, lands its
 * provider id/category, and carries no secret material.
 *
 * TST-DEF-1 — red when the pack's provider id or category changes, a secret-
 * shaped key lands in it, or a scope group moves between the day-1 READ set and
 * the re-consent WRITE set (send/write must never be day-1 consent).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadConnectionPacks } from '../src/features/connections/connectionPackLoader.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/connection-packs');

describe('google-workspace connection pack', () => {
  it('loads through the RFC 0095 loader without errors', () => {
    const { installed, errors } = loadConnectionPacks({ roots: [EXAMPLES] });
    const row = installed.find((p) => p.pack === 'core.openwop.connections.google-workspace');
    expect(row?.providerId).toBe('google-workspace');
    expect(errors.filter((e) => String(e.pack ?? '').includes('google-workspace'))).toEqual([]);
  });

  it('carries no secret material and declares the write groups behind re-consent', () => {
    const raw = readFileSync(path.join(EXAMPLES, 'google-workspace/pack.json'), 'utf8');
    expect(raw).not.toMatch(/client_secret|clientSecret|api[_-]?key/i);
    const pack = JSON.parse(raw) as {
      provider: { id: string; category: string; auth: { scopes: { read: Array<{ key: string }>; write: Array<{ key: string }> } } };
    };
    expect(pack.provider.id).toBe('google-workspace');
    expect(pack.provider.category).toBe('email-calendar');
    // Read groups are the day-1 consent; send / calendar-write sit behind re-consent.
    expect(pack.provider.auth.scopes.read.map((g) => g.key)).toEqual(['drive.readonly', 'calendar.readonly', 'gmail.readonly']);
    expect(pack.provider.auth.scopes.write.map((g) => g.key)).toEqual(['gmail.send', 'calendar.events']);
  });
});
