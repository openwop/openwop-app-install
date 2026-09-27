/**
 * ADR 0552 P2 / RFC 0152 §D — the A2A 1.0 codec, as pure translation.
 *
 * The wire-level legs live in `a2a-1-0-server.test.ts`; this file pins the
 * translation itself, because three of the four things 1.0 changed are silent
 * failures rather than loud ones:
 *
 *   - a stored state with no 1.0 spelling renders `status.state: undefined`;
 *   - a decoder that discriminates `Part` by `kind` reads EVERY 1.0 part as
 *     unknown and drops it, producing an empty prompt rather than an error;
 *   - a peer's error body copied across leaks its `message`/`domain` into an
 *     OpenWOP envelope, which §D.7 forbids and no consumer would notice.
 *
 * Each assertion below is the negative form of one of those.
 */

import { describe, expect, it } from 'vitest';
import {
  A2A_10_ERROR,
  STORED_TASK_STATES,
  decodePart10,
  fromWireState10,
  messageText10,
  projectPeerError10,
  errorData10,
  projectTaskRecordToA2aTask10,
  taskStatusUpdateEvent10,
  toWireState10,
} from '../src/host/a2aCodec10.js';
import type { A2aTaskRecord } from '../src/host/a2aTaskStore.js';

const REC: A2aTaskRecord = {
  taskId: 'run_1',
  runId: 'run_1',
  tenantId: 't1',
  state: 'input-required',
  interruptKind: 'approval',
  contextId: 'ctx-9',
  updatedAt: '2026-08-16T00:00:00.000Z',
};

describe('RFC 0152 §D.4 — the stored↔1.0 state bijection', () => {
  it('is TOTAL over the stored vocabulary — every stored state has a 1.0 spelling', () => {
    for (const s of STORED_TASK_STATES) {
      expect(toWireState10(s), `stored state '${s}' renders no 1.0 spelling`).toMatch(/^TASK_STATE_[A-Z_]+$/);
    }
    // Vacuity guard: the loop above proves nothing if the vocabulary is empty.
    expect(STORED_TASK_STATES.length).toBe(8);
  });

  it('round-trips in both directions — one stored vocabulary, two wire spellings', () => {
    for (const s of STORED_TASK_STATES) {
      expect(fromWireState10(toWireState10(s)), `'${s}' does not survive a round trip`).toBe(s);
    }
  });

  it('refuses to coerce UNSPECIFIED or an unknown value to a state', () => {
    // §D.4 lists TASK_STATE_UNSPECIFIED as "never emitted" and gives it no
    // stored pre-image. Mapping it (or a typo) onto `working` would make "the
    // peer is still going" and "we could not read the peer's answer" the same
    // fact, which is the reading that hangs a poller forever.
    expect(fromWireState10('TASK_STATE_UNSPECIFIED')).toBeNull();
    expect(fromWireState10('TASK_STATE_NOT_A_STATE')).toBeNull();
    expect(fromWireState10('working')).toBeNull(); // the 0.3 spelling is not 1.0
  });
});

