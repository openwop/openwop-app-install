/**
 * ADVB-4 / ADR 0588 D5 — the right-of-publicity acknowledgement is a record of a
 * HUMAN decision, so it must be attributable, never fabricated, and never
 * inherited.
 *
 * Three compounding defects this pins:
 *   (a) the demo seed shipped `livingPersonaAck: true` on the one `living`
 *       board (`titans`) over its FOUR advisors — an acknowledgement nobody
 *       made. (CORRECTED 2026-08-20: this said "eight named real individuals";
 *       `seed-data/advisorAgents.json` carries eight advisors across TWO boards
 *       and only `titans` had the ack. The names are also deliberate pastiches
 *       — Elon Trask, Geoff Bezor, Steve Jobes, Sam Oltman — modeled on real
 *       individuals, not the real names.);
 *   (b) adoption re-stamps `createdBy` while the ack re-assertion re-read the
 *       existing `true`, so RENAMING a seeded board made you owner-of-record of
 *       it. This is the unbackfillable half: once it happened, nothing
 *       distinguishes "the owner acknowledged" from "the seed did";
 *   (c) `disclaimerFor` returned `null` for `original`/`fictional` while
 *       `personaKind` is an unvalidated board-level dropdown, so a board of
 *       living-figure simulations set to "Original personas" shipped with no
 *       disclaimer AND no acknowledgement at all.
 *
 * The convene gate is asserted as a REFUSAL WITH AN EXIT (422 naming the field,
 * not a dead end): the test walks the exit the refusal prescribes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { createBoard, updateBoard, getBoard, disclaimerFor, assertBoardConvenable } from '../src/features/advisory-board/service.js';
import type { PersonaKind } from '../src/features/advisory-board/types.js';

const T = 'tenant-ab-living-ack';
const ORG = 'org-1';
const SEED_ACTOR = 'demo:advisory-seed';
const HUMAN = 'user:pat';
let n = 0;

beforeEach(async () => { initHostExtPersistence(await openStorage('memory://')); });

async function advisor(): Promise<string> {
  const entry = await createRosterEntry({ tenantId: T, persona: `Ada ${n++}`, agentRef: { kind: 'host' } as never });
  return entry.rosterId;
}

describe('ADVB-4 — the living-persona acknowledgement', () => {
  it('every persona kind yields a disclaimer — none returns null', () => {
    const kinds: PersonaKind[] = ['historical', 'fictional', 'original', 'living'];
    for (const k of kinds) {
      expect(disclaimerFor(k), `personaKind "${k}" must carry a disclaimer`).toBeTruthy();
    }
    // …and the real-person kinds still say "not the real individuals", so the
    // totality fix cannot be satisfied by weakening every message to one line.
    expect(disclaimerFor('living')).toContain('not the real individuals');
    expect(disclaimerFor('historical')).toContain('not the real individuals');
    expect(disclaimerFor('original')).not.toContain('not the real individuals');
  });

  it('an acknowledgement is ATTRIBUTED to whoever made it', async () => {
    const board = await createBoard(T, ORG, HUMAN, {
      name: `Titans ${n}`, advisors: [await advisor()], personaKind: 'living', livingPersonaAck: true,
    });
    expect(board.livingPersonaAck).toBe(true);
    expect(board.livingPersonaAckBy).toBe(HUMAN);
    expect(board.livingPersonaAckAt).toBeTruthy();
  });

  it('a seeded living board is created UNACKNOWLEDGED and cannot convene', async () => {
    const board = await createBoard(T, ORG, SEED_ACTOR, {
      name: `Seeded ${n}`, advisors: [await advisor()], personaKind: 'living', visibility: 'shared',
    }, { allowUnacknowledgedLiving: true });
    expect(board.livingPersonaAck, 'the seed must not acknowledge on a human behalf').toBeUndefined();
    expect(board.livingPersonaAckBy).toBeUndefined();
    expect(() => assertBoardConvenable(board)).toThrow(/acknowledge/i);
  });

  it('the escape hatch is SEED-ONLY — a request-shaped create still fails closed', async () => {
    // The anti-rot arm for the escape hatch: if `allowUnacknowledgedLiving` ever
    // becomes the default, or leaks onto a request path, this reddens.
    await expect(createBoard(T, ORG, HUMAN, {
      name: `Unacked ${n}`, advisors: [await advisor()], personaKind: 'living',
    })).rejects.toMatchObject({ httpStatus: 422, details: { field: 'livingPersonaAck' } });
  });

  it('ADOPTION does not inherit the ack — and the refusal has a one-click exit', async () => {
    const seeded = await createBoard(T, ORG, SEED_ACTOR, {
      name: `Adoptable ${n}`, advisors: [await advisor()], personaKind: 'living', visibility: 'shared',
    }, { allowUnacknowledgedLiving: true });

    // The exact defect shape: a RENAME, nothing else. It must not silently make
    // this user owner-of-record of an acknowledgement they were never shown.
    await expect(updateBoard(T, HUMAN, seeded.boardId, { name: 'War Council' }))
      .rejects.toMatchObject({ httpStatus: 422, details: { field: 'livingPersonaAck' } });

    // The exit the refusal prescribes: tick the box the edit dialog renders.
    const adopted = await updateBoard(T, HUMAN, seeded.boardId, { name: 'War Council', livingPersonaAck: true });
    expect(adopted.name).toBe('War Council');
    expect(adopted.createdBy).toBe(HUMAN);
    expect(adopted.livingPersonaAckBy, 'the ack must name the human who made it').toBe(HUMAN);
    expect(() => assertBoardConvenable(adopted)).not.toThrow();
  });

  it('an ALREADY-acknowledged seeded board still re-asks on adoption', async () => {
    // Covers the rows that already exist in production: the seed fabricated the
    // ack before this change, so an adoption today inherits a `true` nobody made.
    // Dropping it on adoption is what makes those rows recoverable.
    const seeded = await createBoard(T, ORG, SEED_ACTOR, {
      name: `Prefabricated ${n}`, advisors: [await advisor()], personaKind: 'living', livingPersonaAck: true, visibility: 'shared',
    });
    expect(seeded.livingPersonaAckBy).toBe(SEED_ACTOR); // visibly synthetic
    await expect(updateBoard(T, HUMAN, seeded.boardId, { name: 'Mine now' }))
      .rejects.toMatchObject({ httpStatus: 422, details: { field: 'livingPersonaAck' } });
  });

  it('a non-adopting owner edit leaves an existing ack and its attribution alone', async () => {
    const board = await createBoard(T, ORG, HUMAN, {
      name: `Owned ${n}`, advisors: [await advisor()], personaKind: 'living', livingPersonaAck: true,
    });
    const edited = await updateBoard(T, HUMAN, board.boardId, { name: 'Renamed' });
    expect(edited.livingPersonaAck).toBe(true);
    expect(edited.livingPersonaAckBy).toBe(HUMAN);
    expect(edited.livingPersonaAckAt).toBe(board.livingPersonaAckAt);
  });
});

describe('WF-BOA-6 — the advertised participant cap describes the BOARD lane', () => {
  it('rejects a 9-seat council (8 advisors + a chair who is not one of them)', async () => {
    const eight = [];
    for (let i = 0; i < 8; i += 1) eight.push(await advisor());
    const outsider = await advisor();
    // The exact shape `discovery.ts` advertised 8 for and the board lane seated 9:
    // `LIMITS.advisors` capped the advisors alone and the moderator was validated
    // independently, so `agentRefs` was built with NINE members.
    await expect(createBoard(T, ORG, HUMAN, {
      name: `Nine ${n}`, advisors: eight, moderatorRosterId: outsider, personaKind: 'historical',
    })).rejects.toMatchObject({ httpStatus: 400, details: { seats: 9, max: 8 } });

    // …while a chair drawn FROM the cohort is 8 seats and is accepted — the fix
    // must not be "reject any moderator", which would pass the arm above while
    // removing the feature.
    const ok = await createBoard(T, ORG, HUMAN, {
      name: `Eight ${n}`, advisors: eight, moderatorRosterId: eight[0], personaKind: 'historical',
    });
    expect(ok.moderatorRosterId).toBe(eight[0]);
  });
});

describe('ADVB-4 — UN-fabricating the acks already in the store', () => {
  it('clears a SEED-OWNED fabricated ack, and never touches an adopted or human one', async () => {
    const { clearFabricatedLivingAcks } = await import('../src/features/advisory-board/service.js');

    // (a) the production shape: seeded, still seed-owned, ack fabricated.
    const seeded = await createBoard(T, ORG, SEED_ACTOR, {
      name: `Fabricated ${n}`, advisors: [await advisor()], personaKind: 'living',
      livingPersonaAck: true, visibility: 'shared',
    });
    // (b) a HUMAN's own acknowledgement on their own board — must survive.
    const human = await createBoard(T, ORG, HUMAN, {
      name: `Genuine ${n}`, advisors: [await advisor()], personaKind: 'living',
      livingPersonaAck: true, visibility: 'shared',
    });
    // (c) a non-living seeded board — outside the scope entirely.
    const historical = await createBoard(T, ORG, SEED_ACTOR, {
      name: `Historical ${n}`, advisors: [await advisor()], personaKind: 'historical', visibility: 'shared',
    });

    // (d) THE SHAPE THE SEED-OWNERSHIP GUARD EXISTS FOR: a board a human has
    // ADOPTED whose ack is unattributed (a pre-0588 row — adoption used to
    // inherit the seed's `true` silently). It must NOT be cleared: that ack may
    // be fiction, but nothing distinguishes it from a genuine one, and deleting
    // a possibly-genuine compliance record is the worse error. Adoption re-asks
    // instead. Constructed via the raw seam because ADR 0588 D5 makes this shape
    // unreachable through the API — which is exactly why the arm was vacuous
    // before it existed.
    const { __putBoardForTest } = await import('../src/features/advisory-board/service.js');
    const adopted = await createBoard(T, ORG, HUMAN, {
      name: `Adopted legacy ${n}`, advisors: [await advisor()], personaKind: 'living',
      livingPersonaAck: true, visibility: 'shared',
    });
    const legacyRow = { ...(await getBoard(T, HUMAN, adopted.boardId)) };
    delete legacyRow.livingPersonaAckBy;
    delete legacyRow.livingPersonaAckAt;
    await __putBoardForTest(legacyRow);

    // (e) the OTHER guard: a still-seed-owned board whose ack a HUMAN is on
    // record for. Unreachable in-tree today (adoption re-stamps `createdBy`, so
    // a human's ack always arrives with a human owner), which is precisely why
    // it needs constructing — an unwitnessed guard is indistinguishable from a
    // dead branch, and this one is the reason a future writer that acknowledges
    // WITHOUT adopting cannot be silently un-fabricated.
    const seedOwnedHumanAck = await createBoard(T, ORG, SEED_ACTOR, {
      name: `Seed-owned human ack ${n}`, advisors: [await advisor()], personaKind: 'living',
      livingPersonaAck: true, visibility: 'shared',
    });
    await __putBoardForTest({ ...(await getBoard(T, HUMAN, seedOwnedHumanAck.boardId)), livingPersonaAckBy: HUMAN });

    expect(await clearFabricatedLivingAcks(T)).toBe(1);

    expect((await getBoard(T, HUMAN, seedOwnedHumanAck.boardId)).livingPersonaAck,
      "a human's acknowledgement is never cleared, whoever owns the board").toBe(true);

    const adoptedAfter = await getBoard(T, HUMAN, adopted.boardId);
    expect(adoptedAfter.livingPersonaAck, 'an ADOPTED board is never un-fabricated — adoption re-asks').toBe(true);

    const after = await getBoard(T, HUMAN, seeded.boardId);
    expect(after.livingPersonaAck).toBeUndefined();
    expect(() => assertBoardConvenable(after)).toThrow(/acknowledge/i);

    const humanAfter = await getBoard(T, HUMAN, human.boardId);
    expect(humanAfter.livingPersonaAck, "a human's own acknowledgement must never be cleared").toBe(true);
    expect(humanAfter.livingPersonaAckBy).toBe(HUMAN);
    expect((await getBoard(T, HUMAN, historical.boardId)).personaKind).toBe('historical');

    // Idempotent: a second pass finds nothing left to un-fabricate.
    expect(await clearFabricatedLivingAcks(T)).toBe(0);
  });
});

describe('L5 — the row this migration actually meets in production', () => {
  it('clears a seed-owned ack with NO attribution at all (the pre-0588 shape)', async () => {
    // Neither guard ARM constructs this, and it is the ONLY shape that exists in
    // a demo tenant seeded before ADR 0588: `livingPersonaAckBy` did not exist
    // when the seeder wrote the ack, so the row is
    // `{ personaKind:'living', livingPersonaAck:true, createdBy:'demo:…' }` with
    // the attribution field ABSENT. It passes the second guard by SHORT-CIRCUIT
    // (`b.livingPersonaAckBy &&` is falsy), which is correct — and was untested,
    // so nothing would have caught a "fix" that required the field to be present.
    const { clearFabricatedLivingAcks, __putBoardForTest } = await import('../src/features/advisory-board/service.js');
    const seeded = await createBoard(T, ORG, SEED_ACTOR, {
      name: `Pre-0588 ${n}`, advisors: [await advisor()], personaKind: 'living',
      livingPersonaAck: true, visibility: 'shared',
    });
    const legacy = { ...(await getBoard(T, HUMAN, seeded.boardId)) };
    delete legacy.livingPersonaAckBy;   // the field did not exist yet
    delete legacy.livingPersonaAckAt;
    await __putBoardForTest(legacy);
    expect(legacy.livingPersonaAckBy).toBeUndefined();

    expect(await clearFabricatedLivingAcks(T)).toBe(1);
    const after = await getBoard(T, HUMAN, seeded.boardId);
    expect(after.livingPersonaAck, 'the production row must actually be un-fabricated').toBeUndefined();
    expect(() => assertBoardConvenable(after)).toThrow(/acknowledge/i);
  });
});
