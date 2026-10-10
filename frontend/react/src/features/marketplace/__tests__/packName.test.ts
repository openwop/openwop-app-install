/**
 * Human display name for a pack id (display only — the dotted id stays canonical;
 * ADR 0763 for the `vendor.openwop-app.<feature>.*` host scope it also strips).
 *
 * Sabotage-witnessed (/grade-tests wave 10): dropping the vendor-scope skip, the
 * acronym upper-casing, the kind-token drop, its `i < parts.length - 1` bound, or
 * the `|| packName` fallback each red the case named for it.
 */
import { describe, it, expect } from 'vitest';
import { prettyPackName } from '../packName';

describe('prettyPackName', () => {
  it('strips the namespace scaffolding and title-cases the rest', () => {
    expect(prettyPackName('core.openwop.agent-examples')).toBe('Agent Examples');
    expect(prettyPackName('core.openwop.agents')).toBe('Agents');
    expect(prettyPackName('feature.crm.nodes')).toBe('CRM Nodes');
    expect(prettyPackName('vendor.openwop-app.commerce.agents')).toBe('Commerce Agents');
  });

  it('uppercases known acronyms', () => {
    expect(prettyPackName('core.openwop.a2a')).toBe('A2A');
    expect(prettyPackName('feature.cdp.nodes')).toBe('CDP Nodes');
    expect(prettyPackName('vendor.openwop-app.ucp.agents')).toBe('UCP Agents');
  });

  it('drops a leading kind token when a specific name follows', () => {
    expect(prettyPackName('core.openwop.agents.code-reviewer')).toBe('Code Reviewer');
    expect(prettyPackName('core.openwop.nodes.web-search')).toBe('Web Search');
  });

  it('keeps a bare kind token when it is the whole name', () => {
    expect(prettyPackName('core.openwop.nodes')).toBe('Nodes');
  });

  it('title-cases a single-segment id', () => {
    expect(prettyPackName('solo')).toBe('Solo');
  });

  it('falls back to the raw id when no word survives', () => {
    expect(prettyPackName('-')).toBe('-');
    expect(prettyPackName('core.openwop.-')).toBe('core.openwop.-');
  });
});
