/**
 * RFC 0176 §A/§B/§C — `POST /conformance/seams/sample/event-log/seed`
 * (`seedEra2EventLog`), served at its v1 address and reached at the v2 one
 * through the ADR 0634 alias.
 *
 * WHAT IT IS FOR. Era 2 means "a log written before this host's v2 cut": v1
 * `type` spellings and an event log whose era is `2`. NOTE this host stamps era
 * `3` on any run inserted WITHOUT an era, so the fixture sets `2` explicitly —
 * the absent-⇒-`2` rule in `persistence.md` governs readers meeting an old run,
 * not writers creating one. This host cannot PRODUCE such a log any more — every run it
 * writes today is era 3 — so four scenarios that check the read projection
 * (`v2-v1-events-translated`, `v2-unmapped-type-refused`, `v2-fork-a-v1-run`,
 * `v2-pinned-run-disposition`) have no reachable fixture without a seam that
 * plants one. The suite drives it through `lib/era2-seed.ts`.
 *
 * THE MUST THIS HAS TO HONOUR, and the one place it is easy to break: the rows
 * are persisted VERBATIM — the given `type` strings and the given `sequence`
 * space — and NOT translated at write time. The read projection is what those
 * scenarios witness, so a host that normalised on the way in would make all four
 * pass while testing nothing.
 *
 * WHY IT REFUSES A NON-CONTIGUOUS SEQUENCE SPACE INSTEAD OF ACCEPTING IT.
 * `Storage.appendEventsBatch` ASSIGNS sequences (`max + 1`, array order). On a
 * freshly created run whose log is empty that is byte-identical to persisting a
 * contiguous 0-based space verbatim — so for that shape this seam is honest by
 * construction, not by promise. For any other shape it is not, and the two
 * available moves were to renumber silently or to refuse. Renumbering would make
 * the request SUCCEED while storing something other than what was asked for,
 * which is precisely the failure `persistence.md` forbids and precisely the
 * "success carrying wrong data" class this codebase keeps finding. So it refuses
 * with a 400 that names the limitation. If a scenario ever needs a gap, the fix
 * is a storage path that accepts explicit sequences — not a looser seam.
 */
import { randomUUID } from 'node:crypto';

import type { Express, Request, Response, NextFunction } from 'express';

import type { Storage } from '../storage/storage.js';
import type { RunRecord, EventRecord } from '../types.js';
import { toWireRunId } from '../host/v2Ids.js';
import { sendError } from '../middleware/errorEnvelope.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.eventLogSeedSeam');

export const SEED_PATH = '/v1/host/sample/event-log/seed';

/**
 * Seeded runs belong to the CALLER'S tenant, not a fixture tenant.
 *
 * This was `SEED_TENANT = 'sample-era2-tenant'`, on the reasoning that a private
 * tenant "can never collide with or leak into a real one". Isolation was real;
 * the run was also UNREADABLE by the caller that had just created it. Every
 * scenario that seeds a log and then reads it back — `v2-unmapped-type-refused`,
 * `v2-v1-events-translated` — got `403 id_tenant_mismatch` from the tenant check,
 * which runs from the ID ALONE before any lookup. The suite reported a wire gap
 * ("a read the host cannot translate MUST fail 500; got 403") that was really a
 * seam addressing its fixture to a tenant nobody could read.
 *
 * `fireEffectSeam` had the identical defect and was corrected first; this site was
 * not swept at the same time, which is the recurring shape — a class fixed at one
 * instance. The seam is mounted only under `OPENWOP_TEST_SEAM_ENABLED`, so the
 * caller's tenant is the right scope: the fixture is as isolated as the caller is.
 */
function callerTenant(req: Request): string {
  return (req as Request & { tenantId?: string }).tenantId ?? 'default';
}

const STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);

interface SeedEvent {
  type: string;
  sequence: number;
  payload: Record<string, unknown>;
  timestamp?: string;
  causationId?: string;
}

/** Closed-world validation of the request body against `api/seams-v2.yaml`.
 *  Returns an error message, or null when the body is valid. */
export function validateSeedBody(body: unknown): { error: string } | { events: SeedEvent[]; status: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (b['eventLogSchemaVersion'] !== 2) return { error: 'eventLogSchemaVersion must be the literal 2' };
  const status = b['status'];
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    return { error: `status must be one of ${[...STATUSES].join(', ')}` };
  }
  const events = b['events'];
  if (!Array.isArray(events) || events.length === 0) return { error: 'events must be a non-empty array' };

  const out: SeedEvent[] = [];
  for (const [i, raw] of events.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: `events[${i}] must be an object` };
    const e = raw as Record<string, unknown>;
    if (typeof e['type'] !== 'string' || e['type'].length === 0) return { error: `events[${i}].type must be a non-empty string` };
    if (typeof e['sequence'] !== 'number' || !Number.isInteger(e['sequence']) || e['sequence'] < 0) {
      return { error: `events[${i}].sequence must be an integer >= 0` };
    }
    if (typeof e['payload'] !== 'object' || e['payload'] === null || Array.isArray(e['payload'])) {
      return { error: `events[${i}].payload must be an object` };
    }
    out.push({
      type: e['type'],
      sequence: e['sequence'],
      payload: e['payload'] as Record<string, unknown>,
      ...(typeof e['timestamp'] === 'string' ? { timestamp: e['timestamp'] } : {}),
      ...(typeof e['causationId'] === 'string' ? { causationId: e['causationId'] } : {}),
    });
  }

  // The verbatim constraint, checked rather than assumed. See the docblock.
  const expected = out.map((_, i) => i);
  const actual = out.map((e) => e.sequence);
  if (actual.length !== expected.length || actual.some((s, i) => s !== expected[i])) {
    return {
      error:
        `sequence space must be contiguous from 0 (got [${actual.join(', ')}]). This seam persists the given ` +
        `sequences VERBATIM and refuses rather than renumber: the append path assigns max+1 in array order, ` +
        `which is byte-identical to the given space only when it is 0..n-1.`,
    };
  }
  return { events: out, status };
}