describe('RFC 0152 §D.3 — `Part` is a oneof, discriminated by member presence', () => {
  it('decodes each member without a `kind` field anywhere', () => {
    expect(decodePart10({ text: 'hello' })).toEqual({ member: 'text', text: 'hello' });
    expect(decodePart10({ url: 'https://x.test/a.png', mediaType: 'image/png' })).toEqual({
      member: 'url',
      url: 'https://x.test/a.png',
      mediaType: 'image/png',
    });
    expect(decodePart10({ raw: 'YWJj', mediaType: 'text/plain' })).toEqual({ member: 'raw', raw: 'YWJj', mediaType: 'text/plain' });
    expect(decodePart10({ data: { a: 1 } })).toEqual({ member: 'data', data: { a: 1 } });
    expect(decodePart10({ data: null })).toEqual({ member: 'data', data: null });
    expect(decodePart10({})).toEqual({ member: 'unknown' });
  });

  it('IGNORES a stray `kind` — 1.0 removed it, so it must not be read', () => {
    // A 0.3-shaped part that also carries text still decodes on `text`; a part
    // whose ONLY signal is `kind` decodes as unknown. If this ever inverts, the
    // decoder has grown a 0.3 fallback and 1.0 peers will be misread.
    expect(decodePart10({ kind: 'text', text: 'hi' })).toEqual({ member: 'text', text: 'hi' });
    expect(decodePart10({ kind: 'text' })).toEqual({ member: 'unknown' });
  });

  it('messageText10 reads ONLY text parts — a url is never fetched, raw is never inlined', () => {
    const text = messageText10({
      parts: [{ text: 'a' }, { url: 'https://evil.test/x' }, { raw: 'YWJj' }, { text: 'b' }],
    });
    expect(text).toBe('ab');
    expect(text).not.toContain('evil.test');
    expect(text).not.toContain('YWJj');
  });
});

