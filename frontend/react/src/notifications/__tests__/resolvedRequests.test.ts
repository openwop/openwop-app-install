/**
 * ADR 1114 (issue 5868) — a request whose step is over no longer needs action.
 * Sabotage witness: drop the `requestResolutionOf` check in `isActionNeeded`
 * and the second case fails.
 */
import { describe, expect, it } from 'vitest';
import { isActionNeeded } from '../types.js';
import { requestResolutionOf } from '../requestResolution.js';
import type { Notification } from '../types.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const request = (metadata?: Record<string, unknown>): Notification => ({
  notificationId: 'n', tenantId: 't', type: 'openwop-app.workflow.approval-needed', priority: 'high', status: 'read',
  title: 'Confirm the project setup', message: 'm', runId: 'r', interruptId: 'i', createdAt: '2026-11-13T00:00:00Z',
  ...(metadata ? { metadata } : {}),
} as Notification);

describe('ADR 1114 — resolved requests', () => {
  it('reads the stamped resolution, and treats anything else as open', () => {
    expect(requestResolutionOf(request({ resolution: { state: 'approved', at: 'x' } }))).toEqual({ state: 'approved', at: 'x' });
    expect(requestResolutionOf(request())).toBeUndefined();
    expect(requestResolutionOf(request({ resolution: { state: 'exploded', at: 'x' } }))).toBeUndefined();
    expect(requestResolutionOf(request({ resolution: 'approved' }))).toBeUndefined();
  });

  it('an open request needs action; a finished one does not', () => {
    expect(isActionNeeded(request())).toBe(true);
    expect(isActionNeeded(request({ resolution: { state: 'run-ended', at: 'x' } }))).toBe(false);
  });

  it('every locale names each ending and the archive action', () => {
    const keys = ['archiveResolved', 'endApproved', 'endRejected', 'endChanges', 'endTimedOut', 'endAnswered', 'endRunEnded', 'cardRunLink'] as const;
    for (const m of [en, es, fr, ptBR] as Array<Record<string, string>>) {
      for (const k of keys) expect(m[k], k).toBeTruthy();
      expect(m.cardRunLink).not.toContain('{{id}}');
    }
  });
});
