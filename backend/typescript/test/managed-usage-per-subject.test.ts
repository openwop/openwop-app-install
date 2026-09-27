/**
 * ADR 0693 — the managed free tier must not pool one allowance across a shared
 * workspace.
 *
 * WHAT THIS ASSERTS, and why it is not "the composer returns a string". The
 * defect ADR 0684 introduced is that two DIFFERENT people charging the same
 * shared tenant draw down one number. So the load-bearing assertion is that two
 * subjects in one workspace land in DIFFERENT buckets, and that one subject is
 * stable across calls — a composer that returned a fresh value per call would
 * satisfy "they differ" while metering nothing.
 *
 * The fallback cases matter just as much: a personal tenant must be BYTE
 * IDENTICAL to its old behaviour (no new rows, no new DSAR surface), and an
 * absent subject must charge the tenant, because the public chat widget is
 * anonymous by design and a design that required a subject would break it.
 */
import { describe, it, expect } from 'vitest';
import {
  managedUsageBucket,
  managedUsageBucketsForSubject,
  isReservedUsageBucket,
  GLOBAL_USAGE_BUCKET,
} from '../src/providers/managedUsageScope.js';

const WS = 'host-kicktodo';          // a declared default workspace (multi-principal)
const WS2 = 'ws:11111111-2222-3333-4444-555555555555';
const A = 'user:aaaaaaaaaaaaaaaa';
const B = 'user:bbbbbbbbbbbbbbbb';

describe('ADR 0693 — a shared workspace does not pool one allowance', () => {
  it('two subjects in ONE workspace get DIFFERENT buckets', () => {
    const a = managedUsageBucket(WS, A);
    const b = managedUsageBucket(WS, B);
    expect(a).not.toBe(b);
    // and neither is the workspace itself — that is the pooled bucket
    expect(a).not.toBe(WS);
    expect(b).not.toBe(WS);
  });

  it('one subject is STABLE across calls — otherwise nothing is metered', () => {
    // A composer returning a fresh value each time would pass the test above
    // and meter nothing at all. This is the assertion that forbids it.
    expect(managedUsageBucket(WS, A)).toBe(managedUsageBucket(WS, A));
  });

  it('the SAME subject in two workspaces is charged separately', () => {
    // Per-workspace allowances: a participant in two programmes is not punished
    // in one for activity in the other.
    expect(managedUsageBucket(WS, A)).not.toBe(managedUsageBucket(WS2, A));
  });

  it('the subject is NOT recoverable from the bucket (ADR 0693 section 4)', () => {
    // These rows become subject-linked personal data. A bucket that embedded the
    // raw subject would be a log of who asked what, when.
    const bucket = managedUsageBucket(WS, A);
    expect(bucket).not.toContain(A);
    expect(bucket).not.toContain('aaaaaaaaaaaaaaaa');
  });
});

describe('ADR 0693 — the cases that must NOT change', () => {
  it('a personal tenant charges itself, byte-identical to before', () => {
    for (const t of ['user:deadbeef', 'anon:sid-123', 'default']) {
      expect(managedUsageBucket(t, 'user:someone')).toBe(t);
      expect(managedUsageBucket(t)).toBe(t);
    }
  });

  it('a shared workspace with NO subject charges the tenant — the widget path', () => {
    // chat-widget/publicGateway is anonymous by design. Falling back to the
    // tenant is both correct and fail-safe: the worst case is today's behaviour.
    expect(managedUsageBucket(WS)).toBe(WS);
    expect(managedUsageBucket(WS, undefined)).toBe(WS);
    expect(managedUsageBucket(WS, '')).toBe(WS);
  });

  it('no real tenant shape can collide with the reserved namespace', () => {
    for (const t of ['user:x', 'anon:x', 'ws:x', 'host-kicktodo', 'host-site', 'default']) {
      expect(isReservedUsageBucket(t), `${t} must not read as reserved`).toBe(false);
    }
    expect(isReservedUsageBucket(GLOBAL_USAGE_BUCKET)).toBe(true);
    expect(isReservedUsageBucket(managedUsageBucket(WS, A))).toBe(true);
  });
});

describe('ADR 0693 section 4 — the erasure hook can name what it removes', () => {
  it('re-derives a subject buckets without scanning the collection', () => {
    const buckets = managedUsageBucketsForSubject(A, [WS, WS2, 'user:personal', 'anon:sid']);
    // one per MULTI-principal tenant; personal tenants contribute nothing
    // because they were never given a per-subject row to erase.
    expect(buckets).toHaveLength(2);
    expect(buckets).toContain(managedUsageBucket(WS, A));
    expect(buckets).toContain(managedUsageBucket(WS2, A));
    expect(buckets.every(isReservedUsageBucket)).toBe(true);
  });

  it('erasing subject A names none of subject B buckets', () => {
    const a = managedUsageBucketsForSubject(A, [WS, WS2]);
    const b = managedUsageBucketsForSubject(B, [WS, WS2]);
    expect(a.some((x) => b.includes(x))).toBe(false);
  });
});
