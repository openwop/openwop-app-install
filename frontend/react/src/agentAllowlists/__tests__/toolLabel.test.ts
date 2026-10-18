/**
 * Admin-clarity follow-up (AgentAllowlistPanel) — the tool-id humanizer for the
 * Agent allowlist editor. It turns a raw wire tool id (e.g.
 * `core.openwop.integration.email-send`) into a readable label while the raw id
 * stays visible beneath it in the UI.
 *
 * Sabotage-witnessed (wave 51): drop `:` or `.` from the segment split → case 3 red;
 * drop `_` from the word split or the first-word capital → case 1 red; drop an
 * acronym → case 2 red.
 */
import { describe, it, expect } from 'vitest';
import { toolLabel } from '../AgentAllowlistPanel.js';

describe('toolLabel — humanize a raw tool id', () => {
  it('title-cases the last meaningful segment, splitting words on - and _', () => {
    expect(toolLabel('core.openwop.integration.email-send')).toBe('Email send');
    expect(toolLabel('core.openwop.integration.slack-message')).toBe('Slack message');
    expect(toolLabel('core.openwop.send_email')).toBe('Send email');
    expect(toolLabel('code-exec')).toBe('Code exec');
  });

  it('upper-cases known acronyms, in any word position', () => {
    expect(toolLabel('core.openwop.http')).toBe('HTTP');
    expect(toolLabel('core.openwop.mcp')).toBe('MCP');
    expect(toolLabel('core.openwop.http-request')).toBe('HTTP request');
  });

  it('handles ids with no separators and odd shapes', () => {
    // The colon is the LAST separator here, so only the `:` split yields "Research".
    expect(toolLabel('openwop:research')).toBe('Research');
    expect(toolLabel('openwop:ai.research')).toBe('Research');
    expect(toolLabel('lookup')).toBe('Lookup');
    expect(toolLabel('')).toBe('');
  });
});
