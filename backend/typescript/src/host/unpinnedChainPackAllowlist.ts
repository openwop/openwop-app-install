/**
 * ADR 0766 D2 — the SHRINKING ratchet for the RFC 0177 §E.1 register-time refusal.
 *
 * `spec/v2/core/workflow-chain-packs.md` §"Exact pins": a host MUST refuse to
 * register a chain whose node reference carries no version. On 2026-09-28 every
 * one of this repo's 63 chain packs did (624 of 624 references), so turning the
 * refusal on at once would have emptied the template gallery. The packs below
 * are the ones allowed to register UNPINNED while ADR 0766 P3 pins them.
 *
 * Rules, each enforced by `test/chain-pin-ratchet.test.ts`:
 *   - this list may only SHRINK. A new chain pack ships pinned or does not load;
 *   - an entry whose pack is now fully pinned is STALE and fails the test —
 *     delete it in the same PR that pins the pack;
 *   - the waiver covers "no version" ONLY. A RANGED reference, or one type pinned
 *     to two versions, is refused regardless of this list.
 *
 * ADR 0766 P3 (2026-09-28): EMPTY — every in-tree chain pack is pinned
 * (`npm run chains:pin`).
 *
 * > **Decision (grade-code C-13): the seam STAYS, empty.** This comment used to
 * > say the file "should then be deleted" and, three lines later, that it
 * > "stays" — both at once. It stays: the refusal also reaches OPERATOR-supplied
 * > chain packs, and a named, code-reviewed waiver is their only non-silent
 * > escape. The ratchet test keeps it empty for in-tree packs (ADR 0766, open
 * > question resolved).
 */
export const UNPINNED_CHAIN_PACK_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);


let testWaivers: ReadonlySet<string> | null = null;

/** Is `packName` allowed to register with unpinned node references? */
export function isUnpinnedChainPackWaived(packName: string): boolean {
  return UNPINNED_CHAIN_PACK_ALLOWLIST.has(packName) || (testWaivers?.has(packName) ?? false);
}

/**
 * Test seam — waive synthetic fixture packs whose subject is NOT pinning (schema
 * routing, root precedence, seeding). Since ADR 0766 the v1 schema route is
 * reachable only by an unpinned manifest (a pin claims the v2 tree), so a test of
 * that route has to waive its fixture. Pass null to clear. Never read in
 * production: nothing outside `test/` calls it.
 */
export function __setUnpinnedChainPackWaiversForTests(names: Iterable<string> | null): void {
  testWaivers = names ? new Set(names) : null;
}
