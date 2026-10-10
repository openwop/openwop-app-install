/**
 * ADR 0785 P4 — a Claude Code permission prompt reads as what it is, in BOTH
 * inboxes: never "Approve & run" (it starts no run), the verbs are Allow/Deny,
 * and deny takes a REASON because that reason is sent back to Claude Code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(here, '..', p), 'utf8');

describe('ADR 0785 P4 — the Claude Code permission card', () => {
  it('the full inbox keeps it OUT of the run catch-all and gives it the reasoned bar', () => {
    const inbox = read('ApprovalsInbox.tsx');
    expect(inbox).toMatch(/!isClaudeCodePermission\(a\)\) \?\? \[\];/);
    const block = inbox.slice(inbox.indexOf('claudeCode.length > 0'));
    expect(block).toContain('<ApprovalDecideBar');
    expect(block).toContain("approveLabel={t('approvalsClaudeCodeAllow')}");
  });

  it('the Needs-you inbox uses the reasoned bar with Allow/Deny for it', () => {
    const inbox = read('NeedsYouInbox.tsx');
    expect(inbox).toContain("isContentPublish(a) || isClaudeCodePermission(a) || isStrategyActivation(a) ? (");
    expect(inbox).toContain("approveLabel: t('approvalsClaudeCodeAllow')");
  });

  it('the copy exists in all four locales', () => {
    for (const loc of ['en', 'es', 'fr', 'pt-BR']) {
      const s = read(`i18n/${loc}.ts`);
      for (const k of ['approvalsClaudeCodeGroup', 'approvalsClaudeCodeAsk', 'approvalsClaudeCodeAllow', 'approvalsClaudeCodeDeny']) expect(s, `${loc}:${k}`).toContain(k);
    }
  });
});