describe('RFC 0152 §D.4/§D.5 — the 1.0 Task and status-update shapes', () => {
  it('projects a record with no `kind`, the 1.0 state, and the interrupt carrier', () => {
    const task = projectTaskRecordToA2aTask10(REC);
    expect(task.kind).toBeUndefined(); // 1.0 removed the discriminator
    expect(task.id).toBe('run_1');
    expect(task.contextId).toBe('ctx-9');
    expect((task.status as { state: string }).state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect((task.status as { timestamp: string }).timestamp).toBe(REC.updatedAt);
    expect(task.metadata).toEqual({ openwop: { interrupt: { kind: 'approval' } } });
    expect(task.artifacts).toEqual([]);
    expect(task.history).toEqual([]);
  });

  it('the status-update event carries NO `final` flag — terminality is the state', () => {
    const evt = taskStatusUpdateEvent10({ ...REC, state: 'completed', interruptKind: undefined });
    expect(evt.final).toBeUndefined();
    expect(evt.kind).toBeUndefined();
    expect((evt.status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
  });

  it('does not leak the interrupt carrier onto a non-interrupt state', () => {
    const task = projectTaskRecordToA2aTask10({ ...REC, state: 'completed' });
    expect(task.metadata).toBeUndefined();
  });
});

describe('RFC 0152 §D.7 — peer errors project through the envelope, details DROPPED', () => {
  it('maps each upstream reason to its canonical OpenWOP code', () => {
    const cases: Array<[string, string]> = [
      ['TASK_NOT_FOUND', 'not_found'],
      ['TASK_NOT_CANCELABLE', 'run_terminal'],
      ['PUSH_NOTIFICATION_NOT_SUPPORTED', 'capability_required'],
      ['UNSUPPORTED_OPERATION', 'capability_required'],
      ['CONTENT_TYPE_NOT_SUPPORTED', 'validation_error'],
      ['INVALID_AGENT_RESPONSE', 'validation_error'],
      ['EXTENDED_AGENT_CARD_NOT_CONFIGURED', 'not_found'],
      ['EXTENSION_SUPPORT_REQUIRED', 'validation_error'],
      ['VERSION_NOT_SUPPORTED', 'interop_version_unsupported'],
    ];
    for (const [reason, code] of cases) {
      expect(projectPeerError10({ data: { reason } }).code, `reason ${reason}`).toBe(code);
    }
  });

  it('falls back to the numeric code when the peer omits `data.reason`', () => {
    expect(projectPeerError10({ code: A2A_10_ERROR.TASK_NOT_FOUND.code }).code).toBe('not_found');
    expect(projectPeerError10({ code: A2A_10_ERROR.VERSION_NOT_SUPPORTED.code }).code).toBe('interop_version_unsupported');
  });

  it('DROPS the peer message, domain and every other detail — never redacts in place', () => {
    // RFC 0152 UQ4: "upstream error details are reduced to the closed `reason`
    // and, for version errors, `supportedVersions[]`; everything else is
    // dropped, not redacted-in-place." A projection that copied the body and
    // scrubbed it would need a filter that stays correct against every peer's
    // error format; this one reads three fields and cannot leak a fourth.
    const projected = projectPeerError10({
      code: -32001,
      message: 'Internal: postgres://user:hunter2@db/prod timed out at /srv/app/handler.ts:88',
      data: {
        reason: 'TASK_NOT_FOUND',
        domain: 'a2a-protocol.org',
        stack: 'Error: at Object.<anonymous>',
        internalTenant: 'acme-corp',
      },
    });
    expect(projected).toEqual({ code: 'not_found', reason: 'TASK_NOT_FOUND' });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('acme-corp');
    expect(serialized).not.toContain('a2a-protocol.org');
    expect(serialized).not.toContain('handler.ts');
  });

  it('lets ONLY supportedVersions[] across, and only on a version failure', () => {
    expect(
      projectPeerError10({ data: { reason: 'VERSION_NOT_SUPPORTED', supportedVersions: ['0.3'], hint: 'upgrade' } }),
    ).toEqual({ code: 'interop_version_unsupported', reason: 'VERSION_NOT_SUPPORTED', supportedVersions: ['0.3'] });
    // Same field on a DIFFERENT reason does not cross.
    expect(projectPeerError10({ data: { reason: 'TASK_NOT_FOUND', supportedVersions: ['0.3'] } })).toEqual({
      code: 'not_found',
      reason: 'TASK_NOT_FOUND',
    });
  });

  // ADR 0744 — the upstream A2A 1.0.1 §9.5 shape a2a-js 1.2.0 / a2a-python
  // 1.1.5 actually send: `data` is an `Any[]` carrying `google.rpc.ErrorInfo`.
  // Before this, the projection read `data.reason` off an ARRAY, found nothing,
  // and fell back to the numeric code — silently dropping `supportedVersions`.
  it('reads the reason and supportedVersions out of an upstream Any[] ErrorInfo', () => {
    const upstream = [
      { '@type': 'type.googleapis.com/google.rpc.DebugInfo', detail: 'Internal: postgres://u:hunter2@db' },
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'VERSION_NOT_SUPPORTED',
        domain: 'a2a-protocol.org',
        metadata: { supportedVersions: '1.0, 0.3', timestamp: '2026-09-23T00:00:00Z' },
      },
    ];
    const projected = projectPeerError10({ code: -32009, data: upstream });
    expect(projected).toEqual({
      code: 'interop_version_unsupported',
      reason: 'VERSION_NOT_SUPPORTED',
      supportedVersions: ['1.0', '0.3'],
    });
    // Nothing from any other Any, nor any other metadata key, crosses.
    expect(JSON.stringify(projected)).not.toContain('hunter2');
    expect(JSON.stringify(projected)).not.toContain('timestamp');
  });

  it('an Any[] with no ErrorInfo falls back to the numeric code, never a guess', () => {
    expect(projectPeerError10({ code: -32001, data: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest' }] })).toEqual({
      code: 'not_found',
      reason: 'TASK_NOT_FOUND',
    });
  });

  it('errorData10 emits the §9.5 Any[] this host puts on the wire', () => {
    expect(errorData10('TASK_NOT_FOUND')).toEqual([
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' },
    ]);
    // Round-trips through this host's own client projection.
    expect(projectPeerError10({ code: -32009, data: errorData10('VERSION_NOT_SUPPORTED', { supportedVersions: '1.0,0.3' }) }))
      .toEqual({ code: 'interop_version_unsupported', reason: 'VERSION_NOT_SUPPORTED', supportedVersions: ['1.0', '0.3'] });
  });

  it('does not invent a reason for an unrecognised token', () => {
    // A foreign string is not a fact this host can restate.
    const projected = projectPeerError10({ data: { reason: 'SOMETHING_ELSE' } });
    expect(projected.code).toBe('upstream_error');
    expect(projected.reason).toBeUndefined();
  });
});