/**
 * The `workflowId` carried by the seeded `run.started`, if the caller named one.
 * Read from the event payload rather than a request field: the seeded log is the
 * caller's statement of what the run WAS, and `run.started.payload.workflowId`
 * is where `events.md` puts it.
 */
function seededWorkflowId(events: readonly { type?: string; payload?: unknown }[]): string | undefined {
  const started = events.find((e) => e.type === 'run.started');
  const payload = (started?.payload ?? {}) as Record<string, unknown>;
  const id = payload['workflowId'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function registerEventLogSeedSeam(app: Express, deps: { storage: Storage }): void {
  const { storage } = deps;

  app.post(SEED_PATH, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = callerTenant(req);
      // Test-only surface: it plants runs. A 404 when the flag is off, matching
      // every other sample seam — and `seamsFloorServed()` reads the same flag,
      // so the advert cannot claim a seam space this branch is refusing.
      if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
        sendError(res, 404, 'not_found', 'The conformance seam surface is not enabled on this host.');
        return;
      }

      const parsed = validateSeedBody(req.body);
      if ('error' in parsed) {
        sendError(res, 400, 'validation_error', parsed.error);
        return;
      }

      const runId = randomUUID();
      const now = new Date().toISOString();
      const run: RunRecord = {
        runId,
        // The workflowId the CALLER seeded, when it named one.
        //
        // This was the literal `'sample.era2-seed'`, which is not in any catalog —
        // so `POST /runs/{id}:fork` on a seeded parent answered
        // `404 not_found "Workflow not found in this catalog."` and the corpus
        // read that as a host refusing to fork a pre-cut run (RFC 0176 §A.5).
        // The fork resolves the parent's definition in order to re-execute; a run
        // pointing at a workflow that does not exist cannot be forked by anyone.
        //
        // The corpus seeds `run.started` with `payload.workflowId` naming a real
        // fixture (`conformance-noop`), so honouring it makes the seeded parent a
        // forkable run instead of a dangling reference. The literal remains the
        // fallback for a caller that names nothing — those runs are still readable,
        // just not forkable, which is the honest outcome for a log with no
        // workflow behind it.
        workflowId: seededWorkflowId(parsed.events) ?? 'sample.era2-seed',
        tenantId: tenant,
        status: parsed.status as RunRecord['status'],
        inputs: {},
        metadata: { seededBy: 'conformance-seam', era: 2 },
        configurable: {},
        createdAt: now,
        updatedAt: now,
        // THE ERA IS SET EXPLICITLY, and the comment that stood here said the
        // opposite. It read: "NO era stamp — persistence.md says absent ⇒ 2".
        // That rule is about a READER meeting a run written before the stamp
        // existed. It is not true of a WRITE on this host: `eventEraAdapter`'s
        // `insertRun` stamps era 3 on every run whose record does not already
        // carry one ("a v2 host MUST stamp 3 on EVERY run it creates"), so
        // omitting the field plants an era-THREE run. A test asserting the
        // stored era caught it; nothing else would have, because the read path
        // maps an era-3 log back to v1 spellings for a v1 reader, so the events
        // still came back looking correct.
        //
        // Era 2 is also what makes the log's vocabulary v1: the adapter's writer
        // rule fixes the stored spelling to the RUN's era. So this one field is
        // what makes the fixture era-2 in both senses the scenarios care about.
        eventLogSchemaVersion: 2,
      };
      await storage.insertRun(run);

      const inputs: Omit<EventRecord, 'sequence'>[] = parsed.events.map((e) => ({
        eventId: randomUUID(),
        runId,
        type: e.type,
        payload: e.payload,
        timestamp: e.timestamp ?? now,
        ...(e.causationId ? { causationId: e.causationId } : {}),
      }));
      const written = await storage.appendEventsBatch(inputs);

      // The verbatim claim, re-checked against what storage actually did rather
      // than trusted. The validation above proves the REQUEST was 0..n-1; this
      // proves the WRITE agreed. Cheap, and it is the only place the promise in
      // this seam's name is actually observable.
      const drift = written.filter((w: EventRecord, i: number) => w.sequence !== parsed.events[i]?.sequence);
      if (drift.length > 0) {
        log.error('era2_seed_sequence_drift', {
          runId,
          expected: parsed.events.map((e) => e.sequence).join(','),
          actual: written.map((w: EventRecord) => w.sequence).join(','),
        });
        sendError(res, 500, 'internal_error', 'the seeded log did not persist the requested sequence space');
        return;
      }

      res.status(201).json({ runId: toWireRunId(runId, tenant) });
    } catch (err) {
      next(err);
    }
  });
}
