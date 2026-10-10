/**
 * ADR 0785 P1 (code review #3) — the pairing command must work against the
 * deploy that prints it. app.openwop.dev serves its API under `/api`; a bare
 * `--host <origin>` sent the companion to a path Firebase never routes to the
 * backend, and it reported "not enabled" — a false diagnosis.
 */
import { describe, it, expect } from 'vitest';
import { pairCommand } from '../ClaudeCodeDevicesPage.js';

describe('pairCommand', () => {
  it('same-origin path API (Firebase /api) ⇒ --api-base /api', () => {
    expect(pairCommand('https://app.openwop.dev', '/api')).toBe('npx @openwop/agent-host pair --host https://app.openwop.dev --api-base /api');
  });
  it('API at the app origin root ⇒ no --api-base', () => {
    expect(pairCommand('https://app.example.com', 'https://app.example.com')).toBe('npx @openwop/agent-host pair --host https://app.example.com');
    expect(pairCommand('https://app.example.com', 'https://app.example.com/')).toBe('npx @openwop/agent-host pair --host https://app.example.com');
  });
  it('API on another origin ⇒ an absolute --api-base, while --host stays the app (the approval link opens there)', () => {
    expect(pairCommand('https://app.example.com', 'https://api.example.com/base/')).toBe('npx @openwop/agent-host pair --host https://app.example.com --api-base https://api.example.com/base');
  });
});

import { shortDeviceId } from '../ClaudeCodeDevicesPage.js';
describe('shortDeviceId', () => {
  it('shortens a device id enough to tell same-named pairings apart', () => {
    expect(shortDeviceId('ccd_XRqyAV_D6S1M')).toBe('ccd_XRqy…');
    expect(shortDeviceId('ccd_1HuOiN_nbFM1')).not.toBe(shortDeviceId('ccd_XRqyAV_D6S1M'));
    expect(shortDeviceId('ccd_abc')).toBe('ccd_abc');
  });
});
