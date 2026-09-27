/**
 * ADR 0661 phase 3 — default seams for the SHARED reads.
 *
 * WHY THIS EXISTS, and why it is not 37 separate patches. Grouping the phase-1
 * census by ENDPOINT rather than by file showed the allowlist is not 88
 * independent problems:
 *
 *     37 files   access/effective          <- ONE module-cached read
 *      9 files   .well-known/openwop
 *      6 files   reviews
 *
 * `getEffectiveAccess` alone accounted for 37 of 85 remaining entries. None of
 * those tests mock it, or mention it; it arrives through whatever component the
 * page under test happens to render. Fixing that per-file would have been ~37
 * near-identical edits for one cause — a local patch of a shared problem, which
 * is the shape this repo already treats as a boundary defect.
 *
 * THE VALUE IS NOT A CHOICE. `useEffectiveAccess` is fail-closed:
 *
 *     inflight = getEffectiveAccess().catch(() => NONE)   // useEffectiveAccess.ts:29
 *
 * so every one of those 37 files already resolves `NONE` today — by way of a live
 * fetch that fails. Returning `NONE` here is therefore byte-identical to current
 * behaviour with the network call removed, NOT a new default imposed on them.
 * Any other value would be a silent behaviour change across 37 files.
 *
 * A TEST THAT CARES STILL WINS. Vitest resolves mocks per module graph, so a test
 * file's own `vi.mock('…/accessClient.js', …)` overrides this. VERIFIED, not
 * assumed: two probe fixtures, one asserting the seam applies from here and one
 * asserting a local mock beats it, both green before this file was written.
 * `accessControlHonesty`-style tests that assert on real access are unaffected.
 *
 * Mocked at the CLIENT, not the hook, so direct callers of `getEffectiveAccess`
 * are covered too.
 */
import { vi } from 'vitest';

vi.mock('../client/accessClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The exact value `useEffectiveAccess`'s `.catch(() => NONE)` produces today.
  getEffectiveAccess: async () => ({ roles: [], scopes: [], basis: 'none' }),
}));
