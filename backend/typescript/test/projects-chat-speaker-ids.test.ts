/**
 * `COLWF-1` — a project room must seat the ids the speaker rule compares.
 *
 * BORN RED, and the failure is a total outage of the project convene lane.
 *
 * A project seats its agent members' refs VERBATIM (`projects/routes.ts` —
 * `members.filter(agent:).map(m => m.ref)`), and a member ref is `agent:<rosterId>` by contract
 * (`projectsService` validates it with `getRosterEntry` and its own error message says so).
 * But `participantRosterOf` parses that suffix as an AGENT ID, and the RFC 0101 speaker rule
 * compares it against `answeringId`, which is the registry projection `agentRef.agentId`.
 *
 * The two id spaces are structurally different: a rosterId is `host:<slug(persona)>`; an
 * `agentRef.agentId` is the chat-callable projection (`user.<tenant>.<slug>`, or a pack id).
 * They never coincide for a real roster member, so EVERY agent turn in a project room 422s.
 *
 * THE BOARD LANE DOES THE MAPPING AND SAYS WHY: `boardCohortAgentRefs` resolves each rosterId
 * and seats `agent:${entry.agentRef.agentId}`, with a comment stating it is done "so RFC 0101
 * roster enforcement matches dispatched ids". The project lane never got that.
 *
 * This is the ADR 0608 D6 closure INVERTED: before it, the guard was a silent no-op; after it,
 * the guard fires correctly — against the one producer that seats the wrong id space.
 *
 * Why no existing witness caught it: every project fixture asserts the seat SET and never a
 * turn, and every RFC 0101 fixture seats `agent:a1` and dispatches `a1` — a world where the
 * seated suffix and the answering id are the same string, which a real project room cannot
 * produce.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { participantRosterOf, isParticipant } from '../src/host/multiPartyConversation.js';
import type { ConversationMeta } from '../src/host/conversationStore.js';

const TENANT = 'default';
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** A roster entry as `rosterService` mints it: the id and its chat-callable projection differ. */
const ROSTER_ID = 'host:ada-lovelace';
const AGENT_REF_ID = 'user.default.ada-lovelace';

const projectMeta = (agentRefSuffixes: string[]): ConversationMeta => ({
  conversationId: 'c-proj', tenantId: TENANT, createdAt: '', updatedAt: '',
  type: 'group',
  ownerSubject: { kind: 'project', id: 'project-abc123' },
  participants: [
    { subjectRef: 'user:owner', role: 'owner', addedAt: '' },
    ...agentRefSuffixes.map((s) => ({ subjectRef: `agent:${s}`, role: 'member', addedAt: '' })),
  ],
} as unknown as ConversationMeta);

describe('COLWF-1 — the project room seats ids the speaker rule can match', () => {
  it('anti-vacuity: the two id spaces really are different', () => {
    // If a rosterId ever equalled its agentRef projection, every leg below would pass for the
    // wrong reason — which is exactly how the existing RFC 0101 fixtures are blind to this.
    expect(ROSTER_ID).not.toBe(AGENT_REF_ID);
    expect(ROSTER_ID.startsWith('host:')).toBe(true);
  });

  it('BORN RED — seating the ROSTER id rejects the agent that actually answers', () => {
    const roster = participantRosterOf(projectMeta([ROSTER_ID]));
    expect(roster, 'a project group room declares a roster').toBeTruthy();
    // `answeringId` is the registry projection — this is the id the 422 compares.
    expect(
      isParticipant(roster!, AGENT_REF_ID),
      'the answering agent must be recognised as a participant; seating the rosterId makes every project agent turn 422',
    ).toBe(false); // the DEFECT, pinned: see the structural leg below for the fix
  });

  it('STRUCTURAL — the project seat site maps the rosterId to its chat-callable projection', () => {
    // The predicate legs above pin the id-space contract. This pins the FIX at the only place
    // that can honour it: a predicate test alone would stay green against a seat site that
    // still writes the raw ref, which is exactly how this shipped.
    const routes = readFileSync(join(SRC, 'features', 'projects', 'routes.ts'), 'utf8');
    // Assert the PROPERTY, not one spelling of it: my first version pinned the exact push
    // expression and went red the moment the same code grew a `seatRef` local — a ratchet that
    // polices a spelling gets "fixed" by loosening it, which is how it stops protecting
    // anything.
    expect(routes, 'the seat site must resolve the roster entry').toMatch(/getRosterEntry\(tenantId, m\.ref\.slice/);
    expect(routes, 'and derive the seat from the registry projection').toMatch(/`agent:\$\{entry\.agentRef\.agentId\}`/);
    expect(
      routes.includes(".filter((m) => m.ref.startsWith('agent:')).map((m) => m.ref)"),
      'the verbatim-ref seat must not return',
    ).toBe(false);
  });

  it('seating the PROJECTION id is what the board lane does, and it matches', () => {
    // The positive control: the same meta shape with the mapped ref resolves correctly, so the
    // defect is the id space and not the roster derivation.
    const roster = participantRosterOf(projectMeta([AGENT_REF_ID]));
    expect(isParticipant(roster!, AGENT_REF_ID)).toBe(true);
  });

  it('a non-participant agent is still refused — the guard must keep working', () => {
    const roster = participantRosterOf(projectMeta([AGENT_REF_ID]));
    expect(isParticipant(roster!, 'user.default.someone-else')).toBe(false);
  });
});
