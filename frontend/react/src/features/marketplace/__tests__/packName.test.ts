import { describe, it, expect } from 'vitest';
import { prettyPackName } from '../packName';

describe('prettyPackName', () => {
  it('strips the namespace scaffolding and title-cases the rest', () => {
    expect(prettyPackName('core.openwop.agent-examples')).toBe('Agent Examples');
    expect(prettyPackName('core.openwop.agents')).toBe('Agents');
    expect(prettyPackName('feature.crm.nodes')).toBe('CRM Nodes');
    expect(prettyPackName('feature.commerce.agents')).toBe('Commerce Agents');
  });

  it('uppercases known acronyms', () => {
    expect(prettyPackName('core.openwop.a2a')).toBe('A2A');
    expect(prettyPackName('feature.cdp.nodes')).toBe('CDP Nodes');
    expect(prettyPackName('feature.ucp.agents')).toBe('UCP Agents');
  });

  it('drops a leading kind token when a specific name follows', () => {
    expect(prettyPackName('core.openwop.agents.code-reviewer')).toBe('Code Reviewer');
    expect(prettyPackName('core.openwop.nodes.web-search')).toBe('Web Search');
  });

  it('keeps a bare kind token when it is the whole name', () => {
    expect(prettyPackName('core.openwop.nodes')).toBe('Nodes');
  });

  it('falls back to the raw id for a nameless input', () => {
    expect(prettyPackName('solo')).toBe('Solo');
    expect(prettyPackName('')).toBe('');
  });
});
