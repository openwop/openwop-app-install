/**
 * ADR 1040 D4 — a focus is authorized at BIND (the chat-session route's acting
 * user) and again on every TOOL CALL (the run's stamped `actingUserId`). Both
 * must be the same spelling of the same person, or a bound focus silently
 * reads nothing (or, worse, a check passes for a different id). Both sites now
 * call ONE helper, `callerSubject` (host/requestSubject.ts); this pins that,
 * and pins the helper's spelling for a session user and a bearer lane.
 *
 * Red when: either site goes back to its own inline expression, or the helper
 * changes which of `req.userId` / `principal.principalId` wins.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { callerSubject } from '../src/host/requestSubject.js';

const src = (p: string): string => readFileSync(join(process.cwd(), 'src', p), 'utf8');

describe('ADR 1040 D4 — bind and tool-call identity are one spelling', () => {
  it('the focus route and the run actor stamp both use the shared helper', () => {
    const chat = src('routes/chatSessions.ts');
    expect(chat).toMatch(/import \{ callerSubject as actingSubjectOf \} from '\.\.\/host\/requestSubject\.js';/);
    expect(chat).toMatch(/function actingUserOf\(req: Request\): string \| undefined \{[^}]*return actingSubjectOf\(req\);\s*\}/);
    const runs = src('routes/runs.ts');
    expect(runs).toMatch(/const actingUserId = actingSubjectOf\(req\) \?\? principal\.principalId;/);
    expect(runs).not.toMatch(/const actingUserId = req\.userId \?\?/);
  });

  it('a session user resolves to the durable user id; a bearer lane to its principal', () => {
    const session = { userId: 'u-durable', principal: { principalId: 'oidc:abc' } } as unknown as Request;
    expect(callerSubject(session)).toBe('u-durable');
    const bearer = { principal: { principalId: 'bearer:abcd1234' } } as unknown as Request;
    expect(callerSubject(bearer)).toBe('bearer:abcd1234');
  });
});
