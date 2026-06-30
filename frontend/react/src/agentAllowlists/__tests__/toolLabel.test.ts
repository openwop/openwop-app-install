/**
 * Admin-clarity follow-up — the tool-id humanizer for the Agent allowlist editor.
 * It turns a raw wire tool id (e.g. `core.openwop.integration.email-send`) into a
 * readable label while the raw id stays visible beneath it in the UI.
 */
import { describe, it, expect } from 'vitest';
import { toolLabel } from '../AgentAllowlistPanel.js';

describe('toolLabel — humanize a raw tool id', () => {
  it('title-cases the last meaningful segment', () => {
    expect(toolLabel('core.openwop.integration.email-send')).toBe('Email send');
    expect(toolLabel('core.openwop.integration.slack-message')).toBe('Slack message');
    expect(toolLabel('code-exec')).toBe('Code exec');
  });

  it('upper-cases known acronyms', () => {
    expect(toolLabel('core.openwop.http')).toBe('HTTP');
    expect(toolLabel('core.openwop.mcp')).toBe('MCP');
  });

  it('handles ids with no separators and odd shapes', () => {
    expect(toolLabel('openwop:ai.research')).toBe('Research');
    expect(toolLabel('lookup')).toBe('Lookup');
    expect(toolLabel('')).toBe('');
  });
});
