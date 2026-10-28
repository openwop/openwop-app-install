/**
 * The A2A message-claim key must be storable in Postgres: no 0x00 byte.
 * The raw `${tenant}\0${principal}\0${messageId}` key failed every A2A 1.0
 * SendMessage on a Postgres host (-32603 "invalid byte sequence for encoding
 * UTF8: 0x00", app.openwop.dev 2026-09-28); memory and SQLite hid it. Fixed in
 * #4219. The claim is the ADR 0552 P2 / RFC 0150 §A messageId idempotency key.
 *
 * Tracker TST-BG1-7. Red when (probe-witnessed, wave 58): `claimKeyFor`
 * returns the raw NUL-joined triple, or hashes the triple without separators
 * (so `a`+`bc` and `ab`+`c` collide).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { claimKeyFor, getA2aMessageClaim, setA2aMessageClaim } from '../src/host/a2aTaskStore.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('A2A message-claim key', () => {
  it('contains no NUL byte and is a fixed-length hex digest', () => {
    const k = claimKeyFor('tenant-a', 'principal-1', 'msg-1');
    expect(k).not.toContain('\u0000');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same triple', () => {
    expect(claimKeyFor('t', 'p', 'm')).toBe(claimKeyFor('t', 'p', 'm'));
  });

  it('keeps distinct triples distinct, including concatenation look-alikes', () => {
    expect(claimKeyFor('a', 'bc', 'm')).not.toBe(claimKeyFor('ab', 'c', 'm'));
    expect(claimKeyFor('t', 'p', 'm1')).not.toBe(claimKeyFor('t', 'p', 'm2'));
    expect(claimKeyFor('t1', 'p', 'm')).not.toBe(claimKeyFor('t2', 'p', 'm'));
  });

  it('round-trips a claim through the store', async () => {
    await setA2aMessageClaim('tenant-rt', 'principal-rt', 'msg-rt', 'task-123');
    expect(await getA2aMessageClaim('tenant-rt', 'principal-rt', 'msg-rt')).toBe('task-123');
    expect(await getA2aMessageClaim('tenant-rt', 'principal-rt', 'other')).toBeNull();
  });
});
