/**
 * ADR 0119 Phase 1 — pure transcript renderer (`features/chat-export/transcriptRenderer.ts`).
 *
 * What turns each case red (wave-24 probes): reversing message order or mislabelling a
 * role (title/header/sections); treating structured content as plain text (fenced JSON
 * card); a random component in the header (deterministic); dropping `authorSubject`
 * or mutating content in the JSON export (openwop-v1 shape).
 */
import { describe, it, expect } from 'vitest';
import { transcriptToMarkdown, transcriptToJson, EXPORT_FORMAT_VERSION } from '../src/features/chat-export/transcriptRenderer.js';
import type { ChatSessionRecord, ChatMessageRecord } from '../src/types.js';

const session: ChatSessionRecord = { sessionId: 'c1', tenantId: 't', title: 'Planning', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', messageCount: 3 };
const msgs: ChatMessageRecord[] = [
  { messageId: 'm0', sessionId: 'c1', role: 'user', content: 'What is the plan?', meta: null, authorSubject: 'user:alice', createdAt: '2026-01-01T00:00:01Z' },
  { messageId: 'm1', sessionId: 'c1', role: 'assistant', content: 'Here is the plan.', meta: null, authorSubject: null, createdAt: '2026-01-01T00:00:02Z' },
  { messageId: 'm2', sessionId: 'c1', role: 'assistant', content: JSON.stringify({ type: 'interrupt', kind: 'approval', label: 'Approve?' }), meta: null, authorSubject: null, createdAt: '2026-01-01T00:00:03Z' },
];

describe('transcriptToMarkdown', () => {
  it('renders a title, header, and per-message sections in order', () => {
    const md = transcriptToMarkdown(session, msgs);
    expect(md).toContain('# Planning');
    expect(md).toContain('## User — 2026-01-01T00:00:01Z');
    expect(md).toContain('What is the plan?');
    expect(md).toContain('## Assistant — 2026-01-01T00:00:02Z');
    // order preserved
    expect(md.indexOf('What is the plan?')).toBeLessThan(md.indexOf('Here is the plan.'));
  });

  it('renders a structured card as a fenced JSON block', () => {
    const md = transcriptToMarkdown(session, msgs);
    expect(md).toContain('```json');
    // the card content preserved verbatim, inside the fence
    expect(md).toContain(`\`\`\`json\n${msgs[2]!.content}\n\`\`\`\n`);
  });

  it('is deterministic', () => {
    expect(transcriptToMarkdown(session, msgs)).toEqual(transcriptToMarkdown(session, msgs));
  });
});

describe('transcriptToJson', () => {
  it('produces the openwop-v1 round-trippable shape with authorship preserved', () => {
    const j = transcriptToJson(session, msgs);
    expect(j.version).toBe(EXPORT_FORMAT_VERSION);
    expect(j.conversation).toEqual({ sessionId: 'c1', title: 'Planning', createdAt: '2026-01-01T00:00:00Z' });
    expect(j.messages).toHaveLength(3);
    expect(j.messages[0]!.authorSubject).toBe('user:alice');
    expect(j.messages[0]!.role).toBe('user');
    expect(j.messages[2]!.content).toBe(msgs[2]!.content); // card content kept verbatim
  });
});
